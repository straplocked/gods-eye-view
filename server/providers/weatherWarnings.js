import {
  NWS_ACCEPT,
  NWS_ALERTS_URL,
  TSUNAMI_FEEDS,
  WEATHER_WARNINGS_LAYER_ID,
  mergeTsunamiFeeds,
  normalizeNwsAlerts,
  normalizeTsunamiFeed,
  nwsZonesToResolve,
} from '../../src/layers/weatherWarnings/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';
import { createNwsZoneResolver } from './nwsZones.js';

const MIB = 1024 * 1024;

/**
 * NWS active alerts. Polygon alerts are used as published; zone-only alerts
 * get their area from the zone cache, which this refresh tops up by at most
 * the resolver's per-refresh budget. Alerts still waiting for zones are left
 * out and counted in the source's `pendingAlerts` / `pendingZones`.
 */
function nwsSubsource(zones) {
  return async function fetchNws({ fetchJson, signal, now }) {
    const headers = { Accept: NWS_ACCEPT };
    const payload = await fetchJson(NWS_ALERTS_URL, {
      headers,
      maxBytes: 12 * MIB,
    });
    const wanted = nwsZonesToResolve(payload, zones.needsFetch, now());
    await zones.fill(wanted, {
      signal,
      // A zone that does not exist answers 404: remembered as having no area.
      fetchZone: (url) =>
        fetchJson(url, { headers, emptyStatuses: [404], maxBytes: 2 * MIB }),
    });
    return normalizeNwsAlerts(payload, {
      zoneLookup: zones.lookup,
      nowMs: now(),
    });
  };
}

/**
 * Both tsunami.gov warning-center feeds. One failing feed fails the
 * subsource (the last good snapshot is served stale and flagged) rather than
 * serving a map silently missing a warning center.
 */
async function fetchTsunami({ fetchText, now }) {
  const documents = await Promise.all(
    TSUNAMI_FEEDS.map(({ url }) => fetchText(url, { maxBytes: MIB })),
  );
  return mergeTsunamiFeeds(
    documents.map((xml, index) =>
      normalizeTsunamiFeed(xml, {
        center: TSUNAMI_FEEDS[index].center,
        nowMs: now(),
      }),
    ),
  );
}

/**
 * Keyless NWS alerts + NOAA tsunami.gov route at /api/v1/layers/weather-warnings.
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {Object} [options.zones] - Zone cache (createNwsZoneResolver options).
 */
export function weatherWarningsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  zones: zoneOptions = {},
} = {}) {
  const zones = createNwsZoneResolver({ now, ...zoneOptions });
  return createKeylessFeedProxy({
    name: 'weather-warnings',
    layerId: WEATHER_WARNINGS_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // The refresh may spend up to ~30 s on zone fetches (nwsZones.js).
      {
        id: 'nws',
        ttlMs: 2 * 60_000,
        timeoutMs: 60_000,
        maxBytes: 12 * MIB,
        fetchSnapshot: nwsSubsource(zones),
      },
      { id: 'tsunami', ttlMs: 5 * 60_000, fetchSnapshot: fetchTsunami },
    ],
  });
}
