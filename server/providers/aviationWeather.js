import {
  AVIATION_WEATHER_LAYER_ID,
  ISIGMET_URL,
  METAR_CACHE_URL,
  SIGMET_URL,
  normalizeMetars,
  normalizeSigmets,
} from '../../src/layers/aviationWeather/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';

const MIB = 1024 * 1024;

/**
 * AWC bulk METAR cache: ~250 KB gzip, ~1 MB of CSV for ~5,100 stations,
 * refreshed about once a minute. AWC asks bulk users to read this file rather
 * than query by bounding box.
 */
async function fetchMetars({ fetchText, now }) {
  const csv = await fetchText(METAR_CACHE_URL, {
    gzip: 'auto',
    maxBytes: 2 * MIB,
    maxDecodedBytes: 16 * MIB,
  });
  return normalizeMetars(csv, { nowMs: now() });
}

/** AWC US SIGMET/AIRMET GeoJSON: a few KB; an empty collection means none in force. */
async function fetchSigmets({ fetchJson, now }) {
  return normalizeSigmets(await fetchJson(SIGMET_URL, { maxBytes: MIB }), {
    kind: 'us',
    nowMs: now(),
  });
}

/** AWC international SIGMET GeoJSON: ~150 KB for ~180 advisories. */
async function fetchInternationalSigmets({ fetchJson, now }) {
  return normalizeSigmets(await fetchJson(ISIGMET_URL, { maxBytes: 4 * MIB }), {
    kind: 'international',
    nowMs: now(),
  });
}

/**
 * Keyless NOAA Aviation Weather Center route at /api/v1/layers/aviation-weather:
 * worldwide METARs as points colored by flight category (from the bulk cache
 * file), and US and international SIGMET/AIRMET advisories as polygons.
 */
export function aviationWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'aviation-weather',
    layerId: AVIATION_WEATHER_LAYER_ID,
    fetchImpl,
    now,
    // About 5,100 METAR stations today; the kit's default cap is 10,000.
    maxFeatures: 20_000,
    subsources: [
      // The cache file refreshes every minute; five is the layer's cadence.
      { id: 'metar', ttlMs: 5 * 60_000, fetchSnapshot: fetchMetars },
      { id: 'sigmet', ttlMs: 5 * 60_000, fetchSnapshot: fetchSigmets },
      {
        id: 'isigmet',
        ttlMs: 5 * 60_000,
        fetchSnapshot: fetchInternationalSigmets,
      },
    ],
  });
}
