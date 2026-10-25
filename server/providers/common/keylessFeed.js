/**
 * Shared proxy kit for keyless (no paid or registered key) live layers.
 *
 * One factory call owns one layer route, `/api/v1/layers/<layerId>`, built
 * from independent subsources. Each subsource fetches its fixed upstream and
 * normalizes it to a GeoJSON FeatureCollection; the kit stamps the layer
 * contract onto every feature, validates the result, and keeps a per-subsource
 * TTL cache with stale-on-error, single-flight refresh and a failure backoff.
 * One failing subsource never blanks the others: the response is the union of
 * whatever is fresh or cached, with per-subsource status in `metadata`. Only
 * when every subsource has failed with nothing cached does the route answer a
 * sanitized 502. See docs/KEYLESS-FEEDS.md for the contract and checklist.
 * @module server/providers/common/keylessFeed
 */
import { gunzipSync } from 'node:zlib';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './http.js';
import { makeRateLimiter, clientKey } from './rate-limit.js';
import { validateKeylessLayerCollection } from '../../../src/layers/common/geojson.js';

/** Sent on every upstream request; some upstreams (api.weather.gov) require one. */
export const KEYLESS_FEED_USER_AGENT =
  'GodsEyeView/fork (+https://github.com/straplocked/gods-eye-view)';

/** Route prefix for keyless layers (product spec). */
export const KEYLESS_LAYER_ROUTE_PREFIX = '/api/v1/layers/';

const MIB = 1024 * 1024;
const CLIENT_ERROR_CODES = new Set([
  'invalid_payload',
  'upstream_status',
  'upstream_unavailable',
]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The same-origin route that serves one keyless layer. */
export function keylessLayerRoute(layerId) {
  return `${KEYLESS_LAYER_ROUTE_PREFIX}${layerId}`;
}

/**
 * An upstream failure with a fixed, client-safe code. Only `code` ever
 * reaches a response (metadata.sources[].error); messages stay server-side.
 */
export class KeylessFeedError extends Error {
  /**
   * @param {'invalid_payload'|'upstream_status'|'upstream_unavailable'} code
   * @param {string} [detail] Server-log detail; never sent to clients.
   */
  constructor(code, detail = code) {
    super(detail);
    this.name = 'KeylessFeedError';
    this.code = code;
  }
}

/** Longest upstream-requested wait honoured before asking again (6 h). */
export const MAX_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Parse a Retry-After header (delta-seconds or an HTTP date) into a wait in
 * milliseconds, capped at MAX_RETRY_AFTER_MS. Returns null when absent or
 * unreadable, so callers fall back to their own backoff.
 * @param {?string} value
 * @param {number} nowMs
 * @returns {?number}
 */
export function parseRetryAfterMs(value, nowMs) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let waitMs;
  if (/^\d+$/.test(text)) waitMs = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (!Number.isFinite(at)) return null;
    waitMs = at - nowMs;
  }
  return Math.min(Math.max(waitMs, 0), MAX_RETRY_AFTER_MS);
}

/** Throw from a normalizer when a payload is corrupt or not a collection. */
export function invalidPayload(detail = 'invalid_payload') {
  return new KeylessFeedError('invalid_payload', detail);
}

/** Map any thrown value to one of the fixed client-safe error codes. */
export function keylessErrorCode(error) {
  if (error?.code === 'RESPONSE_TOO_LARGE') return 'response_too_large';
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
    return 'timeout';
  if (error instanceof SyntaxError) return 'invalid_payload';
  // Portable normalizers (src/layers/*/records.js) cannot import this module,
  // so they mark corrupt payloads with the same plain `code`.
  if (CLIENT_ERROR_CODES.has(error?.code)) return error.code;
  return 'upstream_unavailable';
}

/**
 * Upstream helpers bound to one refresh: every request carries the kit's
 * User-Agent, the refresh's timeout signal and `redirect: 'error'`, and every
 * body read is byte-capped.
 * @param {{fetchImpl: Function, signal: AbortSignal, maxBytes: number, userAgent?: string, now?: () => number}} options
 */
