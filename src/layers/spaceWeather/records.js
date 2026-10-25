/**
 * Normalizers for the Aurora & Space Weather layer: the NOAA SWPC OVATION
 * aurora nowcast (a 1-degree grid of aurora probability) and the NOAA
 * planetary K-index (Kp). Pure and portable — the server proxy
 * (server/providers/spaceWeather.js) and tests import them.
 *
 * Aurora: the upstream grid has 65,160 cells; the ones at or above
 * `AURORA_MIN_PROBABILITY` are grouped into probability bands and traced into
 * polygons (see `traceCells`), so a quiet night is a few thousand bytes and a
 * severe storm stays well under half a megabyte. Kp: not geographic, so it
 * produces no features; the latest value rides in the subsource `details`
 * (the kit copies them into `metadata.sources[]`) and `spaceWeatherFromMetadata`
 * reads it back on the client.
 * @module layers/spaceWeather/records
 */
import { toIsoTimestamp } from '../common/geojson.js';

export const SPACE_WEATHER_LAYER_ID = 'space-weather';

/** NOAA SWPC OVATION aurora nowcast: `[longitude 0..359, latitude, probability %]`. */
export const AURORA_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

/** NOAA SWPC planetary K-index, one row per 3-hour interval. */
export const KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

/** Cells below this aurora probability (percent) are dropped. */
export const AURORA_MIN_PROBABILITY = 10;

/**
 * Probability bands, faintest first: `min` inclusive, `max` exclusive (null =
 * no upper bound). The first band's `min` is the minimum probability.
 */
export const AURORA_BANDS = Object.freeze([
  Object.freeze({ min: AURORA_MIN_PROBABILITY, max: 20 }),
  Object.freeze({ min: 20, max: 40 }),
  Object.freeze({ min: 40, max: 60 }),
  Object.freeze({ min: 60, max: null }),
]);

/**
 * Bands are traced per block of this many degrees of longitude, so no polygon
 * spans more than a quarter of the globe (Cesium triangulates large and
 * pole-encircling ground polygons unreliably, and the grid is cut at the
 * antimeridian anyway).
 */
export const AURORA_CHUNK_DEGREES = 90;

/**
 * Ceiling on polygon vertices in one snapshot (about 400 KB of JSON). A real
 * severe storm needs a few thousand; beyond this the grid is noise (every
 * cell isolated), which is treated as a corrupt payload rather than served.
 */
export const AURORA_MAX_VERTICES = 25_000;

const CHUNK_COUNT = 360 / AURORA_CHUNK_DEGREES;
const NORTH = 'north';
const SOUTH = 'south';

