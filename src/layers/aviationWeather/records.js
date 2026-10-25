/**
 * Normalizers for the Aviation Weather layer: NOAA Aviation Weather Center
 * (AWC) METARs from the bulk cache file (points colored by flight category)
 * and US and international SIGMET/AIRMET advisories (polygons). Pure and
 * portable — the server proxy (server/providers/aviationWeather.js) and tests
 * import them.
 *
 * METARs come from the gzip CSV cache AWC asks bulk users to read instead of
 * querying by bounding box. The CSV carries the flight category for most
 * stations; where it is missing the category is derived from the reported
 * ceiling and visibility with the FAA thresholds (`deriveFlightCategory`).
 * Advisory polygons are normalized to closed rings with longitudes inside
 * [-180, 180] (the international feed uses 0..360 across the antimeridian).
 * @module layers/aviationWeather/records
 */
import { isValidGeometry, toIsoTimestamp } from '../common/geojson.js';
import { invalidPayload, toNumber } from '../common/normalize.js';

export const AVIATION_WEATHER_LAYER_ID = 'aviation-weather';

/** AWC bulk cache of the latest METAR per station worldwide (gzip CSV). */
export const METAR_CACHE_URL =
  'https://aviationweather.gov/data/cache/metars.cache.csv.gz';

/** AWC US SIGMET and AIRMET advisories as GeoJSON. */
export const SIGMET_URL =
  'https://aviationweather.gov/api/data/airsigmet?format=geojson';

/** AWC international SIGMET advisories as GeoJSON. */
export const ISIGMET_URL =
  'https://aviationweather.gov/api/data/isigmet?format=geojson';

/** Flight categories, best to worst. */
export const FLIGHT_CATEGORIES = Object.freeze(['VFR', 'MVFR', 'IFR', 'LIFR']);

/** Observations older than this are dropped (the cache holds the last ~hour). */
export const METAR_MAX_AGE_MS = 3 * 3_600_000;

const MAX_CSV_ROWS = 50_000;
const MAX_RAW_METAR = 400;
const MAX_RAW_ADVISORY = 1500;
const MAX_WX = 60;
const STATION_ID = /^[A-Z0-9]{2,6}$/;
const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX', 'VV']);

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const inRange = (value, min, max) =>
  value !== null && value >= min && value <= max ? value : null;

/**
 * The FAA flight category for a reported visibility (statute miles) and
 * ceiling (feet AGL; null for no ceiling). The worse of the two wins:
 * LIFR below 500 ft or 1 mi, IFR below 1,000 ft or 3 mi, MVFR up to 3,000 ft
 * or 5 mi, otherwise VFR. Null when the visibility is unknown, because a
 * station that does not report it cannot be called better than its ceiling
 * alone suggests.
 * @param {{visibilityMi: ?number, ceilingFt: ?number}} reading
 * @returns {?('VFR'|'MVFR'|'IFR'|'LIFR')}
 */
export function deriveFlightCategory({ visibilityMi, ceilingFt }) {
  if (!Number.isFinite(visibilityMi)) return null;
  let rank = 0;
  if (visibilityMi < 1) rank = 3;
  else if (visibilityMi < 3) rank = 2;
  else if (visibilityMi <= 5) rank = 1;
  if (Number.isFinite(ceilingFt)) {
    if (ceilingFt < 500) rank = Math.max(rank, 3);
    else if (ceilingFt < 1000) rank = Math.max(rank, 2);
    else if (ceilingFt <= 3000) rank = Math.max(rank, 1);
  }
  return FLIGHT_CATEGORIES[rank];
}

/**
 * Split CSV text into rows of fields (RFC 4180: quoted fields, doubled
 * quotes, CRLF or LF). Stops after `maxRows` rows.
 * @param {string} text
 * @param {number} [maxRows]
 * @returns {string[][]}
 */
export function parseCsv(text, maxRows = MAX_CSV_ROWS + 10) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    // A blank line is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      endRow();
      if (rows.length >= maxRows) return rows;
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** "10+" / "0.5" → {value, plus}, or null. */
function parseVisibility(value) {
  const match = /^(\d{1,3}(?:\.\d+)?)(\+?)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const miles = Number(match[1]);
  return miles <= 100 ? { value: miles, plus: match[2] === '+' } : null;
}

