/**
 * Normalizers for the Internet Outages & Data Centers layer: Georgia Tech's
 * Internet Outage Detection and Analysis (IODA) alerts, drawn as one marker
 * per country, and PeeringDB colocation facilities, drawn as one point each.
 * Pure and portable — the server proxy (server/providers/internetInfrastructure.js)
 * and tests import them.
 *
 * IODA publishes alerts, not outages: each alert is a state change of one
 * signal (`bgp`, `ping-slash24`, `gtr`, `merit-nt`) for one entity, to
 * `critical`/`warning` when the signal drops below its baseline and back to
 * `normal` when it recovers. The current state of a signal is therefore its
 * newest alert, and an outage that began before the window shows only its
 * opening alert, which is why the country request reaches 14 days back. IODA
 * entities are countries and regions, never coordinates; a country is placed
 * at the hand-written position in countryCentroids.js and a region (IODA
 * supplies no position for one) is folded into its country's marker.
 * @module layers/internetInfrastructure/records
 */
import { isValidGeometry } from '../common/geojson.js';
import { countryCentroid } from './countryCentroids.js';

export const INTERNET_INFRASTRUCTURE_LAYER_ID = 'internet-infrastructure';

/** IODA outage alert list (JSON). */
export const IODA_ALERTS_URL =
  'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts';

/** PeeringDB facility list, depth 0, only the fields the layer serves (~1.6 MB). */
export const PEERINGDB_FACILITIES_URL =
  'https://www.peeringdb.com/api/fac?depth=0&fields=id,name,org_name,city,country,latitude,longitude,net_count,ix_count,website,status';

/** Outages that ended within this window are still shown, as recovered. */
export const IODA_WINDOW_MS = 24 * 3_600_000;

/**
 * How far before the window the country request looks for the opening alert of
 * an outage that is still going (IODA's `extendWindow`, in seconds).
 */
export const IODA_LOOKBACK_S = 14 * 86_400;

/** Alerts asked for per request; a list this long is cut off and refused. */
export const IODA_ALERT_LIMIT = 5000;

/** Alerts stamped further ahead than this are a clock error and are dropped. */
const IODA_MAX_FUTURE_MS = 3_600_000;
const MAX_NAME = 120;
const MAX_REGIONS_LISTED = 8;
/** PeeringDB lists about 5,900 facilities; far fewer means a broken answer. */
export const MIN_FACILITIES_LISTED = 1000;
const MAX_FACILITIES = 20_000;
const MAX_URL = 300;

const COUNTRY_CODE = /^[A-Z]{2}$/;
const DATASOURCE = /^[a-z][a-z0-9-]{1,23}$/;
const ALERT_LEVELS = new Set(['critical', 'warning', 'normal']);

/** Error for a corrupt or non-collection payload; never cached (keylessFeed). */
function invalidPayload(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value, max = MAX_NAME) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * The fixed IODA alert URL for one entity type. Countries look back 14 days so
 * an outage that began before the 24-hour window is still found; regions use
 * the plain window (their lists are long and they carry no position anyway).
 * @param {'country'|'region'} entityType
 * @param {number} nowMs
 * @returns {string}
 */
export function iodaAlertsUrl(entityType, nowMs) {
  const until = Math.floor(nowMs / 1000);
  const from = Math.floor((nowMs - IODA_WINDOW_MS) / 1000);
  const extend =
    entityType === 'country' ? `&extendWindow=${IODA_LOOKBACK_S}` : '';
  return (
    `${IODA_ALERTS_URL}?from=${from}&until=${until}` +
    `&entityType=${entityType}&limit=${IODA_ALERT_LIMIT}${extend}`
  );
}

/**
 * Group the alerts of one IODA response into per-signal series.
 * @returns {Map<string, {entity: Object, datasource: string, alerts: Array<{ms: number, level: string}>}>}
 */
function readSeries(payload, entityType, nowMs) {
  if (!isObject(payload) || !Array.isArray(payload.data))
    throw invalidPayload('IODA response has no alert list');
  if (payload.error) throw invalidPayload('IODA reported an error');
  if (payload.data.length >= IODA_ALERT_LIMIT)
    throw invalidPayload('IODA alert list reached the request limit');
  const series = new Map();
  for (const alert of payload.data) {
    const entity = alert?.entity;
    if (!isObject(entity) || entity.type !== entityType) continue;
    const datasource = alert.datasource;
    if (typeof datasource !== 'string' || !DATASOURCE.test(datasource))
      continue;
    if (!ALERT_LEVELS.has(alert.level)) continue;
    const seconds = alert.time;
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const ms = seconds * 1000;
    if (ms - nowMs > IODA_MAX_FUTURE_MS) continue;
    const code = text(entity.code, 32);
    if (!code) continue;
    const key = `${code}|${datasource}`;
    if (!series.has(key)) series.set(key, { entity, datasource, alerts: [] });
    series.get(key).alerts.push({ ms, level: alert.level });
  }
  for (const entry of series.values()) entry.alerts.sort((a, b) => a.ms - b.ms);
  return series;
}