/** Error for a corrupt or non-collection payload; never cached (keylessFeed). */
function invalidPayload(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * NOAA geomagnetic storm scale from a Kp value. NOAA's G-scale lists whole
 * Kp values (G1 = 5 … G5 = 9; Kp 9- belongs to G4), and Kp is reported in
 * thirds (5- = 4.67, 5+ = 5.33), so the value rounds to the nearest whole
 * number and 9- (8.67) stays at G4. Below Kp 4.5 there is no storm: 0.
 * @param {number} kp - Planetary K-index, 0-9.
 * @returns {0|1|2|3|4|5} The G level; 0 when there is no storm.
 */
export function kpToGScale(kp) {
  if (!Number.isFinite(kp) || kp < 0) return 0;
  if (kp >= 9) return 5;
  // Whole-Kp rows of NOAA's scale: [Kp, G].
  const table = [
    [5, 1],
    [6, 2],
    [7, 3],
    [8, 4],
  ];
  const whole = Math.min(Math.round(kp), 8);
  return table.find(([level]) => level === whole)?.[1] ?? 0;
}

/**
 * Longitude from the upstream 0..359 range (or -180..179) into -180..180.
 * 180 becomes -180: the same meridian, on the western side of the seam.
 * @param {number} lon - Integer degrees.
 * @returns {number}
 */
export function wrapLongitude(lon) {
  const east = ((lon % 360) + 360) % 360;
  return east >= 180 ? east - 360 : east;
}

/** The band index (into AURORA_BANDS) for a probability, or -1 below the minimum. */
export function auroraBandIndex(probability) {
  if (!(probability >= AURORA_MIN_PROBABILITY)) return -1;
  for (let i = AURORA_BANDS.length - 1; i >= 0; i--)
    if (probability >= AURORA_BANDS[i].min) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// Cell grouping and contour tracing
// ---------------------------------------------------------------------------

// Cells are addressed by integer (x, y) = (longitude, latitude) of the grid
// point. A cell covers x ± 0.5 by y ± 0.5 degrees (clipped at ±180 and ±90),
// and its corners are lattice vertices (i, j) at (i - 0.5, j - 0.5).
const cellKey = (x, y) => (x + 200) * 512 + (y + 200);
const vertexKey = (i, j) => (i + 200) * 512 + (j + 200);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const lonOf = (i) => clamp(i - 0.5, -180, 180);
const latOf = (j) => clamp(j - 0.5, -90, 90);

/**
 * Trace the outline of a set of unit cells.
 *
 * Every cell side that has no neighbor becomes a directed edge with the cell
 * on its left (counter-clockwise around the cell), the edges chain into
 * closed rings, and a ring's winding says whether it is an outer boundary
 * (counter-clockwise) or a hole (clockwise). Cells that touch only at a
 * corner stay separate shapes: at such a vertex a ring always turns left, so
 * rings never cross or touch themselves. Cells are 4-connected into one
 * polygon each; a ring joins the polygon of the cell on its left.
 *
 * Collinear vertices are kept, so every edge is one degree long and a
 * geodesic edge on the globe stays on its parallel to within a fraction of a
 * degree.
 * @param {Set<number>} cells - `cellKey` values.
 * @param {Map<number, {x: number, y: number}>} positions - cellKey → cell.
 * @returns {Array<Array<Array<[number, number]>>>} GeoJSON polygon coordinates.
 */
function traceCells(cells, positions) {
  const ordered = [...cells].sort((a, b) => a - b);
  // Connected components (4-neighborhood).
  const component = new Map();
  let componentCount = 0;
  for (const start of ordered) {
    if (component.has(start)) continue;
    const id = componentCount++;
    const stack = [start];
    component.set(start, id);
    while (stack.length) {
      const { x, y } = positions.get(stack.pop());
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        const key = cellKey(nx, ny);
        if (cells.has(key) && !component.has(key)) {
          component.set(key, id);
          stack.push(key);
        }
      }
    }
  }
  // Boundary edges, interior on the left.
  const edges = [];
  const outgoing = new Map();
  const addEdge = (i, j, di, dj, owner) => {
    const edge = { i, j, di, dj, owner, next: null, used: false };
    edges.push(edge);
    const key = vertexKey(i, j);
    const list = outgoing.get(key);
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  };
  for (const key of ordered) {
    const { x, y } = positions.get(key);
    const owner = component.get(key);
    if (!cells.has(cellKey(x, y - 1))) addEdge(x, y, 1, 0, owner);
    if (!cells.has(cellKey(x + 1, y))) addEdge(x + 1, y, 0, 1, owner);
    if (!cells.has(cellKey(x, y + 1))) addEdge(x + 1, y + 1, -1, 0, owner);
    if (!cells.has(cellKey(x - 1, y))) addEdge(x, y + 1, 0, -1, owner);
  }
  // Pair each edge with the one that follows it: prefer a left turn, then
  // straight on, then a right turn.
  for (const edge of edges) {
    const candidates = outgoing.get(
      vertexKey(edge.i + edge.di, edge.j + edge.dj),
    );
    const heading = [
      [-edge.dj, edge.di],
      [edge.di, edge.dj],
      [edge.dj, -edge.di],
    ];
    for (const [di, dj] of heading) {
      edge.next = candidates?.find((c) => c.di === di && c.dj === dj) ?? null;
      if (edge.next) break;
    }
  }
  const outers = new Map();
  const holes = new Map();
  for (const first of edges) {
    if (first.used) continue;
    const ring = [];
    let area = 0;
    let edge = first;
    do {
      edge.used = true;
      ring.push([lonOf(edge.i), latOf(edge.j)]);
      // Shoelace on lattice coordinates (unit steps, so exact integers).
      area += edge.i * (edge.j + edge.dj) - (edge.i + edge.di) * edge.j;
      edge = edge.next;
    } while (edge && edge !== first);
    ring.push(ring[0]);
    const list = area > 0 ? outers : holes;
    if (!list.has(first.owner)) list.set(first.owner, []);
    list.get(first.owner).push(ring);
  }
  const polygons = [];
  for (const [owner, rings] of [...outers].sort((a, b) => a[0] - b[0]))
    for (const outer of rings)
      polygons.push([outer, ...(holes.get(owner) ?? [])]);
  return polygons;
}

/**
 * Turn the OVATION grid into band polygons.
 *
 * Features are one per (hemisphere, probability band, longitude block):
 * `<hemisphere>-<band min>-<block>`, so a band keeps its ids while it moves
 * and an open click card survives a refresh. Properties: `hemisphere`
 * (`north`/`south`), `band` (lower bound %), `bandMax` (upper bound or null),
 * `probability` (the peak cell, %), `cells`, `observationTime`,
 * `forecastTime` and `timestamp` (= observation time).
 *
 * Entries that are not `[integer lon, integer lat, probability 0-100]` are
 * skipped. A payload with no valid entry, or with more bad entries than good
 * ones, is corrupt (a changed grid must not read as a calm sky).
 * @param {unknown} payload - Parsed ovation_aurora_latest.json.
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: Object}}
 * @throws {Error} `code: 'invalid_payload'` for a corrupt payload.
 */
export function normalizeAurora(payload) {
  if (!isObject(payload) || !Array.isArray(payload.coordinates))
    throw invalidPayload('aurora payload has no coordinates array');
  const observationTime = toIsoTimestamp(payload['Observation Time']);
  const forecastTime = toIsoTimestamp(payload['Forecast Time']);
  let valid = 0;
  let skipped = 0;
  let peak = 0;
  let activeCells = 0;
  /** @type {Map<string, {hemisphere: string, band: number, chunk: number, cells: Set<number>, positions: Map<number, Object>, peak: number, count: number}>} */
  const groups = new Map();
  const seen = new Set();
  const add = (x, y, probability, band) => {
    const hemisphere = y >= 0 ? NORTH : SOUTH;
    const chunk = Math.min(
      CHUNK_COUNT - 1,
      Math.floor((x + 180) / AURORA_CHUNK_DEGREES),
    );
    const id = `${hemisphere}-${AURORA_BANDS[band].min}-${chunk}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        hemisphere,
        band,
        chunk,
        cells: new Set(),
        positions: new Map(),
        peak: 0,
        count: 0,
      };
      groups.set(id, group);
    }
    const key = cellKey(x, y);
    group.cells.add(key);
    group.positions.set(key, { x, y });
    group.peak = Math.max(group.peak, probability);
    group.count = group.cells.size;
  };
  for (const entry of payload.coordinates) {
    const [lon, lat, probability] = Array.isArray(entry) ? entry : [];
    if (
      !Array.isArray(entry) ||
      entry.length !== 3 ||
      !Number.isInteger(lon) ||
      !Number.isInteger(lat) ||
      !Number.isFinite(probability) ||
      lon < -180 ||
      lon >= 360 ||
      lat < -90 ||
      lat > 90 ||
      probability < 0 ||
      probability > 100
    ) {
      skipped++;
      continue;
    }
    const x = wrapLongitude(lon);
    const key = `${x},${lat}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    valid++;
    const band = auroraBandIndex(probability);
    if (band < 0) continue;
    activeCells++;
    peak = Math.max(peak, probability);
    add(x, lat, probability, band);
    // The cell centered on the antimeridian also covers its eastern half.
    if (x === -180) add(180, lat, probability, band);
  }
  if (!valid || skipped > valid)
    throw invalidPayload('aurora grid has too few valid cells');

  const features = [];
  let vertices = 0;
  const sorted = [...groups].sort(([, a], [, b]) => {
    if (a.hemisphere !== b.hemisphere) return a.hemisphere === NORTH ? -1 : 1;
    return a.band - b.band || a.chunk - b.chunk;
  });
  for (const [id, group] of sorted) {
    const polygons = traceCells(group.cells, group.positions);
    for (const polygon of polygons)
      for (const ring of polygon) vertices += ring.length;
    const { min, max } = AURORA_BANDS[group.band];
    features.push({
      type: 'Feature',
      id,
      geometry:
        polygons.length === 1
          ? { type: 'Polygon', coordinates: polygons[0] }
          : { type: 'MultiPolygon', coordinates: polygons },
      properties: {
        hemisphere: group.hemisphere,
        band: min,
        bandMax: max,
        probability: group.peak,
        cells: group.count,
        observationTime,
        forecastTime,
        timestamp: observationTime,
      },
    });
  }
  if (vertices > AURORA_MAX_VERTICES)
    throw invalidPayload('aurora grid is too fragmented to be real');
  return {
    type: 'FeatureCollection',
    features,
    details: {
      observationTime,
      forecastTime,
      activeCells,
      peakProbability: peak,
      skippedCells: skipped,
    },
  };
}

// ---------------------------------------------------------------------------
// Planetary K-index
// ---------------------------------------------------------------------------

/** A Kp reading from a number or a numeric string, or null outside 0-9. */
function kpValue(value) {
  const number =
    typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)
      ? Number(value)
      : value;
  return typeof number === 'number' && number >= 0 && number <= 9
    ? Math.round(number * 100) / 100
    : null;
}