/** Lowest ceiling in feet AGL from the (cover, base) pairs of one report, or null. */
function lowestCeiling(pairs) {
  let ceiling = null;
  for (const [cover, base] of pairs) {
    if (!CEILING_COVERS.has(String(cover).trim().toUpperCase())) continue;
    const feet = inRange(toNumber(base), 0, 60000);
    if (feet !== null && (ceiling === null || feet < ceiling)) ceiling = feet;
  }
  return ceiling;
}

/** Column positions by name; `sky_cover`/`cloud_base_ft_agl` repeat four times. */
function columnIndex(header) {
  const names = new Map();
  const sky = [];
  const base = [];
  header.forEach((name, index) => {
    const key = name.trim();
    if (key === 'sky_cover') sky.push(index);
    else if (key === 'cloud_base_ft_agl') base.push(index);
    else if (!names.has(key)) names.set(key, index);
  });
  return {
    at: (name) => names.get(name),
    layers: sky.map((index, i) => [index, base[i]]).filter(([, b]) => b >= 0),
    has: (name) => names.has(name),
  };
}

const REQUIRED_COLUMNS = Object.freeze([
  'station_id',
  'observation_time',
  'latitude',
  'longitude',
]);

/**
 * Normalize the AWC METAR cache CSV into one point per station.
 *
 * The header row is located by its `raw_text` first column, so notice lines
 * ahead of it are tolerated. A row is skipped when it has no usable station
 * id, observation time or position (non-finite, out of range, or exactly
 * 0,0), or when the observation is older than `maxAgeMs`; a station listed
 * twice keeps its newest observation. Feature id = ICAO station id. The
 * flight category is the CSV's own when it is VFR/MVFR/IFR/LIFR, otherwise
 * derived from ceiling and visibility (null when the visibility is unknown).
 * Optional properties are omitted when the report does not carry them, which
 * keeps the response small (about 5,000 stations).
 * @param {string} csvText
 * @param {{nowMs?: number, maxAgeMs?: number}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws {Error & {code: 'invalid_payload'}} When there is no METAR header, a
 *   required column is missing, or no row yields a station (a format change or
 *   a stale file must not become an empty map).
 */
