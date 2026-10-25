/**
 * Normalizers for the Buoys & River Gauges layer: NOAA National Data Buoy
 * Center (NDBC) latest observations (one point per buoy or coastal station)
 * and NOAA National Water Prediction Service (NWPS) river gauges that are at
 * or above their flood action stage. Pure and portable — the server proxy
 * (server/providers/waterObservations.js) and tests import them.
 *
 * NDBC publishes `latest_obs.txt` as whitespace-delimited text: a `#STN …`
 * header, a `#text …` units line, then one row per station with `MM` for a
 * value the station did not report. A missing value becomes `null` (never 0
 * or NaN: a calm 0 m/s and an absent anemometer are different facts). Wind
 * comes in m/s and is also served in knots, rounded to 0.1.
 *
 * NWPS publishes every gauge (about 13,000) with the observed and forecast
 * flood category. The layer keeps the gauges whose observed or forecast
 * category is action, minor, moderate or major, about 170 on a typical day.
 * @module layers/waterObservations/records
 */
import { isValidGeometry, toIsoTimestamp } from '../common/geojson.js';
import { invalidPayload, toNumber } from '../common/normalize.js';

export const WATER_OBSERVATIONS_LAYER_ID = 'water-observations';

/** NDBC latest observation of every reporting station (text, about 100 KB). */
export const NDBC_LATEST_URL =
  'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';

/** NWPS gauge list. The unfiltered list is 13 MB and often times out. */
export const NWPS_GAUGES_URL = 'https://api.water.noaa.gov/nwps/v1/gauges';

/**
 * Bounding boxes `[west, south, east, north]` that together cover every NWPS
 * gauge with a position (the contiguous US, Alaska, Hawaii, Puerto Rico and
 * the Virgin Islands). One tile answers in a few seconds where the whole list
 * takes 40 s or more. Tiles overlap on their edges; gauges are de-duplicated.
 * The densest region (the central and eastern US) is split in two.
 */
export const NWPS_TILES = Object.freeze(
  [
    [-180, 0, -135, 75],
    [-135, 0, -120, 75],
    [-120, 0, -105, 75],
    [-105, 0, -90, 35],
    [-105, 35, -90, 75],
    [-90, 0, -75, 34],
    [-90, 34, -75, 75],
    [-75, 0, -60, 75],
  ].map((tile) => Object.freeze(tile)),
);

/** The fixed upstream URL for one NWPS tile. */
export function nwpsTileUrl([west, south, east, north]) {
  return (
    `${NWPS_GAUGES_URL}?bbox.xmin=${west}&bbox.ymin=${south}` +
    `&bbox.xmax=${east}&bbox.ymax=${north}&srid=EPSG_4326`
  );
}

/** Knots per metre per second (3600 s per hour over 1852 m per nautical mile). */
export const KNOTS_PER_MS = 3600 / 1852;

/** Flood categories worth drawing, mildest first. */
export const FLOOD_CATEGORIES = Object.freeze([
  'action',
  'minor',
  'moderate',
  'major',
]);

/** Observations older than this are dropped; the file normally holds ~3 hours. */
export const BUOY_MAX_AGE_MS = 6 * 3_600_000;

/** Observations stamped further ahead than this are a clock error. */
const BUOY_MAX_FUTURE_MS = 3_600_000;
const MAX_BUOY_ROWS = 20_000;
const MAX_GAUGES_PER_TILE = 20_000;
/** NWPS lists about 12,900 gauges; far fewer in all tiles means a broken answer. */
export const MIN_GAUGES_LISTED = 1000;
const STATION_ID = /^[A-Za-z0-9]{3,8}$/;
const GAUGE_ID = /^[A-Za-z0-9]{3,8}$/;
const STATE_CODE = /^[A-Z]{2}$/;
const MAX_NAME = 120;
/** NWPS publishes year 1 for "no time". */
const EARLIEST_VALID_MS = Date.UTC(2000, 0, 1);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const inRange = (value, min, max) =>
  value !== null && value >= min && value <= max ? value : null;

/** Metres per second to knots, rounded to 0.1 (null stays null). */
export function msToKnots(ms) {
  return Number.isFinite(ms) ? Math.round(ms * KNOTS_PER_MS * 10) / 10 : null;
}

/** Plausible range of each NDBC column the layer serves, in the file's units. */
const BUOY_FIELDS = Object.freeze([
  // [file column, property, min, max]
  ['WDIR', 'windDir', 0, 360],
  ['WSPD', 'windMs', 0, 120],
  ['GST', 'gustMs', 0, 150],
  ['WVHT', 'waveM', 0, 40],
  ['DPD', 'wavePeriodS', 0, 60],
  ['APD', 'avgPeriodS', 0, 60],
  ['MWD', 'waveDir', 0, 360],
  ['PRES', 'pressureHpa', 850, 1100],
  ['PTDY', 'pressureTrendHpa', -50, 50],
  ['ATMP', 'airC', -90, 60],
  ['WTMP', 'waterC', -5, 50],
  ['DEWP', 'dewC', -90, 50],
  ['VIS', 'visNmi', 0, 100],
  ['TIDE', 'tideFt', -30, 30],
]);

