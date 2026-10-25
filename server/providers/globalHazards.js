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

/** How long one GDACS event type may take before the others are served. */
export const GDACS_TYPE_DEADLINE_MS = 25_000;

/**
 * GDACS current events, all six types. The MAP list takes exactly one
 * eventtype per call and answers 404 for a type with nothing current (the
 * SEARCH list instead stops at 100 events, which earthquakes and wildfires
 * fill on their own). The drought list carries large area polygons (~3 MB).
 *
 * Each type is read independently: one that fails or misses its deadline
 * (the drought list has been seen hanging for 90 s+) falls back to that
 * type's last good payload, or is left out and named in `missingTypes`, so a
 * single slow list cannot blank the other five. Only when every type fails
 * does the read throw, so an empty GDACS snapshot is never cached.
 * @param {{deadlineMs?: number}} [options]
 */
function createGdacsFetcher({ deadlineMs = GDACS_TYPE_DEADLINE_MS } = {}) {
  /** @type {Map<string, unknown>} */
  const lastGood = new Map();

  function readType(fetchJson, type) {
    const read = fetchJson(gdacsMapUrl(type), {
      emptyStatuses: [204, 404],
      maxBytes: 12 * MIB,
    });
    read.catch(() => {});
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`GDACS ${type} missed its deadline`)),
        deadlineMs,
      );
      timer.unref?.();
    });
    return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
  }

  return async function fetchGdacs({ fetchJson }) {
    const settled = await Promise.allSettled(
      GDACS_EVENT_TYPES.map((type) => readType(fetchJson, type)),
    );
    const payloads = [];
    const missing = [];
    let anyFresh = false;
    settled.forEach((result, index) => {
      const type = GDACS_EVENT_TYPES[index];
      if (result.status === 'fulfilled') {
        // Validate each type on its own, so a corrupt list is never kept as
        // that type's last good payload.
        try {
          normalizeGdacsEvents([result.value]);
        } catch (error) {
          result = { status: 'rejected', reason: error };
          settled[index] = result;
        }
      }
      if (result.status === 'fulfilled') {
        anyFresh = true;
        lastGood.set(type, result.value);
        payloads.push(result.value);
      } else if (lastGood.has(type)) {
        payloads.push(lastGood.get(type));
        missing.push(`${type}(cached)`);
      } else {
        missing.push(type);
      }
    });
    if (!anyFresh) throw settled.find((r) => r.status === 'rejected').reason;
    const collection = normalizeGdacsEvents(payloads);
    return missing.length
      ? { ...collection, details: { missingTypes: missing.join(',') } }
      : collection;
  };
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
  gdacsTypeDeadlineMs = GDACS_TYPE_DEADLINE_MS,
} = {}) {
  return createKeylessFeedProxy({
    name: 'global-hazards',
    layerId: GLOBAL_HAZARDS_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // Six parallel MAP reads (droughts alone are ~3 MB) can take ~20 s;
      // each type has its own deadline inside the 60 s refresh.
      {
        id: 'gdacs',
        ttlMs: 15 * 60_000,
        timeoutMs: 60_000,
        fetchSnapshot: createGdacsFetcher({ deadlineMs: gdacsTypeDeadlineMs }),
      },
      { id: 'eonet', ttlMs: 30 * 60_000, fetchSnapshot: fetchEonet },
    ],
  });
}
