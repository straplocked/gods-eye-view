import {
  INTERNET_INFRASTRUCTURE_LAYER_ID,
  PEERINGDB_FACILITIES_URL,
  iodaAlertsUrl,
  normalizeFacilities,
  normalizeOutages,
} from '../../src/layers/internetInfrastructure/records.js';
import { createKeylessFeedProxy } from './common/keylessFeed.js';

const MIB = 1024 * 1024;

/**
 * IODA outage alerts: the country list (14 days back, ~270 KB) decides the
 * markers, the region list (24 hours, ~60 KB) names the regions inside a
 * country that has no country-wide outage. A country list that fails fails
 * the feed (the last good snapshot is served stale). A region list that fails
 * only drops the region detail: the country markers are still right, and the
 * collection says so in `details.regionsIncluded`.
 */
async function fetchOutages({ fetchJson, signal, now }) {
  const nowMs = now();
  const country = await fetchJson(iodaAlertsUrl('country', nowMs), {
    maxBytes: 4 * MIB,
  });
  let regions = null;
  try {
    regions = await fetchJson(iodaAlertsUrl('region', nowMs), {
      maxBytes: 4 * MIB,
    });
  } catch (error) {
    // The refresh's own deadline is not a region failure.
    signal.throwIfAborted();
    console.warn(
      `[keyless:${INTERNET_INFRASTRUCTURE_LAYER_ID}] IODA region alerts unavailable: ${error?.code || 'error'}`,
    );
  }
  return normalizeOutages({ country, regions }, { nowMs });
}

/**
 * PeeringDB facilities in one request: no limit and depth 0 with the field
 * list trimmed, so the whole list is ~1.6 MB where the full records are
 * several times that. Anonymous access is rate-limited, hence the 24-hour
 * cache; the list barely changes.
 */
async function fetchFacilities({ fetchJson }) {
  return normalizeFacilities(
    await fetchJson(PEERINGDB_FACILITIES_URL, { maxBytes: 8 * MIB }),
  );
}

/**
 * Keyless route at /api/v1/layers/internet-infrastructure: IODA internet
 * outage alerts as one marker per country, and PeeringDB data center and
 * interconnection facilities as points.
 */
export function internetInfrastructureProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'internet-infrastructure',
    layerId: INTERNET_INFRASTRUCTURE_LAYER_ID,
    fetchImpl,
    now,
    subsources: [
      // PeeringDB's anonymous limit is the reason for a day-long cache. Listed
      // first so its thousands of points are drawn first and the few outage
      // markers, added last, sit on top of them.
      {
        id: 'datacenters',
        ttlMs: 24 * 3_600_000,
        timeoutMs: 60_000,
        fetchSnapshot: fetchFacilities,
      },
      // IODA alerts arrive every 5 to 30 minutes per signal.
      {
        id: 'outages',
        ttlMs: 10 * 60_000,
        timeoutMs: 45_000,
        fetchSnapshot: fetchOutages,
      },
    ],
  });
}