/**
 * Rows of the K-index product as `{time, kp}` records. The product is an
 * array of objects (`time_tag`, `Kp`, …); the older layout was an array of
 * arrays with a header row, which is read as well.
 */
function kpRows(payload) {
  if (!Array.isArray(payload)) return null;
  const rows = [];
  const header = Array.isArray(payload[0]) ? payload[0] : null;
  const timeColumn = header?.indexOf('time_tag') ?? -1;
  const kpColumn = header?.indexOf('Kp') ?? -1;
  if (header && (timeColumn < 0 || kpColumn < 0)) return null;
  for (const row of header ? payload.slice(1) : payload) {
    const time = header ? row?.[timeColumn] : row?.time_tag;
    const kp = header ? row?.[kpColumn] : row?.Kp;
    const iso = toIsoTimestamp(time);
    const value = kpValue(kp);
    if (iso && value !== null) rows.push({ time: iso, kp: value });
  }
  return rows;
}

/**
 * The latest planetary K-index. No features (Kp is global, not a place):
 * `details` carries `kp`, `kpTime` (ISO start of the 3-hour interval the
 * value covers), `gScale` (NOAA G-level, 0 = no storm) and `kpMax24h` (the
 * highest Kp of the 8 latest intervals).
 * @param {unknown} payload - Parsed noaa-planetary-k-index.json.
 * @returns {{type: 'FeatureCollection', features: [], details: Object}}
 * @throws {Error} `code: 'invalid_payload'` when no valid row is present.
 */
