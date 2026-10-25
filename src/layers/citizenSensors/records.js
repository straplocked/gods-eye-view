/**
 * Normalizers for the Citizen Air & Radiation Sensors layer: Sensor.Community
 * particulate-matter readings, binned to a fixed grid, and Safecast radiation
 * measurements, reduced to the latest reading per device. Pure and portable —
 * the server proxy (server/providers/citizenSensors.js) and tests import them.
 *
 * Sensor.Community (formerly luftdaten) publishes `data.dust.min.json`, the
 * last five minutes of every dust sensor: about 9,500 readings, ~9,000 of them
 * from outdoor locations. Plotting each one would be a ~2.4 MB response, so
 * the layer bins them onto a fixed 0.1 degree grid (about 11 km; 3,900 cells
 * today) and serves the median of each cell. A median, not a mean, because
 * low-cost sensors fail by sticking at an extreme value and one stuck sensor
 * must not recolor a neighborhood. The cell center is served, not any
 * sensor's own position.
 *
 * Safecast serves its measurements through api.safecast.org. The API has no
 * "latest per device" view, so the proxy asks for the last six hours in
 * one-hour slices and this module keeps the newest cpm or µSv/h reading per
 * device. Safecast records counts per minute (cpm) for most detectors and
 * dose rate (µSv/h) for some; a cpm reading is converted at the nominal
 * 334 cpm per µSv/h of Safecast's LND 7318 tube and flagged as an estimate.
 * @module layers/citizenSensors/records
 */

export const CITIZEN_SENSORS_LAYER_ID = 'citizen-sensors';

/** Sensor.Community 5-minute dust readings (JSON, ~4.3 MB, published about every 5 minutes). */
export const SENSOR_COMMUNITY_URL =
  'https://data.sensor.community/static/v2/data.dust.min.json';

/** Safecast measurements endpoint; the proxy adds a time window and a page. */
export const SAFECAST_MEASUREMENTS_URL =
  'https://api.safecast.org/measurements.json';

/** Rows per Safecast page (the largest size the API honors). */
export const SAFECAST_PAGE_SIZE = 1000;

/** Hours of Safecast history requested, newest slice first. */
export const SAFECAST_SLICE_MS = 3_600_000;
export const SAFECAST_SLICES = 6;

/** Grid cells per degree: 10 is a 0.1 degree cell, about 11 km north to south. */
export const AIR_CELLS_PER_DEGREE = 10;

/** A PM reading outside 0..1000 µg/m³ is a faulty sensor, not air. */
export const PM_MAX = 1000;

/** Readings older than this are a sensor that stopped; the file holds the last 5 minutes. */
export const AIR_MAX_AGE_MS = 3 * 3_600_000;
/** Radiation readings older than this are not "recent". */
export const RADIATION_MAX_AGE_MS = 6 * 3_600_000;
/** Timestamps further ahead than this are a clock error. */
const MAX_FUTURE_MS = 3_600_000;

/** Upper bound on served radiation features (newest first). */
export const MAX_RADIATION_FEATURES = 600;
const MAX_AIR_ROWS = 100_000;
const MAX_RADIATION_ROWS = 100_000;

/** Nominal counts per minute per µSv/h of an LND 7318 tube (Safecast bGeigie). */
export const CPM_PER_USV = 334;
/** A dose rate above 1000 µSv/h is a faulty detector, not a reading. */
export const USV_MAX = 1000;

/** Radiation location precision: 3 decimals, about 110 m. */
const RADIATION_COORD_DECIMALS = 3;
/** Readings that name no device are one-per-grid-cell at 0.01 degree. */
const UNNAMED_CELLS_PER_DEGREE = 100;

/**
 * US EPA PM2.5 Air Quality Index breakpoints (24-hour, 2024 revision), worst
 * last: [category, concentration low, concentration high, index low, index
 * high] with concentrations in µg/m³ truncated to 0.1.
 */
export const AQI_BREAKPOINTS = Object.freeze(
  [
    ['good', 0.0, 9.0, 0, 50],
    ['moderate', 9.1, 35.4, 51, 100],
    ['usg', 35.5, 55.4, 101, 150],
    ['unhealthy', 55.5, 125.4, 151, 200],
    ['very-unhealthy', 125.5, 225.4, 201, 300],
    ['hazardous', 225.5, 325.4, 301, 500],
  ].map((row) => Object.freeze(row)),
);

/** AQI category ids, best first. */
export const AQI_CATEGORIES = Object.freeze(
  AQI_BREAKPOINTS.map(([category]) => category),
);

