import {
  NDBC_LATEST_URL,
  NWPS_TILES,
  WATER_OBSERVATIONS_LAYER_ID,
  normalizeBuoys,
  normalizeGauges,
  nwpsTileUrl,
} from '../../src/layers/waterObservations/records.js';
import { createKeylessFeedProxy, mapLimited } from './common/keylessFeed.js';

const MIB = 1024 * 1024;
/** Tiles requested at once: NWPS answers a tile in 3 to 15 s, and is not quick. */
const TILE_CONCURRENCY = 3;

/** NDBC latest observations: ~100 KB of text for ~850 stations, refreshed every 10 minutes. */
async function fetchBuoys({ fetchText, now }) {
  const text = await fetchText(NDBC_LATEST_URL, { maxBytes: MIB });
  return normalizeBuoys(text, { nowMs: now() });
}

/**
 * NWPS gauge list, one bounding-box tile at a time (the unfiltered list is
 * 13 MB and takes 40 s or more; a tile takes a few seconds). A tile that fails
 * with an upstream HTTP status (the service answers 504 under load) is asked
 * once more. Any tile still failing fails the whole snapshot, so a missing
 * region can never be mistaken for "no flooding there": the last good
 * snapshot keeps being served as stale instead.
 */
async function fetchRivers({ fetchJson }) {
  const tile = (box) =>
    fetchJson(nwpsTileUrl(box), { maxBytes: 8 * MIB, retries: 1 });
  return normalizeGauges(await mapLimited(NWPS_TILES, TILE_CONCURRENCY, tile));
}

/**
 * Keyless NOAA route at /api/v1/layers/water-observations: NDBC buoy and
 * coastal-station observations as points, and NWPS river gauges at or above
 * flood action stage as points colored by flood category.
 */
export function waterObservationsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'water-observations',
    layerId: WATER_OBSERVATIONS_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // The file refreshes every 10 minutes; 15 is the layer's cadence.
      { id: 'buoys', ttlMs: 15 * 60_000, fetchSnapshot: fetchBuoys },
      {
        id: 'rivers',
        ttlMs: 15 * 60_000,
        // Eight tiles, three at a time, each retried once.
        timeoutMs: 120_000,
        fetchSnapshot: fetchRivers,
      },
    ],
  });
}