/**
 * The state of one signal from its alerts, oldest first. An outage is going
 * while the newest alert is not `normal`; it began at the first alert of that
 * unbroken run. A series whose newest alert is `normal` has recovered if it
 * ever left normal, from the first alert of its last run to the recovery.
 * @returns {?{ongoing: boolean, level: string, startMs: number, endMs: ?number, lastMs: number}}
 */
function signalState(alerts) {
  const last = alerts[alerts.length - 1];
  let i = alerts.length - 1;
  if (last.level !== 'normal') {
    while (i > 0 && alerts[i - 1].level !== 'normal') i--;
    return {
      ongoing: true,
      level: last.level,
      startMs: alerts[i].ms,
      endMs: null,
      lastMs: last.ms,
    };
  }
  while (i >= 0 && alerts[i].level === 'normal') i--;
  if (i < 0) return null;
  const level = alerts[i].level;
  while (i > 0 && alerts[i - 1].level !== 'normal') i--;
  return {
    ongoing: false,
    level,
    startMs: alerts[i].ms,
    endMs: last.ms,
    lastMs: last.ms,
  };
}

const LEVEL_RANK = Object.freeze({ normal: 0, warning: 1, critical: 2 });
const worst = (states) =>
  states.reduce(
    (found, state) =>
      LEVEL_RANK[state.level] > LEVEL_RANK[found] ? state.level : found,
    'normal',
  );
const iso = (ms) => new Date(ms).toISOString();

/** Signals of every country, by ISO code: `{name, states: [{datasource, …state}]}`. */
function countrySignals(payload, nowMs) {
  const countries = new Map();
  for (const { entity, datasource, alerts } of readSeries(
    payload,
    'country',
    nowMs,
  ).values()) {
    const code = text(entity.code, 8).toUpperCase();
    if (!COUNTRY_CODE.test(code)) continue;
    const state = signalState(alerts);
    if (!countries.has(code))
      countries.set(code, { name: text(entity.name), states: [] });
    if (state) countries.get(code).states.push({ datasource, ...state });
  }
  return countries;
}

/** Ongoing region outages by country code: `{name, regions: [{name, datasource, …state}]}`. */
function regionSignals(payload, nowMs) {
  const countries = new Map();
  for (const { entity, datasource, alerts } of readSeries(
    payload,
    'region',
    nowMs,
  ).values()) {
    const code = text(entity.attrs?.country_code, 8).toUpperCase();
    if (!COUNTRY_CODE.test(code)) continue;
    const state = signalState(alerts);
    if (!state?.ongoing) continue;
    if (!countries.has(code))
      countries.set(code, {
        name: text(entity.attrs?.country_name),
        regions: [],
      });
    countries.get(code).regions.push({
      name: text(entity.name),
      datasource,
      ...state,
    });
  }
  return countries;
}

/**
 * Normalize IODA alert responses into one marker per country with an outage
 * going now or one that ended within the last 24 hours.
 *
 * A country's marker comes from, in order: its own going signals (`scope:
 * 'country'`), else the going signals of its regions (`scope: 'region'`, the
 * outage is somewhere inside the country), else a signal that recovered in the
 * window (`level: 'normal'`, `ongoing: false`). `level` is the worst level
 * among the signals behind the marker; `datasources` names them; `start` is
 * the earliest start among them and `end` the latest recovery (null while
 * going); `regions` lists up to eight names of regions with a going outage;
 * `timestamp` is IODA's newest alert time for the marker. Feature id = the
 * ISO country code.
 *
 * An entity whose code has no position in countryCentroids.js (IODA's `AP` and
 * `EU` placeholders) cannot be drawn and is counted in `details.unplaced`.
 * `details.regionsIncluded` says whether a region response was supplied.
 * Quiet countries are not features, so no outage anywhere is a legitimate
 * empty collection; a country response with no alerts at all in 14 days is a
 * broken answer and throws.
 * @param {{country: Object, regions?: ?Object}} payloads - Parsed IODA alert responses; `regions` may be null when that request failed.
 * @param {{nowMs?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: {unplaced: number, regionsIncluded: boolean}}}
 * @throws {Error & {code: 'invalid_payload'}} When a response is not an alert list, reached the request limit, or the country response holds no alert.
 */