/** Error for a corrupt or non-collection payload; never cached (keylessFeed). */
function invalidPayload(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A finite number from a number or numeric string, else null. */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const inRange = (value, min, max) =>
  value !== null && value >= min && value <= max ? value : null;

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Median of finite numbers, rounded to 0.1 (the mean of the two middle values
 * for an even count).
 * @param {number[]} values
 * @returns {number|null} Null for an empty list.
 */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const value =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return round(value, 1);
}

/**
 * The EPA AQI category of a PM2.5 concentration (µg/m³). The concentration is
 * truncated to 0.1 as the EPA specifies; above the last breakpoint is
 * hazardous.
 * @param {number} pm25
 * @returns {string|null} A value of AQI_CATEGORIES, or null for a non-number or negative.
 */
export function aqiCategory(pm25) {
  if (!Number.isFinite(pm25) || pm25 < 0) return null;
  const c = Math.floor(pm25 * 10 + 1e-9) / 10;
  for (const [category, , high] of AQI_BREAKPOINTS)
    if (c <= high) return category;
  return 'hazardous';
}

/**
 * The EPA AQI (0-500) of a PM2.5 concentration, linear within its category
 * and capped at 500.
 * @param {number} pm25
 * @returns {number|null}
 */
export function aqiFromPm25(pm25) {
  const category = aqiCategory(pm25);
  if (!category) return null;
  const c = Math.floor(pm25 * 10 + 1e-9) / 10;
  const [, low, high, indexLow, indexHigh] = AQI_BREAKPOINTS.find(
    ([id]) => id === category,
  );
  if (c >= high) return indexHigh;
  return Math.round(
    ((indexHigh - indexLow) / (high - low)) * (c - low) + indexLow,
  );
}

/** `YYYY-MM-DD HH:MM:SS` (Sensor.Community, UTC) to epoch ms, or null. */
function sensorCommunityTime(text) {
  const match =
    typeof text === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/.exec(
          text.trim(),
        )
      : null;
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const date = new Date(ms);
  // Date.UTC rolls 31 February over into March: reject any stamp it changed.
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s &&
    y >= 2015
    ? ms
    : null;
}

/** The grid index of a degree value, exact for decimal inputs (no float drift at cell edges). */
function gridIndex(degrees, offset, perDegree, limit) {
  const index = Math.floor(
    Math.round((degrees + offset) * 1e6) / (1e6 / perDegree),
  );
  return Math.min(limit - 1, Math.max(0, index));
}

/** Whether Sensor.Community marks a location as outdoors: an explicit 0 or false. */
const isOutdoor = (indoor) =>
  indoor === 0 || indoor === '0' || indoor === false;

/** The PM values of one Sensor.Community reading, or null if unusable. */
function particulateValues(reading) {
  const values = reading.sensordatavalues;
  if (!Array.isArray(values)) return null;
  let pm25 = null;
  let pm10 = null;
  let sawPm10 = false;
  for (const entry of values) {
    if (!isObject(entry)) continue;
    if (entry.value_type === 'P2') pm25 = toNumber(entry.value);
    else if (entry.value_type === 'P1') {
      sawPm10 = true;
      pm10 = toNumber(entry.value);
    }
  }
  // PM2.5 is what the layer classifies; without it the reading is unusable.
  if (inRange(pm25, 0, PM_MAX) === null) return null;
  // A PM10 channel that is present but impossible marks a faulty sensor.
  if (sawPm10 && inRange(pm10, 0, PM_MAX) === null) return null;
  return { pm25, pm10: sawPm10 ? pm10 : null };
}

/**
 * Normalize the Sensor.Community dust array into grid cells.
 *
 * A reading is dropped unless its location is explicitly outdoor
 * (`indoor: 0`), its coordinates are in range and not exactly 0,0, its time
 * is a real UTC time no older than `maxAgeMs` and no more than an hour ahead
 * of `nowMs`, and it carries PM2.5 (`P2`) between 0 and 1000 µg/m³ (a PM10
 * `P1` channel, when present, must also be in range). A location reported
 * more than once keeps its newest reading. The survivors are binned to
 * 0.1 degree cells; each cell serves the median PM2.5 and PM10, the number of
 * sensors, the EPA AQI category and index of the PM2.5 median, and the newest
 * reading time, at the cell center. Feature id = `<lon index>_<lat index>`.
 * Cells are ordered busiest first so that a feature cap keeps the best
 * covered cells.
 * @param {unknown} readings - The parsed Sensor.Community array.
 * @param {{nowMs?: number, maxAgeMs?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: {sensors: number}}}
 * @throws {Error & {code: 'invalid_payload'}} When the payload is not an array
 *   or no reading survives (a format change must not become an empty map).
 */