const REQUIRED_BUOY_COLUMNS = Object.freeze([
  'STN',
  'LAT',
  'LON',
  'YYYY',
  'MM',
  'DD',
  'hh',
  'mm',
]);

/** One NDBC field: 'MM' (missing) and anything unreadable or implausible is null. */
function buoyValue(token, min, max) {
  if (token === undefined || token === 'MM') return null;
  return inRange(toNumber(token), min, max);
}

/** Epoch ms of an NDBC `YYYY MM DD hh mm` UTC stamp, or null when it is not a real time. */
function buoyTime(year, month, day, hour, minute) {
  const parts = [year, month, day, hour, minute].map(toNumber);
  if (parts.some((part) => part === null || !Number.isInteger(part)))
    return null;
  const [y, mo, d, h, mi] = parts;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const date = new Date(ms);
  // Date.UTC rolls 31 February over into March: reject any stamp it changed.
  return Number.isFinite(ms) &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    y >= 2000
    ? ms
    : null;
}

/**
 * Normalize the NDBC `latest_obs.txt` text into one point per station.
 *
 * The header is the line that starts `#STN`; the units line and any other
 * `#` line are ignored. Columns are located by name, so a column added by
 * NDBC does not shift the rest. A row is skipped when its station id is not
 * 3-8 letters or digits, its position is non-finite, out of range or exactly
 * 0,0, its time is not a real time, the observation is older than `maxAgeMs`
 * (or more than an hour ahead of `nowMs`), it has a different column count
 * than the header, or it carries no usable measurement at all. A station
 * listed twice keeps its newest row. Feature id = the station id.
 *
 * Every measurement property is present: a value the station did not report
 * (`MM`) or that is outside a plausible range is `null`. Wind is served in
 * m/s (`windMs`, `gustMs`) and knots (`windKt`, `gustKt`).
 * @param {string} text
 * @param {{nowMs?: number, maxAgeMs?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws {Error & {code: 'invalid_payload'}} When there is no `#STN` header, a
 *   required column is missing, or no row yields a station (a format change or
 *   a stale file must not become an empty map).
 */
