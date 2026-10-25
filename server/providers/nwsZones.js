/**
 * In-memory cache of NWS zone geometry for the Weather & Tsunami Warnings
 * layer. Most NWS alerts name only the zones they cover; each zone is a
 * separate api.weather.gov request, but zone boundaries are static, so each
 * one is fetched once, decimated, and kept for a week.
 *
 * The cache fills progressively: one refresh fetches at most `maxNewPerRefresh`
 * zones (four at a time, and only until `deadlineMs` has passed), most severe
 * alerts first, and the alerts whose zones are still missing wait for a later
 * refresh. That keeps the first request quick and never hammers the API.
 * @module server/providers/nwsZones
 */
import {
  isNwsZoneUrl,
  normalizeNwsZone,
} from '../../src/layers/weatherWarnings/records.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * @param {Object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs=7 days] - Age after which a zone is fetched again (the old copy is served meanwhile).
 * @param {number} [options.goneTtlMs=1 day] - How long a zone with no usable area (404, no polygon) is left alone.
 * @param {number} [options.retryMs=5 min] - Wait before retrying a zone whose fetch failed.
 * @param {number} [options.maxNewPerRefresh=150] - Zone fetches started per `fill()`.
 * @param {number} [options.concurrency=4]
 * @param {number} [options.deadlineMs=30000] - No new zone fetch starts after this long into a `fill()`.
 * @param {number} [options.maxEntries=6000] - Cache size bound; the oldest entries go first.
 */
export function createNwsZoneResolver({
  now = () => Date.now(),
  ttlMs = 7 * DAY_MS,
  goneTtlMs = DAY_MS,
  retryMs = 5 * 60_000,
  maxNewPerRefresh = 150,
  concurrency = 4,
  deadlineMs = 30_000,
  maxEntries = 6000,
} = {}) {
  /** @type {Map<string, {polygons: ?Array, savedAt: number, retryAt: ?number}>} */
  const cache = new Map();

  function remember(url, entry) {
    cache.delete(url);
    cache.set(url, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  /**
   * The zone's polygons, null when the zone has no usable area, or undefined
   * when it is not resolved yet. An expired copy is still served.
   */
  function lookup(url) {
    const entry = cache.get(url);
    return entry ? entry.polygons : undefined;
  }

  /** Whether `fill()` should fetch this zone now. */
  function needsFetch(url) {
    if (!isNwsZoneUrl(url)) return false;
    const entry = cache.get(url);
    if (!entry) return true;
    const at = now();
    if (entry.retryAt != null) return at >= entry.retryAt;
    return at - entry.savedAt >= (entry.polygons ? ttlMs : goneTtlMs);
  }

  /**
   * Fetch missing zones from `urls` (already in priority order) within the
   * budget. Never throws for a failed zone: it is retried after `retryMs`.
   * @param {string[]} urls
   * @param {Object} options
   * @param {(url: string) => Promise<?Object>} options.fetchZone - GeoJSON or null on 404.
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{attempted: number, resolved: number, gone: number, failed: number, deferred: number}>}
   */
  async function fill(urls, { fetchZone, signal } = {}) {
    const wanted = urls.filter(needsFetch);
    const queue = wanted.slice(0, maxNewPerRefresh);
    const stats = {
      attempted: 0,
      resolved: 0,
      gone: 0,
      failed: 0,
      deferred: wanted.length - queue.length,
    };
    const startedAt = now();
    let next = 0;

    async function fetchOne(url) {
      stats.attempted += 1;
      try {
        const payload = await fetchZone(url);
        const polygons = payload == null ? null : normalizeNwsZone(payload);
        remember(url, { polygons, savedAt: now(), retryAt: null });
        if (polygons) stats.resolved += 1;
        else stats.gone += 1;
      } catch (error) {
        if (signal?.aborted) return;
        const previous = cache.get(url);
        if (error?.code === 'RESPONSE_TOO_LARGE') {
          // A zone that never fits the cap will not fit next time either.
          remember(url, { polygons: null, savedAt: now(), retryAt: null });
          stats.gone += 1;
          return;
        }
        // Keep an expired copy while its refresh fails.
        remember(url, {
          polygons: previous ? previous.polygons : undefined,
          savedAt: previous?.savedAt ?? 0,
          retryAt: now() + retryMs,
        });
        stats.failed += 1;
      }
    }

    async function worker() {
      for (;;) {
        if (signal?.aborted || now() - startedAt > deadlineMs) return;
        const index = next++;
        if (index >= queue.length) return;
        await fetchOne(queue[index]);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, worker),
    );
    stats.deferred += queue.length - stats.attempted;
    return stats;
  }

  return { lookup, needsFetch, fill, size: () => cache.size };
}
