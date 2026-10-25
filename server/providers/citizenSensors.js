import {
  CITIZEN_SENSORS_LAYER_ID,
  SAFECAST_PAGE_SIZE,
  SAFECAST_SLICES,
  SAFECAST_SLICE_MS,
  SENSOR_COMMUNITY_URL,
  normalizeAirPm,
  normalizeRadiation,
  safecastUrl,
} from '../../src/layers/citizenSensors/records.js';
import {
  createKeylessFeedProxy,
  invalidPayload,
} from './common/keylessFeed.js';

const MIB = 1024 * 1024;
/** Pages read per one-hour Safecast slice: a busy hour is ~600 rows, one page. */
const MAX_PAGES_PER_SLICE = 3;
/** Binned cells served at most; the busiest cells are kept (~3,900 today). */
const MAX_FEATURES = 4500;

/** Sensor.Community dust readings: ~4.3 MB of JSON, rewritten about every 5 minutes. */
async function fetchAirPm({ fetchJson, now }) {
  const readings = await fetchJson(SENSOR_COMMUNITY_URL, {
    maxBytes: 16 * MIB,
  });
  return normalizeAirPm(readings, { nowMs: now() });
}

/**
 * Safecast measurements of the last six hours, one hour at a time, newest hour
 * first, one request at a time. The API lists oldest first and offers no
 * "latest per device", so an unbounded window would fill its pages with the
 * oldest rows and lose the newest; one-hour slices keep any truncation at the
 * old end. A request that fails with an upstream HTTP status is asked once
 * more. Any request still failing fails the whole snapshot, so a missing hour
 * can never be mistaken for "no readings": the last good snapshot keeps being
 * served as stale instead.
 */
async function fetchRadiation({ fetchJson, now }) {
  const nowMs = now();
  const rows = [];
  const page = (url) => fetchJson(url, { maxBytes: 2 * MIB, retries: 1 });
  for (let slice = 0; slice < SAFECAST_SLICES; slice++) {
    const before = nowMs - slice * SAFECAST_SLICE_MS;
    const after = before - SAFECAST_SLICE_MS;
    for (let number = 1; number <= MAX_PAGES_PER_SLICE; number++) {
      const body = await page(safecastUrl(after, before, number));
      if (!Array.isArray(body))
        throw invalidPayload('Safecast page is not an array');
      rows.push(...body);
      if (body.length < SAFECAST_PAGE_SIZE) break;
    }
  }
  return normalizeRadiation(rows, { nowMs });
}

/**
 * Keyless route at /api/v1/layers/citizen-sensors: Sensor.Community outdoor
 * particulate sensors binned to a 0.1 degree grid (median PM2.5 and PM10 per
 * cell, colored by EPA AQI category), and the latest Safecast radiation
 * reading of every device that reported in the last six hours.
 */
export function citizenSensorsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'citizen-sensors',
    layerId: CITIZEN_SENSORS_LAYER_ID,
    fetchImpl,
    now,
    maxFeatures: MAX_FEATURES,
    subsources: [
      // The file is rewritten about every 5 minutes; 10 is the layer's cadence.
      {
        id: 'airpm',
        ttlMs: 10 * 60_000,
        timeoutMs: 60_000,
        fetchSnapshot: fetchAirPm,
      },
      {
        id: 'radiation',
        ttlMs: 30 * 60_000,
        // Up to six slices of one to three sequential requests each.
        timeoutMs: 120_000,
        fetchSnapshot: fetchRadiation,
      },
    ],
  });
}