export function normalizeBuoys(
  text,
  { nowMs = Date.now(), maxAgeMs = BUOY_MAX_AGE_MS } = {},
) {
  if (typeof text !== 'string')
    throw invalidPayload('NDBC latest observations are not text');
  const lines = text.split('\n');
  const headerAt = lines.findIndex((line) => /^#\s*STN\b/.test(line));
  if (headerAt < 0) throw invalidPayload('NDBC file has no #STN header');
  const names = lines[headerAt].replace(/^#/, '').trim().split(/\s+/);
  const column = new Map();
  names.forEach((name, index) => {
    if (!column.has(name)) column.set(name, index);
  });
  if (REQUIRED_BUOY_COLUMNS.some((name) => !column.has(name)))
    throw invalidPayload('NDBC file lacks a required column');
  const at = (fields, name) =>
    column.has(name) ? fields[column.get(name)] : undefined;

  /** @type {Map<string, {ms: number, feature: Object}>} */
  const newest = new Map();
  let seen = 0;
  for (let i = headerAt + 1; i < lines.length && seen < MAX_BUOY_ROWS; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    seen++;
    const fields = line.split(/\s+/);
    if (fields.length !== names.length) continue;
    const station = at(fields, 'STN');
    if (!STATION_ID.test(station)) continue;
    const lat = inRange(toNumber(at(fields, 'LAT')), -90, 90);
    const lon = inRange(toNumber(at(fields, 'LON')), -180, 180);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const ms = buoyTime(
      at(fields, 'YYYY'),
      at(fields, 'MM'),
      at(fields, 'DD'),
      at(fields, 'hh'),
      at(fields, 'mm'),
    );
    if (ms === null || nowMs - ms > maxAgeMs || ms - nowMs > BUOY_MAX_FUTURE_MS)
      continue;
    const values = {};
    for (const [fileColumn, property, min, max] of BUOY_FIELDS)
      values[property] = buoyValue(at(fields, fileColumn), min, max);
    if (Object.values(values).every((value) => value === null)) continue;
    const id = station.toUpperCase();
    if (newest.has(id) && newest.get(id).ms >= ms) continue;
    const geometry = { type: 'Point', coordinates: [lon, lat] };
    if (!isValidGeometry(geometry)) continue;
    newest.set(id, {
      ms,
      feature: {
        type: 'Feature',
        id,
        geometry,
        properties: {
          station: id,
          windDir: values.windDir,
          windMs: values.windMs,
          windKt: msToKnots(values.windMs),
          gustMs: values.gustMs,
          gustKt: msToKnots(values.gustMs),
          waveM: values.waveM,
          wavePeriodS: values.wavePeriodS,
          avgPeriodS: values.avgPeriodS,
          waveDir: values.waveDir,
          pressureHpa: values.pressureHpa,
          pressureTrendHpa: values.pressureTrendHpa,
          airC: values.airC,
          waterC: values.waterC,
          dewC: values.dewC,
          visNmi: values.visNmi,
          tideFt: values.tideFt,
          timestamp: new Date(ms).toISOString(),
        },
      },
    });
  }
  if (!newest.size)
    throw invalidPayload('NDBC file has no current station observations');
  return {
    type: 'FeatureCollection',
    features: [...newest.values()].map(({ feature }) => feature),
  };
}

/** The flood category when it is one of the four drawn, else null. */
function floodCategory(value) {
  return FLOOD_CATEGORIES.includes(value) ? value : null;
}

/**
 * A stage (ft) or flow (kcfs) from an NWPS status block. The block carries a
 * primary and a secondary reading, each with its own unit; -999 means none.
 */
function reading(status, unit) {
  for (const [value, valueUnit] of [
    [status?.primary, status?.primaryUnit],
    [status?.secondary, status?.secondaryUnit],
  ]) {
    if (valueUnit !== unit) continue;
    const number = toNumber(value);
    if (number !== null && number !== -999) return number;
  }
  return null;
}

/** An NWPS time as ISO, or null for a missing or placeholder (year 1) time. */
function gaugeTime(value) {
  const iso = toIsoTimestamp(value);
  return iso !== null && Date.parse(iso) >= EARLIEST_VALID_MS ? iso : null;
}

function normalizeGauge(gauge) {
  if (!isObject(gauge) || typeof gauge.lid !== 'string') return null;
  const lid = gauge.lid.trim().toUpperCase();
  if (!GAUGE_ID.test(lid)) return null;
  const observed = isObject(gauge.status?.observed)
    ? gauge.status.observed
    : null;
  const forecast = isObject(gauge.status?.forecast)
    ? gauge.status.forecast
    : null;
  const category = floodCategory(observed?.floodCategory);
  const forecastCategory = floodCategory(forecast?.floodCategory);
  if (!category && !forecastCategory) return null;
  const lat = inRange(toNumber(gauge.latitude), -90, 90);
  const lon = inRange(toNumber(gauge.longitude), -180, 180);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
  const geometry = { type: 'Point', coordinates: [lon, lat] };
  if (!isValidGeometry(geometry)) return null;
  const state = String(gauge.state?.abbreviation ?? '')
    .trim()
    .toUpperCase();
  const name =
    typeof gauge.name === 'string' ? gauge.name.trim().slice(0, MAX_NAME) : '';
  return {
    type: 'Feature',
    id: lid,
    geometry,
    properties: {
      gauge: lid,
      name: name || lid,
      state: STATE_CODE.test(state) ? state : null,
      category,
      forecastCategory,
      stageFt: inRange(reading(observed, 'ft'), -1000, 20000),
      flowKcfs: inRange(reading(observed, 'kcfs'), 0, 5000),
      forecastStageFt: inRange(reading(forecast, 'ft'), -1000, 20000),
      timestamp: gaugeTime(observed?.validTime),
    },
  };
}

/**
 * Normalize NWPS gauge-list responses (one per bounding-box tile) into one
 * point per gauge at or above its action stage.
 *
 * A gauge is kept when its observed or its forecast flood category is
 * `action`, `minor`, `moderate` or `major`; `no_flooding`, `low_threshold`,
 * `not_defined`, `obs_not_current`, `out_of_service` and `fcst_not_current`
 * are not drawn. A gauge listed in two tiles is kept once; one without a
 * usable position (NWPS publishes some at 0,0) is skipped. Stage is feet and
 * flow is thousands of cubic feet per second, `null` where NWPS reports -999
 * or a different unit. Feature id = the NWS location id (for example
 * `ASTF1`).
 *
 * No gauge at or above action stage is a legitimate answer and returns an
 * empty collection, but only when the tiles together still list at least
 * `minGauges` gauges: a service that answers every tile with an empty list
 * must not become an empty map.
 * @param {Array<{gauges: Array<Object>}>} tiles
 * @param {{minGauges?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws {Error & {code: 'invalid_payload'}} When there is no tile, a tile is
 *   not an object with a `gauges` array, or fewer than `minGauges` are listed.
 */
export function normalizeGauges(tiles, { minGauges = MIN_GAUGES_LISTED } = {}) {
  if (!Array.isArray(tiles) || !tiles.length)
    throw invalidPayload('NWPS returned no tiles');
  const byLid = new Map();
  const listed = new Set();
  for (const tile of tiles) {
    if (!isObject(tile) || !Array.isArray(tile.gauges))
      throw invalidPayload('NWPS tile has no gauges list');
    for (const gauge of tile.gauges.slice(0, MAX_GAUGES_PER_TILE)) {
      if (typeof gauge?.lid === 'string') listed.add(gauge.lid);
      const feature = normalizeGauge(gauge);
      if (feature && !byLid.has(feature.id)) byLid.set(feature.id, feature);
    }
  }
  if (listed.size < minGauges)
    throw invalidPayload('NWPS listed too few gauges to trust');
  return { type: 'FeatureCollection', features: [...byLid.values()] };
}

/**
 * Rank of a flood category: 0 for none, 1 action … 4 major.
 * @param {?string} category
 * @returns {number}
 */
export function floodRank(category) {
  return FLOOD_CATEGORIES.indexOf(category) + 1;
}