export function normalizeMetars(
  csvText,
  { nowMs = Date.now(), maxAgeMs = METAR_MAX_AGE_MS } = {},
) {
  if (typeof csvText !== 'string')
    throw invalidPayload('METAR cache is not text');
  const rows = parseCsv(csvText);
  const headerAt = rows.findIndex((row) => row[0]?.trim() === 'raw_text');
  if (headerAt < 0) throw invalidPayload('METAR cache has no header row');
  const columns = columnIndex(rows[headerAt]);
  if (!REQUIRED_COLUMNS.every(columns.has))
    throw invalidPayload('METAR cache is missing a required column');
  const get = (row, name) => {
    const index = columns.at(name);
    return index === undefined ? undefined : row[index];
  };

  const best = new Map();
  for (const row of rows.slice(headerAt + 1)) {
    const station = String(get(row, 'station_id') ?? '')
      .trim()
      .toUpperCase();
    if (!STATION_ID.test(station)) continue;
    const timestamp = toIsoTimestamp(get(row, 'observation_time'));
    if (!timestamp) continue;
    const observedMs = Date.parse(timestamp);
    if (nowMs - observedMs > maxAgeMs) continue;
    const lat = toNumber(get(row, 'latitude'));
    const lon = toNumber(get(row, 'longitude'));
    if (
      lat === null ||
      lon === null ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180 ||
      (lat === 0 && lon === 0)
    )
      continue;
    const previous = best.get(station);
    if (previous && previous.observedMs >= observedMs) continue;

    const visibility = parseVisibility(get(row, 'visibility_statute_mi'));
    const ceiling = lowestCeiling(
      columns.layers.map(([cover, base]) => [row[cover], row[base]]),
    );
    const reported = String(get(row, 'flight_category') ?? '')
      .trim()
      .toUpperCase();
    const category = FLIGHT_CATEGORIES.includes(reported)
      ? reported
      : deriveFlightCategory({
          visibilityMi: visibility?.value ?? null,
          ceilingFt: ceiling,
        });
    const type = String(get(row, 'metar_type') ?? '').trim();
    const properties = {
      station,
      category,
      ...(type === 'SPECI' ? { type: 'SPECI' } : {}),
    };
    const set = (key, value) => {
      if (value !== null && value !== undefined && value !== '')
        properties[key] = value;
    };
    set('wdir', inRange(toNumber(get(row, 'wind_dir_degrees')), 0, 360));
    set('wspd', inRange(toNumber(get(row, 'wind_speed_kt')), 0, 300));
    set('wgst', inRange(toNumber(get(row, 'wind_gust_kt')), 0, 300));
    set('vis', visibility?.value ?? null);
    if (visibility?.plus) properties.visPlus = true;
    set('ceiling', ceiling);
    set('temp', inRange(toNumber(get(row, 'temp_c')), -90, 70));
    set('dew', inRange(toNumber(get(row, 'dewpoint_c')), -90, 70));
    set('altim', inRange(toNumber(get(row, 'altim_in_hg')), 25, 32));
    const wx = String(get(row, 'wx_string') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    set('wx', wx ? wx.slice(0, MAX_WX) : null);
    const raw = String(get(row, 'raw_text') ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    set('raw', raw ? raw.slice(0, MAX_RAW_METAR) : null);
    properties.timestamp = timestamp;
    best.set(station, {
      observedMs,
      feature: {
        type: 'Feature',
        id: station,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties,
      },
    });
  }
  if (!best.size) throw invalidPayload('METAR cache has no usable stations');
  return {
    type: 'FeatureCollection',
    features: [...best.values()].map(({ feature }) => feature),
  };
}

/** Longitude folded into [-180, 180]; null when it is not a number within ±360. */
function wrapLongitude(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= -180 && value <= 180) return value;
  if (value > 180 && value <= 360) return Math.round((value - 360) * 1e6) / 1e6;
  if (value < -180 && value >= -360)
    return Math.round((value + 360) * 1e6) / 1e6;
  return null;
}

/**
 * One polygon ring cleaned for the globe: longitudes folded into
 * [-180, 180], the ring closed when the upstream left it open, and at least
 * three distinct vertices. Null when any vertex is unusable.
 * @param {unknown} ring
 * @returns {?Array<[number, number]>}
 */
export function cleanRing(ring) {
  if (!Array.isArray(ring)) return null;
  const points = [];
  for (const position of ring) {
    if (!Array.isArray(position)) return null;
    const lon = wrapLongitude(position[0]);
    const lat = position[1];
    if (
      lon === null ||
      typeof lat !== 'number' ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90
    )
      return null;
    points.push([lon, lat]);
  }
  if (points.length < 3) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
  const distinct = new Set(points.map(([lon, lat]) => `${lon},${lat}`));
  return distinct.size >= 3 && points.length >= 4 ? points : null;
}

/** A Polygon's rings cleaned, or null when its outer ring is unusable (bad holes are dropped). */
function cleanPolygon(rings) {
  if (!Array.isArray(rings) || !rings.length) return null;
  const outer = cleanRing(rings[0]);
  if (!outer) return null;
  const holes = rings.slice(1).map(cleanRing).filter(Boolean);
  return [outer, ...holes];
}

/** Polygon / MultiPolygon geometry cleaned for the globe, or null. */
function cleanAdvisoryGeometry(geometry) {
  if (!isObject(geometry)) return null;
  let result = null;
  if (geometry.type === 'Polygon') {
    const polygon = cleanPolygon(geometry.coordinates);
    result = polygon && { type: 'Polygon', coordinates: polygon };
  } else if (
    geometry.type === 'MultiPolygon' &&
    Array.isArray(geometry.coordinates)
  ) {
    const polygons = geometry.coordinates.map(cleanPolygon).filter(Boolean);
    result = polygons.length && {
      type: 'MultiPolygon',
      coordinates: polygons,
    };
  }
  return result && isValidGeometry(result) ? result : null;
}

const text = (value, limit) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, limit) : null;
};

const HAZARD_CODE = /^[A-Z][A-Z0-9 /_-]{0,23}$/;

/** Feet from a number or numeric string, 0..100,000, else null. */
const feet = (value) => inRange(toNumber(value), 0, 100000);

