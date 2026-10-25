import {
  GVP_URL,
  USGS_URL,
  USGS_USER_AGENT,
  VOLCANOES_LAYER_ID,
  mergeVolcanoFeatures,
  normalizeGvpEruptions,
  normalizeUsgsStatus,
} from '../../src/layers/volcanoes/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';

const MIB = 1024 * 1024;

/** Smithsonian GVP eruptions still marked continuing (a few dozen records). */
async function fetchGvp({ fetchJson }) {
  return normalizeGvpEruptions(await fetchJson(GVP_URL, { maxBytes: 2 * MIB }));
}

/**
 * USGS Volcano Hazards Program status, kept to elevated volcanoes. The body is
 * JSON served as text/html, which the kit's JSON reader does not mind. USGS
 * answers 404 to the kit's default User-Agent (it carries a URL), so this
 * request sends the bare product token instead.
 */
async function fetchUsgs({ fetchJson }) {
  return normalizeUsgsStatus(
    await fetchJson(USGS_URL, {
      maxBytes: 2 * MIB,
      headers: { 'User-Agent': USGS_USER_AGENT },
    }),
  );
}

/**
 * Keyless Smithsonian GVP + USGS route at /api/v1/layers/volcanoes. A volcano
 * both feeds list is served once, as a `gvp+usgs` feature.
 */
export function volcanoesProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'volcanoes',
    layerId: VOLCANOES_LAYER_ID,
    fetchImpl,
    now,
    combine: mergeVolcanoFeatures,
    subsources: [
      // GVP edits its eruption list by hand: a few times a day is plenty.
      { id: 'gvp', ttlMs: 6 * 60 * 60_000, fetchSnapshot: fetchGvp },
      // Observatories update alert levels as activity changes.
      { id: 'usgs', ttlMs: 10 * 60_000, fetchSnapshot: fetchUsgs },
    ],
  });
}