export function normalizeAirPm(
  readings,
  { nowMs = Date.now(), maxAgeMs = AIR_MAX_AGE_MS } = {},
) {
  if (!Array.isArray(readings))
    throw invalidPayload('Sensor.Community payload is not an array');
  /** @type {Map<string, {ms: number, id: number, lat: number, lon: number, pm25: number, pm10: number|null}>} */
  const newest = new Map();
  const limit = Math.min(readings.length, MAX_AIR_ROWS);
  for (let i = 0; i < limit; i++) {
    const reading = readings[i];
    const location = reading?.location;
    if (!isObject(reading) || !isObject(location)) continue;
    if (!isOutdoor(location.indoor)) continue;
    const key =
      typeof location.id === 'number' || typeof location.id === 'string'
        ? String(location.id)
        : null;
    if (!key) continue;
    const lat = inRange(toNumber(location.latitude), -90, 90);
    const lon = inRange(toNumber(location.longitude), -180, 180);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const ms = sensorCommunityTime(reading.timestamp);
    if (ms === null || nowMs - ms > maxAgeMs || ms - nowMs > MAX_FUTURE_MS)
      continue;
    const pm = particulateValues(reading);
    if (!pm) continue;
    const id = toNumber(reading.id) ?? 0;
    const previous = newest.get(key);
    if (
      previous &&
      (previous.ms > ms || (previous.ms === ms && previous.id >= id))
    )
      continue;
    newest.set(key, { ms, id, lat, lon, ...pm });
  }

  /** @type {Map<string, {ix: number, iy: number, pm25: number[], pm10: number[], ms: number}>} */
  const cells = new Map();
  for (const sensor of newest.values()) {
    const ix = gridIndex(
      sensor.lon,
      180,
      AIR_CELLS_PER_DEGREE,
      360 * AIR_CELLS_PER_DEGREE,
    );
    const iy = gridIndex(
      sensor.lat,
      90,
      AIR_CELLS_PER_DEGREE,
      180 * AIR_CELLS_PER_DEGREE,
    );
    const id = `${ix}_${iy}`;
    let cell = cells.get(id);
    if (!cell) {
      cell = { ix, iy, pm25: [], pm10: [], ms: 0 };
      cells.set(id, cell);
    }
    cell.pm25.push(sensor.pm25);
    if (sensor.pm10 !== null) cell.pm10.push(sensor.pm10);
    cell.ms = Math.max(cell.ms, sensor.ms);
  }
  if (!cells.size)
    throw invalidPayload(
      'Sensor.Community payload has no usable outdoor reading',
    );

  const features = [...cells.entries()]
    .map(([id, cell]) => {
      const pm25 = median(cell.pm25);
      return {
        type: 'Feature',
        id,
        geometry: {
          type: 'Point',
          coordinates: [
            round((cell.ix + 0.5) / AIR_CELLS_PER_DEGREE - 180, 3),
            round((cell.iy + 0.5) / AIR_CELLS_PER_DEGREE - 90, 3),
          ],
        },
        properties: {
          pm25,
          pm10: median(cell.pm10),
          sensors: cell.pm25.length,
          aqi: aqiFromPm25(pm25),
          category: aqiCategory(pm25),
          timestamp: new Date(cell.ms).toISOString(),
        },
      };
    })
    .sort(
      (a, b) =>
        b.properties.sensors - a.properties.sensors ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return {
    type: 'FeatureCollection',
    features,
    details: { sensors: newest.size },
  };
}

/**
 * The fixed upstream URL for one Safecast page: the measurements captured in
 * `[afterMs, beforeMs]`, oldest first, `page` 1-based.
 * @param {number} afterMs
 * @param {number} beforeMs
 * @param {number} [page=1]
 */
export function safecastUrl(afterMs, beforeMs, page = 1) {
  const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
  return (
    `${SAFECAST_MEASUREMENTS_URL}?captured_after=${stamp(afterMs)}` +
    `&captured_before=${stamp(beforeMs)}&per_page=${SAFECAST_PAGE_SIZE}&page=${page}`
  );
}

/** Epoch ms of a Safecast ISO `captured_at`, or null. */
function safecastTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= Date.UTC(2011, 0, 1) ? ms : null;
}