/** Compact id fragment from an ISO time ("202610250755"), or "x". */
const timeKey = (iso) => (iso ? iso.replace(/\D/g, '').slice(0, 12) : 'x');

/**
 * Normalize an AWC SIGMET / AIRMET GeoJSON payload into area features.
 *
 * `kind: 'us'` reads the US advisories (`airsigmet`: SIGMET and AIRMET, with
 * `altitudeLow1/2` and `altitudeHi1/2`); `kind: 'international'` reads the
 * ICAO SIGMETs (`isigmet`, with `base`, `top`, `firName` and a hazard
 * qualifier such as SEV or EMBD). Only Polygon and MultiPolygon geometries
 * are kept; their rings are closed and their longitudes folded into
 * [-180, 180]. An advisory whose valid-to time has passed, or with no usable
 * polygon, is skipped. Feature ids combine advisory kind, issuer, series,
 * hazard and valid-from time, with `-2`, `-3` … for exact repeats.
 * An empty collection is a legitimate answer (nothing is in force).
 * @param {unknown} payload - GeoJSON FeatureCollection from AWC.
 * @param {{kind: 'us'|'international', nowMs?: number}} options
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws {Error & {code: 'invalid_payload'}} When the payload is not a FeatureCollection.
 */
export function normalizeSigmets(
  payload,
  { kind = 'us', nowMs = Date.now() } = {},
) {
  if (
    !isObject(payload) ||
    payload.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features)
  )
    throw invalidPayload('SIGMET payload is not a FeatureCollection');
  const international = kind === 'international';
  const used = new Map();
  const features = [];
  for (const feature of payload.features) {
    const p = feature?.properties;
    if (!isObject(p)) continue;
    const hazard = String(p.hazard ?? '')
      .trim()
      .toUpperCase();
    if (!HAZARD_CODE.test(hazard)) continue;
    const geometry = cleanAdvisoryGeometry(feature.geometry);
    if (!geometry) continue;
    const validFrom = toIsoTimestamp(p.validTimeFrom);
    const validTo = toIsoTimestamp(p.validTimeTo);
    if (validTo && Date.parse(validTo) < nowMs) continue;
    const issuer = text(p.icaoId, 8);
    const series = text(p.seriesId, 12);
    const advisory = international
      ? 'sigmet'
      : String(p.airSigmetType ?? '').toUpperCase() === 'AIRMET'
        ? 'airmet'
        : 'sigmet';
    const idBase = [advisory, issuer, series, hazard, timeKey(validFrom)]
      .map((part) => String(part ?? 'x').replace(/[^A-Za-z0-9._]+/g, '_'))
      .join('-');
    const count = (used.get(idBase) ?? 0) + 1;
    used.set(idBase, count);

    const properties = { advisory, hazard };
    const set = (key, value) => {
      if (value !== null && value !== undefined) properties[key] = value;
    };
    if (international) {
      set('qualifier', text(p.qualifier, 60));
      set('fir', text(p.firId, 8));
      set('firName', text(p.firName, 60));
      set('base', feet(p.base));
      set('top', feet(p.top));
      set('change', text(p.chng, 8));
    } else {
      set('severity', inRange(toNumber(p.severity), 0, 9));
      const lows = [feet(p.altitudeLow1), feet(p.altitudeLow2)].filter(
        (value) => value !== null,
      );
      const highs = [feet(p.altitudeHi1), feet(p.altitudeHi2)].filter(
        (value) => value !== null,
      );
      set('base', lows.length ? Math.min(...lows) : null);
      set('top', highs.length ? Math.max(...highs) : null);
    }
    set('issuer', issuer);
    set('series', series);
    set('validFrom', validFrom);
    set('validTo', validTo);
    const raw = String(p.rawSigmet ?? p.rawAirSigmet ?? '')
      .replace(/\r/g, '')
      .trim();
    set('raw', raw ? raw.slice(0, MAX_RAW_ADVISORY) : null);
    properties.timestamp = validFrom;
    features.push({
      type: 'Feature',
      id: count === 1 ? idBase : `${idBase}-${count}`,
      geometry,
      properties,
    });
  }
  return { type: 'FeatureCollection', features };
}
