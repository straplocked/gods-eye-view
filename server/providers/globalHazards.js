import {
  EONET_URL,
  GDACS_EVENT_TYPES,
  GLOBAL_HAZARDS_LAYER_ID,
  gdacsMapUrl,
  normalizeEonetEvents,
  normalizeGdacsEvents,
} from '../../src/layers/globalHazards/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';

const MIB = 1024 * 1024;

/**
 * GDACS current events, all six types. The MAP list takes exactly one
 * eventtype per call and answers 404 for a type with nothing current (the
 * SEARCH list instead stops at 100 events, which earthquakes and wildfires
 * fill on their own). The drought list carries large area polygons (~3 MB).
 */
async function fetchGdacs({ fetchJson }) {
  const payloads = await Promise.all(
    GDACS_EVENT_TYPES.map((type) =>
      fetchJson(gdacsMapUrl(type), {
        emptyStatuses: [204, 404],
        maxBytes: 12 * MIB,
      }),
    ),
  );
  return normalizeGdacsEvents(payloads);
}

/** NASA EONET open events, last 30 days. */
async function fetchEonet({ fetchJson }) {
  return normalizeEonetEvents(
    await fetchJson(EONET_URL, { maxBytes: 8 * MIB }),
  );
}

/** Keyless GDACS + NASA EONET route at /api/v1/layers/global-hazards. */
export function globalHazardsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'global-hazards',
    layerId: GLOBAL_HAZARDS_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // Six parallel MAP reads (droughts alone are ~3 MB) can take ~20 s.
      {
        id: 'gdacs',
        ttlMs: 15 * 60_000,
        timeoutMs: 60_000,
        fetchSnapshot: fetchGdacs,
      },
      { id: 'eonet', ttlMs: 30 * 60_000, fetchSnapshot: fetchEonet },
    ],
  });
}