export function normalizeKp(payload) {
  const rows = kpRows(payload);
  if (!rows?.length) throw invalidPayload('kp payload has no valid rows');
  rows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latest = rows.at(-1);
  return {
    type: 'FeatureCollection',
    features: [],
    details: {
      kp: latest.kp,
      kpTime: latest.time,
      gScale: kpToGScale(latest.kp),
      kpMax24h: Math.max(...rows.slice(-8).map((row) => row.kp)),
    },
  };
}

/**
 * Read the space-weather summary back from a response's `metadata` (the kit
 * copies each subsource's `details` into `metadata.sources[]`).
 * @param {Object|null} metadata - Response `metadata`.
 * @returns {{kp: number, kpTime: string|null, gScale: number, kpMax24h: number|null, stale: boolean, auroraObservation: string|null, auroraForecast: string|null}|null}
 *   Null when no Kp reading is available.
 */
export function spaceWeatherFromMetadata(metadata) {
  const sources = Array.isArray(metadata?.sources) ? metadata.sources : [];
  const kp = sources.find((entry) => entry?.id === 'kp');
  const aurora = sources.find((entry) => entry?.id === 'aurora');
  const reading = kpValue(kp?.kp);
  if (reading === null) return null;
  return {
    kp: reading,
    kpTime: typeof kp.kpTime === 'string' ? kp.kpTime : null,
    gScale: Number.isInteger(kp.gScale) ? kp.gScale : kpToGScale(reading),
    kpMax24h: kpValue(kp.kpMax24h),
    stale: kp.stale === true,
    auroraObservation:
      typeof aurora?.observationTime === 'string'
        ? aurora.observationTime
        : null,
    auroraForecast:
      typeof aurora?.forecastTime === 'string' ? aurora.forecastTime : null,
  };
}