/** Key of a reading that names no device: its 0.01 degree grid cell. */
function unnamedDeviceKey(lat, lon) {
  const per = UNNAMED_CELLS_PER_DEGREE;
  const ix = gridIndex(lon, 180, per, 360 * per);
  const iy = gridIndex(lat, 90, per, 180 * per);
  return `g${ix}_${iy}`;
}

/**
 * Whether a Safecast reading supersedes another from the same device: later
 * wins; at the same time a µSv/h row beats a cpm row, then the higher row id.
 */
function isNewerReading(candidate, previous) {
  if (candidate.ms !== previous.ms) return candidate.ms > previous.ms;
  if (candidate.unit !== previous.unit) return candidate.unit === 'usv';
  return candidate.rowId > previous.rowId;
}

/**
 * Normalize Safecast measurement rows into one point per device.
 *
 * Only `cpm` and `usv` rows count (the feed also carries temperatures and
 * device status). A row is dropped unless its value is above 0 and plausible
 * (at most 1000 µSv/h, or the same dose at 334 cpm per µSv/h), its position
 * is in range and not exactly 0,0, and its time is a real time no older than
 * `maxAgeMs` nor more than an hour ahead of `nowMs`. A device keeps its newest
 * row (a µSv/h row wins a tie with a cpm row); a row that names no device
 * counts as one device per 0.01 degree cell. A µSv/h row is a dose rate as
 * measured (`usvEstimated: false`); a cpm row is converted at 334 cpm per
 * µSv/h and flagged `usvEstimated: true`, because the true factor depends on
 * the detector. Positions are rounded to 3 decimals (~110 m). The newest
 * `MAX_RADIATION_FEATURES` devices are served. Feature id = `d<device>` or
 * `g<lon index>_<lat index>`; no user identifier is served.
 * @param {unknown} rows - Safecast measurement objects (all pages, any order).
 * @param {{nowMs?: number, maxAgeMs?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: {rows: number}}}
 * @throws {Error & {code: 'invalid_payload'}} When the input is not an array or
 *   no row survives (a silent API change must not become an empty map).
 */
export function normalizeRadiation(
  rows,
  { nowMs = Date.now(), maxAgeMs = RADIATION_MAX_AGE_MS } = {},
) {
  if (!Array.isArray(rows))
    throw invalidPayload('Safecast payload is not an array');
  /** @type {Map<string, Object>} */
  const newest = new Map();
  const limit = Math.min(rows.length, MAX_RADIATION_ROWS);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!isObject(row)) continue;
    const unit = row.unit === 'cpm' || row.unit === 'usv' ? row.unit : null;
    if (!unit) continue;
    const value = toNumber(row.value);
    if (value === null || value <= 0) continue;
    if (value > (unit === 'usv' ? USV_MAX : USV_MAX * CPM_PER_USV)) continue;
    const lat = inRange(toNumber(row.latitude), -90, 90);
    const lon = inRange(toNumber(row.longitude), -180, 180);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const ms = safecastTime(row.captured_at);
    if (ms === null || nowMs - ms > maxAgeMs || ms - nowMs > MAX_FUTURE_MS)
      continue;
    const device =
      Number.isInteger(row.device_id) && row.device_id > 0
        ? row.device_id
        : null;
    const key = device !== null ? `d${device}` : unnamedDeviceKey(lat, lon);
    const candidate = {
      key,
      ms,
      rowId: toNumber(row.id) ?? 0,
      unit,
      value,
      lat,
      lon,
      device,
    };
    const previous = newest.get(key);
    if (previous && !isNewerReading(candidate, previous)) continue;
    newest.set(key, candidate);
  }
  if (!newest.size)
    throw invalidPayload('Safecast payload has no usable recent reading');

  const features = [...newest.values()]
    .sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, MAX_RADIATION_FEATURES)
    .map((entry) => ({
      type: 'Feature',
      id: entry.key,
      geometry: {
        type: 'Point',
        coordinates: [
          round(entry.lon, RADIATION_COORD_DECIMALS),
          round(entry.lat, RADIATION_COORD_DECIMALS),
        ],
      },
      properties: {
        device: entry.device,
        unit: entry.unit,
        cpm: entry.unit === 'cpm' ? entry.value : null,
        usv:
          entry.unit === 'usv'
            ? round(entry.value, 3)
            : round(entry.value / CPM_PER_USV, 3),
        usvEstimated: entry.unit === 'cpm',
        timestamp: new Date(entry.ms).toISOString(),
      },
    }));
  return {
    type: 'FeatureCollection',
    features,
    details: { rows: Math.min(rows.length, MAX_RADIATION_ROWS) },
  };
}
