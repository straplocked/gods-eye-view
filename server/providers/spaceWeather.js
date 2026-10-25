import {
  AURORA_URL,
  KP_URL,
  SPACE_WEATHER_LAYER_ID,
  normalizeAurora,
  normalizeKp,
} from '../../src/layers/spaceWeather/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';

const MIB = 1024 * 1024;

/** NOAA SWPC OVATION aurora nowcast: a ~900 KB 1-degree grid, traced into band polygons. */
async function fetchAurora({ fetchJson }) {
  return normalizeAurora(await fetchJson(AURORA_URL, { maxBytes: 4 * MIB }));
}

/** NOAA SWPC planetary K-index: ~5 KB of 3-hour rows; only the latest value is kept. */
async function fetchKp({ fetchJson }) {
  return normalizeKp(await fetchJson(KP_URL, { maxBytes: MIB }));
}

/**
 * Keyless NOAA SWPC route at /api/v1/layers/space-weather: the aurora nowcast
 * as probability-band polygons, and the latest planetary K-index (no
 * features) in `metadata.sources[kp]`.
 */
export function spaceWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'space-weather',
    layerId: SPACE_WEATHER_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // SWPC regenerates the OVATION grid about every 5 minutes.
      { id: 'aurora', ttlMs: 5 * 60_000, fetchSnapshot: fetchAurora },
      // Kp is published per 3-hour interval; 15 minutes is plenty.
      { id: 'kp', ttlMs: 15 * 60_000, fetchSnapshot: fetchKp },
    ],
  });
}