export function createUpstreamClient({
  fetchImpl,
  signal,
  maxBytes,
  userAgent = KEYLESS_FEED_USER_AGENT,
  now = () => Date.now(),
}) {
  /** fetch() with the kit's headers, signal and redirect policy. */
  async function request(url, init = {}) {
    signal.throwIfAborted();
    return fetchImpl(url, {
      ...init,
      headers: { 'User-Agent': userAgent, ...(init.headers || {}) },
      signal,
      redirect: 'error',
    });
  }

  async function openOnce(url, { emptyStatuses = [], headers } = {}) {
    const response = await request(url, headers ? { headers } : {});
    if (emptyStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new KeylessFeedError(
        'upstream_status',
        `upstream HTTP ${response.status}`,
      );
      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = parseRetryAfterMs(
          response.headers?.get?.('retry-after'),
          now(),
        );
        if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
      }
      throw error;
    }
    return response;
  }

  /**
   * openOnce() asked again up to `retries` times (default 0) while the
   * upstream answers a non-2xx status; NWPS and Safecast answer 502/504
   * under load. Timeouts, aborts and body errors are never retried.
   */
  async function open(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await openOnce(url, options);
      } catch (error) {
        // An upstream that named a wait (429/503 + Retry-After) is not asked
        // again here; the subsource backoff honours the wait instead.
        if (
          error?.code !== 'upstream_status' ||
          error.retryAfterMs != null ||
          attempt >= (options.retries ?? 0)
        )
          throw error;
      }
    }
  }

  /**
   * GET and parse JSON under a byte cap. A status in `emptyStatuses` (an
   * upstream that answers "nothing current" with 204/404) returns null.
   * Every helper also takes `headers`, `maxBytes` and `retries` (see open()).
   */
  async function fetchJson(url, options = {}) {
    const response = await open(url, options);
    if (!response) return null;
    const text = await readResponseTextCapped(
      response,
      options.maxBytes ?? maxBytes,
      signal,
    );
    try {
      return JSON.parse(text);
    } catch {
      throw invalidPayload('upstream JSON did not parse');
    }
  }

  /**
   * GET text (CSV, XML, TXT) under a byte cap. `gzip: true` gunzips a `.gz`
   * body (not Content-Encoding, which fetch already decodes); `'auto'` does so
   * only when the body starts with the gzip magic bytes. The decoded size is
   * capped by `maxDecodedBytes` (default 8x the compressed cap).
   */
  async function fetchText(url, options = {}) {
    const response = await open(url, options);
    if (!response) return null;
    const cap = options.maxBytes ?? maxBytes;
    if (!options.gzip) return readResponseTextCapped(response, cap, signal);
    const bytes = await readResponseBytesCapped(response, cap, signal);
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!gzipped) {
      if (options.gzip === true) throw invalidPayload('body is not gzip');
      return new TextDecoder().decode(bytes);
    }
    try {
      return gunzipSync(bytes, {
        maxOutputLength: options.maxDecodedBytes ?? cap * 8,
      }).toString('utf8');
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE')
        throw Object.assign(new Error('decoded body too large'), {
          code: 'RESPONSE_TOO_LARGE',
        });
      throw invalidPayload('gzip body did not decode');
    }
  }

  /**
   * GET a binary body (a zip, an image) under a byte cap. A status in
   * `emptyStatuses` returns null; any other non-2xx throws `upstream_status`.
   * @returns {Promise<Uint8Array|null>}
   */
  async function fetchBytes(url, options = {}) {
    const response = await open(url, options);
    if (!response) return null;
    return readResponseBytesCapped(
      response,
      options.maxBytes ?? maxBytes,
      signal,
    );
  }

  return { fetch: request, fetchJson, fetchText, fetchBytes };
}

/**
 * Run `task` over `items` with at most `limit` in flight, results in item
 * order. The first rejection rejects the whole call and stops further items
 * from starting, so a subsource that needs every item fails as one; a task
 * that may skip an item catches its own errors.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

const RESERVED_SOURCE_KEYS = new Set([
  'id',
  'ok',
  'stale',
  'count',
  'fetchedAt',
  'truncated',
  'error',
]);

/**
 * Subsource-specific status for `metadata.sources[]` (e.g. NWS
 * `pendingZones`): only flat scalar values under non-reserved keys survive,
 * so a normalizer cannot smuggle a large or structured value into the body.
 */
function sourceDetails(details) {
  if (details === null || typeof details !== 'object' || Array.isArray(details))
    return {};
  const result = {};
  for (const [key, value] of Object.entries(details).slice(0, 8)) {
    if (
      RESERVED_SOURCE_KEYS.has(key) ||
      !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)
    )
      continue;
    if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 64)
    )
      result[key] = value;
  }
  return result;
}

function validateConfig({ name, layerId, subsources }) {
  if (typeof name !== 'string' || !name)
    throw new TypeError('Keyless feed needs a plugin name');
  if (typeof layerId !== 'string' || !SLUG.test(layerId))
    throw new TypeError('Keyless feed needs a slug layerId');
  if (!Array.isArray(subsources) || !subsources.length)
    throw new TypeError('Keyless feed needs at least one subsource');
  const ids = new Set();
  for (const subsource of subsources) {
    if (typeof subsource?.id !== 'string' || !SLUG.test(subsource.id))
      throw new TypeError('Keyless subsource ids must be slugs');
    if (ids.has(subsource.id))
      throw new TypeError(`Duplicate keyless subsource: ${subsource.id}`);
    ids.add(subsource.id);
    if (typeof subsource.fetchSnapshot !== 'function')
      throw new TypeError(
        `Keyless subsource ${subsource.id} needs fetchSnapshot`,
      );
  }
}