export function normalizeOutages(
  { country, regions = null } = {},
  { nowMs = Date.now() } = {},
) {
  const countries = countrySignals(country, nowMs);
  if (!countries.size) throw invalidPayload('IODA returned no country alerts');
  const regionCountries = regions ? regionSignals(regions, nowMs) : new Map();
  const cutoff = nowMs - IODA_WINDOW_MS;
  const rows = [];
  let unplaced = 0;
  const codes = new Set([...countries.keys(), ...regionCountries.keys()]);
  for (const code of codes) {
    const own = countries.get(code);
    const inside = regionCountries.get(code);
    const going = own?.states.filter((state) => state.ongoing) ?? [];
    const recovered =
      own?.states.filter((state) => !state.ongoing && state.endMs >= cutoff) ??
      [];
    let scope = 'country';
    let states;
    if (going.length) states = going;
    else if (inside) {
      scope = 'region';
      states = inside.regions;
    } else if (recovered.length) states = recovered;
    else continue;
    const position = countryCentroid(code);
    if (!position) {
      unplaced++;
      continue;
    }
    const ongoing = states === going || states === inside?.regions;
    const regionNames = ongoing && inside ? inside.regions : [];
    const names = [...new Set(regionNames.map((region) => region.name))]
      .filter(Boolean)
      .sort();
    const geometry = { type: 'Point', coordinates: [...position] };
    if (!isValidGeometry(geometry)) continue;
    const startMs = Math.min(...states.map((state) => state.startMs));
    const endMs = ongoing
      ? null
      : Math.max(...states.map((state) => state.endMs));
    rows.push({
      startMs,
      feature: {
        type: 'Feature',
        id: code,
        geometry,
        properties: {
          code,
          name: own?.name || inside?.name || code,
          scope,
          level: ongoing ? worst(states) : 'normal',
          ongoing,
          datasources: [...new Set(states.map((state) => state.datasource))]
            .sort()
            .slice(0, 8),
          regions: names.slice(0, MAX_REGIONS_LISTED),
          regionCount: names.length,
          start: iso(startMs),
          end: endMs === null ? null : iso(endMs),
          url: `https://ioda.inetintel.cc.gatech.edu/country/${code}`,
          timestamp: iso(
            ongoing ? Math.max(...states.map((state) => state.lastMs)) : endMs,
          ),
        },
      },
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.feature.properties.ongoing) -
        Number(a.feature.properties.ongoing) ||
      LEVEL_RANK[b.feature.properties.level] -
        LEVEL_RANK[a.feature.properties.level] ||
      b.startMs - a.startMs ||
      a.feature.id.localeCompare(b.feature.id),
  );
  return {
    type: 'FeatureCollection',
    features: rows.map(({ feature }) => feature),
    details: { unplaced, regionsIncluded: regions !== null },
  };
}

/** A facility website as an https URL (an http one is upgraded), else null. */
function websiteUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  url.protocol = 'https:';
  return url.href;
}

/** A non-negative whole count, else null. */
const count = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;

function normalizeFacility(row) {
  if (!isObject(row)) return null;
  if (!Number.isInteger(row.id) || row.id <= 0) return null;
  if (row.status !== undefined && row.status !== 'ok') return null;
  const name = text(row.name, 200);
  if (!name) return null;
  const { latitude: lat, longitude: lon } = row;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  // PeeringDB leaves a facility it cannot place with no position; a literal
  // 0,0 is the same non-answer and would draw in the Gulf of Guinea.
  if (lat === 0 && lon === 0) return null;
  const geometry = { type: 'Point', coordinates: [lon, lat] };
  if (!isValidGeometry(geometry)) return null;
  const country = text(row.country, 8).toUpperCase();
  return {
    type: 'Feature',
    id: String(row.id),
    geometry,
    properties: {
      facility: row.id,
      name,
      org: text(row.org_name) || null,
      city: text(row.city) || null,
      country: COUNTRY_CODE.test(country) ? country : null,
      netCount: count(row.net_count),
      ixCount: count(row.ix_count),
      website: websiteUrl(row.website),
      url: `https://www.peeringdb.com/fac/${row.id}`,
      timestamp: null,
    },
  };
}

/**
 * Normalize the PeeringDB facility list into one point per facility that has
 * a position.
 *
 * Skipped: no positive integer id, a status other than `ok` (PeeringDB marks
 * deleted and pending records that way), no name, a null, non-numeric or
 * out-of-range latitude or longitude, and exactly 0,0. The first row of a
 * duplicated id wins. Counts are `null` where PeeringDB gives none, the
 * website is kept only as an https URL (http is upgraded), and `url` is the
 * facility's PeeringDB page. Feature id = the PeeringDB facility id.
 *
 * Fewer than `minFacilities` rows in the list is a broken answer, not an empty
 * map.
 * @param {Object} payload - Parsed `/api/fac` response, `{data: [...]}`.
 * @param {{minFacilities?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws {Error & {code: 'invalid_payload'}} When the payload has no `data` array, lists fewer than `minFacilities` rows, or none has a position.
 */
export function normalizeFacilities(
  payload,
  { minFacilities = MIN_FACILITIES_LISTED } = {},
) {
  if (!isObject(payload) || !Array.isArray(payload.data))
    throw invalidPayload('PeeringDB response has no facility list');
  if (payload.data.length < minFacilities)
    throw invalidPayload('PeeringDB listed too few facilities to trust');
  const byId = new Map();
  for (const row of payload.data.slice(0, MAX_FACILITIES)) {
    const feature = normalizeFacility(row);
    if (feature && !byId.has(feature.id)) byId.set(feature.id, feature);
  }
  if (!byId.size)
    throw invalidPayload('PeeringDB listed no facility with a position');
  return { type: 'FeatureCollection', features: [...byId.values()] };
}
