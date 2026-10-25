import {
  AIRPORT_LOOKUP_CHUNK,
  AIRSPACE_LAYER_ID,
  FAA_STATUS_URL,
  TFR_LIST_URL,
  airportLookupUrl,
  buildDelayFeatures,
  icaoCandidate,
  normalizeAirportLookup,
  normalizeFaaStatus,
  normalizeTfrDetail,
  normalizeTfrList,
  tfrDetailUrl,
  tfrExpired,
} from '../../src/layers/airspace/records.js';
import {
  KeylessFeedError,
  createKeylessFeedProxy,
  mapLimited,
} from './common/keylessFeed.js';

const KIB = 1024;

/** Parallel per-NOTAM downloads: tfr.faa.gov serves a few at a time politely. */
const DETAIL_CONCURRENCY = 4;

/** A cached NOTAM geometry is re-read after this long even if its list entry is unchanged. */
const DETAIL_MAX_AGE_MS = 6 * 3_600_000;

/** A resolved airport position is kept for a week, an unknown identifier for a day. */
const AIRPORT_TTL_MS = 7 * 24 * 3_600_000;
const AIRPORT_MISS_TTL_MS = 24 * 3_600_000;

/**
 * Keyless FAA route at /api/v1/layers/airspace: Temporary Flight Restrictions
 * as polygons (the list from tfr.faa.gov plus one XNOTAM download per TFR for
 * the geometry) and NAS airport delays as points (the NAS Status XML, with
 * airport positions resolved through the NOAA AWC airport lookup).
 *
 * Two caches live here, outside the kit's per-subsource snapshot: each TFR's
 * parsed geometry (kept until the TFR leaves the list, re-read when its list
 * entry changes or after six hours, so a 10-minute refresh costs one list
 * request instead of ~80) and each airport's position (a week).
 */
export function airspaceProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {created: string, fetchedAt: number, features: Array<Object>, noGeometry: boolean}>} */
  const details = new Map();
  /** @type {Map<string, {airport: ?Object, at: number}>} */
  const airports = new Map();

  async function fetchTfrs({ fetchJson, fetchText, signal }) {
    const list = normalizeTfrList(
      await fetchJson(TFR_LIST_URL, { maxBytes: 1024 * KIB }),
    );
    const nowMs = now();
    const listed = new Set(list.map(({ notamId }) => notamId));
    for (const notamId of details.keys())
      if (!listed.has(notamId)) details.delete(notamId);
    const todo = list.filter(({ notamId, created }) => {
      const cached = details.get(notamId);
      return (
        !cached ||
        cached.created !== created ||
        nowMs - cached.fetchedAt > DETAIL_MAX_AGE_MS
      );
    });
    await mapLimited(todo, DETAIL_CONCURRENCY, async (entry) => {
      try {
        const xml = await fetchText(tfrDetailUrl(entry.notamId), {
          maxBytes: 512 * KIB,
        });
        const { features, noGeometry } = normalizeTfrDetail(xml, entry);
        details.set(entry.notamId, {
          created: entry.created,
          fetchedAt: nowMs,
          features,
          noGeometry,
        });
      } catch (error) {
        // The refresh's own timeout ends the whole refresh (what was read
        // stays cached); a single bad NOTAM only costs that NOTAM.
        if (signal.aborted) throw error;
        console.warn(
          `[keyless:${AIRSPACE_LAYER_ID}] TFR ${entry.notamId} skipped: ${error?.message}`,
        );
      }
    });
    const known = list.filter(({ notamId }) => details.has(notamId));
    // Every download failed and nothing was ever read: an outage, not "no TFRs".
    if (list.length && !known.length)
      throw new KeylessFeedError('upstream_unavailable', 'no TFR detail read');
    const features = known.flatMap(({ notamId }) =>
      details
        .get(notamId)
        .features.filter(({ properties }) => !tfrExpired(properties, nowMs)),
    );
    return {
      type: 'FeatureCollection',
      features,
      details: {
        listed: list.length,
        withoutGeometry: known.filter(
          ({ notamId }) => details.get(notamId).noGeometry,
        ).length,
        pendingDetails: list.length - known.length,
      },
    };
  }

  /** Make sure every FAA airport id has a cached position (or a recent miss). */
  async function resolveAirports(ids, { fetchJson, signal }) {
    const nowMs = now();
    const stale = ids.filter((id) => {
      const cached = airports.get(id);
      return (
        !cached ||
        nowMs - cached.at >
          (cached.airport ? AIRPORT_TTL_MS : AIRPORT_MISS_TTL_MS)
      );
    });
    // FAA id → ICAO; an id that cannot be an airport code is a standing miss.
    const wanted = new Map();
    for (const id of stale) {
      const icao = icaoCandidate(id);
      if (icao) wanted.set(id, icao);
      else airports.set(id, { airport: null, at: nowMs });
    }
    const codes = [...new Set(wanted.values())];
    let failed = 0;
    for (let i = 0; i < codes.length; i += AIRPORT_LOOKUP_CHUNK) {
      const chunk = codes.slice(i, i + AIRPORT_LOOKUP_CHUNK);
      try {
        const found = new Map(
          normalizeAirportLookup(
            await fetchJson(airportLookupUrl(chunk), {
              emptyStatuses: [204],
              maxBytes: 1024 * KIB,
            }),
          ).map((airport) => [airport.icao, airport]),
        );
        for (const [id, icao] of wanted)
          if (chunk.includes(icao))
            airports.set(id, { airport: found.get(icao) ?? null, at: nowMs });
      } catch (error) {
        if (signal.aborted) throw error;
        failed++;
        console.warn(
          `[keyless:${AIRSPACE_LAYER_ID}] airport lookup failed: ${error?.message}`,
        );
      }
    }
    return failed;
  }

  async function fetchDelays(context) {
    const nowMs = now();
    const status = normalizeFaaStatus(
      await context.fetchText(FAA_STATUS_URL, { maxBytes: 512 * KIB }),
      { nowMs },
    );
    const ids = status.airports.map(({ airport }) => airport);
    const failedLookups = await resolveAirports(ids, context);
    const located = new Map();
    for (const id of ids) {
      const airport = airports.get(id)?.airport;
      if (airport) located.set(id, airport);
    }
    // Delays exist but the lookup was down and nothing is known: an outage,
    // not "no delays" — never cache an empty snapshot for it.
    if (ids.length && !located.size && failedLookups)
      throw new KeylessFeedError(
        'upstream_unavailable',
        'airport lookup failed',
      );
    const { features, unresolved } = buildDelayFeatures(status, located);
    return {
      type: 'FeatureCollection',
      features,
      details: { airports: ids.length, unlocated: unresolved.length },
    };
  }

  return createKeylessFeedProxy({
    name: 'airspace',
    layerId: AIRSPACE_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // The first read downloads one XNOTAM per TFR (~80, four at a time).
      {
        id: 'tfr',
        ttlMs: 10 * 60_000,
        timeoutMs: 90_000,
        fetchSnapshot: fetchTfrs,
      },
      { id: 'delays', ttlMs: 5 * 60_000, fetchSnapshot: fetchDelays },
    ],
  });
}