/**
 * Build the Vite plugin for one keyless layer.
 *
 * Each subsource is `{id, fetchSnapshot, ttlMs?, timeoutMs?, maxBytes?}`;
 * `fetchSnapshot({fetchImpl, fetchJson, fetchText, fetchBytes, signal, now})` resolves a
 * FeatureCollection whose features carry a non-empty string `id` unique within
 * that subsource, and throws (e.g. `invalidPayload()`) on a corrupt payload —
 * a thrown refresh is never cached, so it cannot become an empty snapshot.
 * The collection may also carry `details`, an object of flat scalars that the
 * kit copies into that subsource's `metadata.sources[]` entry (NWS reports
 * `pendingZones` this way); reserved keys and structured values are dropped.
 * A legitimately empty collection (nothing current) is cached like any other.
 *
 * The response is a FeatureCollection: feature ids become
 * `<subsource>:<id>`, `properties.layer`/`properties.source` are stamped, and
 * `properties.timestamp` defaults to null. The foreign member `metadata` is
 * `{layer, fetchedAt, stale, partial, sources: [{id, ok, stale, count,
 * fetchedAt, truncated, error?}]}` with ISO times. `GET <route>/status`
 * reports cache state without touching any upstream.
 *
 * @param {Object} options
 * @param {string} options.name - Vite plugin name.
 * @param {string} options.layerId - Layer id; the route is /api/v1/layers/<layerId>.
 * @param {Array<Object>} options.subsources - See above.
 * @param {number} [options.ttlMs=900000] - Default per-subsource cache TTL.
 * @param {number} [options.failureBackoffMs=60000] - Minimum wait before retrying a failed subsource.
 * @param {number} [options.timeoutMs=30000] - Default per-subsource refresh timeout.
 * @param {number} [options.maxBytes=16 MiB] - Default per-request body cap.
 * @param {number} [options.maxFeatures=10000] - Per-subsource feature cap (excess is dropped and reported as truncated).
 * @param {{windowMs: number, max: number, globalMax: number}} [options.rateLimit] - Per-client limiter.
 * @param {string} [options.errorCode] - 502 body code; default `<layer_id>_unavailable`.
 * @param {(features: Array<Object>) => Array<Object>} [options.combine] - Joins
 *   the features of the served subsources into the response features (the
 *   Volcanoes layer merges one volcano reported by two feeds into a single
 *   feature). It receives the stamped, prefixed features, must not change
 *   them, and returns features with unique string ids and the layer contract;
 *   the result is validated again and a failure answers the sanitized 502.
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @returns {{name: string, configureServer: Function, configurePreviewServer: Function}}
 */
export function createKeylessFeedProxy({
  name,
  layerId,
  subsources,
  ttlMs = 900_000,
  failureBackoffMs = 60_000,
  timeoutMs = 30_000,
  maxBytes = 16 * MIB,
  maxFeatures = 10_000,
  rateLimit = { windowMs: 60_000, max: 60, globalMax: 1200 },
  errorCode = `${String(layerId).replaceAll('-', '_')}_unavailable`,
  combine = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  userAgent = KEYLESS_FEED_USER_AGENT,
} = {}) {
  validateConfig({ name, layerId, subsources });
  if (combine !== null && typeof combine !== 'function')
    throw new TypeError('Keyless feed combine must be a function');
  const route = keylessLayerRoute(layerId);
  const allow = makeRateLimiter(rateLimit);
  /** @type {Map<string, {value: ?Object, savedAt: number, failedAt: ?number, error: ?string}>} */
  const state = new Map();
  const inFlight = new Map();
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  async function refresh(subsource) {
    const signal = AbortSignal.timeout(subsource.timeoutMs ?? timeoutMs);
    const client = createUpstreamClient({
      fetchImpl,
      signal,
      maxBytes: subsource.maxBytes ?? maxBytes,
      userAgent,
      now,
    });
    const collection = await subsource.fetchSnapshot({
      fetchImpl: client.fetch,
      fetchJson: client.fetchJson,
      fetchText: client.fetchText,
      fetchBytes: client.fetchBytes,
      signal,
      now,
    });
    signal.throwIfAborted();
    if (
      collection?.type !== 'FeatureCollection' ||
      !Array.isArray(collection.features)
    )
      throw invalidPayload('subsource returned no FeatureCollection');
    const truncated = collection.features.length > maxFeatures;
    const features = collection.features.slice(0, maxFeatures).map((f) => ({
      type: 'Feature',
      id: typeof f?.id === 'string' && f.id ? `${subsource.id}:${f.id}` : f?.id,
      geometry: f?.geometry,
      properties: {
        ...(f?.properties || {}),
        layer: layerId,
        source: subsource.id,
        timestamp: f?.properties?.timestamp ?? null,
      },
    }));
    const { ok, errors } = validateKeylessLayerCollection(
      { type: 'FeatureCollection', features },
      { layerId },
    );
    if (!ok) {
      console.warn(
        `[keyless:${layerId}] ${subsource.id} rejected: ${errors[0]}`,
      );
      throw invalidPayload('normalized collection failed validation');
    }
    return {
      features,
      fetchedAt: now(),
      truncated,
      details: sourceDetails(collection.details),
    };
  }

  async function acquire(subsource) {
    const entry = state.get(subsource.id);
    const ttl = subsource.ttlMs ?? ttlMs;
    if (entry?.value && now() - entry.savedAt < ttl)
      return { value: entry.value, ok: true, stale: false };
    if (
      entry?.failedAt != null &&
      now() - entry.failedAt <
        Math.max(failureBackoffMs, entry.retryAfterMs ?? 0)
    )
      return {
        value: entry.value,
        ok: false,
        stale: Boolean(entry.value),
        error: entry.error,
      };
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        subsource.id,
        async () => {
          try {
            const value = await refresh(subsource);
            state.set(subsource.id, {
              value,
              savedAt: now(),
              failedAt: null,
              error: null,
            });
            return value;
          } catch (error) {
            const previous = state.get(subsource.id);
            state.set(subsource.id, {
              value: previous?.value ?? null,
              savedAt: previous?.savedAt ?? 0,
              failedAt: now(),
              retryAfterMs: error?.retryAfterMs ?? null,
              error: keylessErrorCode(error),
            });
            throw error;
          }
        },
      );
      return { value: await promise, ok: true, stale: false };
    } catch {
      const failed = state.get(subsource.id);
      return {
        value: failed?.value ?? null,
        ok: false,
        stale: Boolean(failed?.value),
        error: failed?.error ?? 'upstream_unavailable',
      };
    }
  }

  /** Apply the layer's `combine` step and hold its output to the contract. */
  function combineFeatures(features) {
    if (!combine) return features;
    const combined = combine(features);
    const { ok, errors } = validateKeylessLayerCollection(
      { type: 'FeatureCollection', features: combined },
      { layerId },
    );
    if (!ok) {
      console.warn(`[keyless:${layerId}] combined feed rejected: ${errors[0]}`);
      throw invalidPayload('combined collection failed validation');
    }
    return combined;
  }

  function statusBody() {
    return {
      layer: layerId,
      sources: subsources.map(({ id }) => {
        const entry = state.get(id);
        return {
          id,
          cached: Boolean(entry?.value),
          fetchedAt: iso(entry?.value?.fetchedAt),
          count: entry?.value?.features.length ?? 0,
          lastError: entry?.error ?? null,
        };
      }),
    };
  }

  async function handler(req, res) {
    const send = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    // The upstream URLs are fixed per subsource: the client query is ignored.
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '' && path !== '/status')
      return send(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return send(429, { error: 'rate_limited' });
    if (path === '/status') return send(200, statusBody());
    try {
      const results = await Promise.all(subsources.map(acquire));
      const served = results.filter((result) => result.value);
      if (!served.length) return send(502, { error: errorCode });
      const stale = served.some((result) => result.stale);
      const features = combineFeatures(
        served.flatMap((result) => result.value.features),
      );
      const body = {
        type: 'FeatureCollection',
        features,
        metadata: {
          layer: layerId,
          fetchedAt: iso(
            Math.min(...served.map((result) => result.value.fetchedAt)),
          ),
          stale,
          partial: results.some((result) => !result.ok),
          sources: subsources.map(({ id }, index) => {
            const result = results[index];
            return {
              ...(result.value?.details || {}),
              id,
              ok: result.ok,
              stale: result.stale,
              count: result.value?.features.length ?? 0,
              fetchedAt: iso(result.value?.fetchedAt),
              truncated: result.value?.truncated ?? false,
              ...(result.ok ? {} : { error: result.error }),
            };
          }),
        },
      };
      send(200, body, stale);
    } catch {
      send(502, { error: errorCode });
    }
  }

  return {
    name,
    configureServer({ middlewares }) {
      middlewares.use(route, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(route, handler);
    },
  };
}
