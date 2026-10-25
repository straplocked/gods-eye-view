/**
 * Normalizers for the Airspace Restrictions & Airport Delays layer. Pure and
 * portable — the server proxy (server/providers/airspace.js) and tests import
 * them.
 *
 * TFRs: the FAA's TFR list (`exportTfrList`) names every current Temporary
 * Flight Restriction but carries no geometry. The geometry is in the keyless
 * per-NOTAM XNOTAM download (`/download/detail_<notam>.xml`), which holds, per
 * restricted area, the polygon (`abdMergedArea`, arcs already flattened by the
 * FAA), the original shapes (circles with a radius in nautical miles, arcs,
 * vertex lists) and the altitude limits. `normalizeTfrDetail` prefers the
 * FAA's merged polygon and falls back to building one from the shapes
 * (`circleRing`, `arcPoints`). Nationwide notices and the border TFRs carry no
 * geometry and produce no feature.
 *
 * Delays: the FAA NAS Status feed (`airport-status-information`, XML) lists
 * airports with ground stops, ground delay programs, arrival/departure delays
 * and closures but gives FAA airport identifiers only; the proxy resolves them
 * to coordinates through the keyless AWC airport lookup. One point per
 * airport carries every active program.
 * @module layers/airspace/records
 */
import { isValidPosition, toIsoTimestamp } from '../common/geojson.js';
import {
  childText,
  childrenNamed,
  descendantsNamed,
  firstChild,
  parseXml,
} from './xml.js';
import { invalidPayload, toNumber } from '../common/normalize.js';

export const AIRSPACE_LAYER_ID = 'airspace';

/** FAA list of current TFRs (JSON, no geometry). */
export const TFR_LIST_URL = 'https://tfr.faa.gov/tfrapi/exportTfrList';

/** FAA NAS Status airport status (XML; DTD at nasstatus.faa.gov/AirportStatus.dtd). */
export const FAA_STATUS_URL =
  'https://nasstatus.faa.gov/api/airport-status-information';

/** NOAA AWC airport lookup, queried by ICAO id (`?ids=KJFK,KEWR&format=json`). */
export const AIRPORT_LOOKUP_URL =
  'https://aviationweather.gov/api/data/airport';

/** The FAA's public NAS status page (card link for delays). */
export const NAS_STATUS_PAGE = 'https://nasstatus.faa.gov/';

/** A TFR list NOTAM id, "6/2117": year digit, slash, sequence. */
const NOTAM_ID = /^\d{1,2}\/\d{1,6}$/;

/** URL of the per-NOTAM XNOTAM download. Throws for anything but a NOTAM id. */
export function tfrDetailUrl(notamId) {
  if (!NOTAM_ID.test(notamId)) throw new TypeError('invalid NOTAM id');
  return `https://tfr.faa.gov/download/detail_${notamId.replace('/', '_')}.xml`;
}

/** The FAA TFR site's page for one NOTAM (card link). */
export function tfrPageUrl(notamId) {
  if (!NOTAM_ID.test(notamId)) throw new TypeError('invalid NOTAM id');
  return `https://tfr.faa.gov/tfr3/?page=detail_${notamId.replace('/', '_')}`;
}

/** Most TFRs the proxy will resolve in one refresh (the list holds ~80). */
export const MAX_TFRS = 300;

/** Airports per AWC lookup request. */
export const AIRPORT_LOOKUP_CHUNK = 40;

const MAX_TEXT = 400;
const MAX_DESCRIPTION = 160;
const MAX_REASON = 240;
const MAX_NAME = 80;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Collapse whitespace and cap the length; '' stays ''. */
function clip(value, limit) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

const round5 = (value) => Math.round(value * 1e5) / 1e5;

// ---------------------------------------------------------------------------
// Great-circle geometry
// ---------------------------------------------------------------------------

/** Mean Earth radius, metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Metres in a nautical mile. */
export const NAUTICAL_MILE_M = 1852;

const RAD = Math.PI / 180;

/** Longitude folded into [-180, 180]. */
function foldLongitude(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * The point reached from a start by travelling a distance along a bearing
 * on the sphere.
 * @param {number} lon - Degrees.
 * @param {number} lat - Degrees.
 * @param {number} bearing - Degrees clockwise from north.
 * @param {number} meters
 * @returns {[number, number]} `[lon, lat]`.
 */
export function destinationPoint(lon, lat, bearing, meters) {
  const d = meters / EARTH_RADIUS_M;
  const b = bearing * RAD;
  const phi1 = lat * RAD;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(b),
  );
  const lambda2 =
    lon * RAD +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2),
    );
  return [foldLongitude(lambda2 / RAD), phi2 / RAD];
}

/** Initial great-circle bearing from point 1 to point 2, degrees in [0, 360). */
export function initialBearing(lon1, lat1, lon2, lat2) {
  const phi1 = lat1 * RAD;
  const phi2 = lat2 * RAD;
  const dLambda = (lon2 - lon1) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(lon1, lat1, lon2, lat2) {
  const dPhi = (lat2 - lat1) * RAD;
  const dLambda = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Edge length used for circles: one vertex every 10 degrees of bearing. */
export const CIRCLE_STEPS = 36;

/**
 * A circle as a polygon ring: `steps` vertices at equal bearings from north,
 * each exactly `radiusMeters` from the center, plus the closing vertex.
 * @param {number} lon - Center, degrees.
 * @param {number} lat - Center, degrees.
 * @param {number} radiusMeters
 * @param {number} [steps]
 * @returns {Array<[number, number]>} Closed ring (first position repeated last).
 */
export function circleRing(lon, lat, radiusMeters, steps = CIRCLE_STEPS) {
  const ring = [];
  for (let k = 0; k < steps; k++)
    ring.push(destinationPoint(lon, lat, (360 * k) / steps, radiusMeters));
  ring.push(ring[0]);
  return ring;
}

/** Radius in a unit the XNOTAM uses, as metres; null for an unknown unit. */
export function radiusToMeters(value, unit) {
  const number = toNumber(value);
  if (number === null || number <= 0) return null;
  switch (String(unit ?? 'NM').toUpperCase()) {
    case 'NM':
      return number * NAUTICAL_MILE_M;
    case 'KM':
      return number * 1000;
    case 'M':
      return number;
    case 'FT':
      return number * 0.3048;
    case 'SM':
      return number * 1609.344;
    default:
      return null;
  }
}

/**
 * The vertices strictly between the two ends of an arc about a center, at
 * most 10 degrees apart. The arc runs clockwise (`CWA`) or counter-clockwise
 * (`CCA`) seen from above; ends that coincide make a full circle.
 * @param {{lon: number, lat: number}} center
 * @param {number} radiusMeters
 * @param {[number, number]} from - Arc start `[lon, lat]`.
 * @param {[number, number]} to - Arc end `[lon, lat]`.
 * @param {boolean} clockwise
 * @returns {Array<[number, number]>} Interior vertices only.
 */
export function arcPoints(center, radiusMeters, from, to, clockwise) {
  const start = initialBearing(center.lon, center.lat, from[0], from[1]);
  const end = initialBearing(center.lon, center.lat, to[0], to[1]);
  let sweep = clockwise ? end - start : start - end;
  sweep = ((sweep % 360) + 360) % 360;
  if (sweep < 1e-6) sweep = 360;
  const segments = Math.max(1, Math.ceil(sweep / 10));
  const points = [];
  for (let k = 1; k < segments; k++) {
    const offset = (sweep * k) / segments;
    points.push(
      destinationPoint(
        center.lon,
        center.lat,
        start + (clockwise ? offset : -offset),
        radiusMeters,
      ),
    );
  }
  return points;
}

/** Signed shoelace area in degree²: positive for counter-clockwise rings. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++)
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
}

/**
 * Turn raw vertices into a valid GeoJSON ring: rounded to ~1 m, consecutive
 * duplicates dropped, closed, counter-clockwise (RFC 7946). Null when it is
 * degenerate (under three distinct vertices, zero area), has an invalid
 * position, or an edge jumps more than 180 degrees of longitude (a shape
 * across the antimeridian, which this layer does not draw).
 * @param {Array<[number, number]>} points
 * @returns {?Array<[number, number]>}
 */
export function finishRing(points) {
  const ring = [];
  for (const [lon, lat] of points) {
    const position = [round5(lon), round5(lat)];
    const last = ring.at(-1);
    if (!last || last[0] !== position[0] || last[1] !== position[1])
      ring.push(position);
  }
  if (
    ring.length > 1 &&
    ring[0][0] === ring.at(-1)[0] &&
    ring[0][1] === ring.at(-1)[1]
  )
    ring.pop();
  if (ring.length < 3 || !ring.every(isValidPosition)) return null;
  const closed = [...ring, ring[0]];
  for (let i = 0; i < closed.length - 1; i++)
    if (Math.abs(closed[i + 1][0] - closed[i][0]) > 180) return null;
  const area = signedArea(closed);
  if (Math.abs(area) < 1e-12) return null;
  return area < 0 ? closed.reverse() : closed;
}

// ---------------------------------------------------------------------------
// TFR list
// ---------------------------------------------------------------------------

/**
 * TFR categories the FAA list names in `type`, with the slug used by the
 * layer. Anything else is `other`.
 */
const TFR_TYPE_CATEGORIES = Object.freeze({
  VIP: 'vip',
  SECURITY: 'security',
  HAZARDS: 'hazards',
  'AIR SHOWS/SPORTS': 'airshow',
  'UAS PUBLIC GATHERING': 'uas',
  'SPACE OPERATIONS': 'space',
  SPECIAL: 'special',
});

/** The category slugs, in legend order. */
export const TFR_CATEGORIES = Object.freeze([
  'vip',
  'security',
  'hazards',
  'airshow',
  'uas',
  'space',
  'special',
  'other',
]);

/** Category slug for a list `type` (own keys only). */
export function tfrCategory(type) {
  const key = String(type ?? '')
    .trim()
    .toUpperCase();
  return Object.hasOwn(TFR_TYPE_CATEGORIES, key)
    ? TFR_TYPE_CATEGORIES[key]
    : 'other';
}

/**
 * Normalize the `exportTfrList` JSON into list entries.
 *
 * An entry without a usable NOTAM id is skipped (the id is spliced into the
 * detail URL, so only `<digits>/<digits>` is accepted); a repeated id keeps
 * its first occurrence.
 * @param {unknown} payload - The parsed JSON array.
 * @param {{max?: number}} [options]
 * @returns {Array<{notamId: string, type: string, category: string, facility: string, state: string, description: string, created: string}>}
 * @throws {Error & {code: 'invalid_payload'}} When the payload is not an array.
 */
export function normalizeTfrList(payload, { max = MAX_TFRS } = {}) {
  if (!Array.isArray(payload)) throw invalidPayload('TFR list is not an array');
  const entries = [];
  const seen = new Set();
  for (const item of payload) {
    if (!isObject(item)) continue;
    const notamId =
      typeof item.notam_id === 'string' ? item.notam_id.trim() : '';
    if (!NOTAM_ID.test(notamId) || seen.has(notamId)) continue;
    seen.add(notamId);
    const type = clip(item.type, 40);
    entries.push({
      notamId,
      type,
      category: tfrCategory(type),
      facility: clip(item.facility, 8),
      state: clip(item.state, 8),
      description: clip(item.description, MAX_DESCRIPTION),
      created: clip(item.creation_date, 20),
    });
    if (entries.length >= max) break;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// TFR detail (XNOTAM)
// ---------------------------------------------------------------------------

/** Offsets from UTC, hours, for the zone abbreviations the XNOTAM uses. */
const ZONE_OFFSET_HOURS = Object.freeze({
  UTC: 0,
  GMT: 0,
  Z: 0,
  EDT: -4,
  EST: -5,
  CDT: -5,
  CST: -6,
  MDT: -6,
  MST: -7,
  PDT: -7,
  PST: -8,
  AKDT: -8,
  AKST: -9,
  HDT: -9,
  HST: -10,
  ADT: -3,
  AST: -4,
  SST: -11,
  GUAM: 10,
  CHST: 10,
});

/**
 * An XNOTAM local timestamp ("2026-10-25T13:00:00") in its zone abbreviation
 * as ISO-8601 UTC. Null for a malformed time or a zone this table does not
 * know (a wrong guess would put the restriction hours off).
 * @param {string} text
 * @param {string} zone
 * @returns {?string}
 */
export function xnotamTime(text, zone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    String(text ?? '').trim(),
  );
  const key = String(zone ?? 'UTC')
    .trim()
    .toUpperCase();
  if (!match || !Object.hasOwn(ZONE_OFFSET_HOURS, key)) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const ms =
    Date.UTC(+year, +month - 1, +day, +hour, +minute, +second) -
    ZONE_OFFSET_HOURS[key] * 3_600_000;
  return toIsoTimestamp(ms);
}

/** "37.45527778N" / "107.13W" / "-107.13" → signed degrees within `limit`, else null. */
export function parseXnotamCoordinate(text, limit) {
  const match = /^([+-]?\d+(?:\.\d+)?)\s*([NSEW]?)$/i.exec(
    String(text ?? '').trim(),
  );
  if (!match) return null;
  let value = Number(match[1]);
  const hemisphere = match[2].toUpperCase();
  if (hemisphere === 'S' || hemisphere === 'W') value = -Math.abs(value);
  if (!Number.isFinite(value) || Math.abs(value) > limit) return null;
  return value;
}

/**
 * Read one `<Avx>` vertex element: its type, position, and the radius
 * (`valRadiusArc`) and arc center (`geoLatArc`/`geoLongArc`) of a circle or arc.
 */
function readVertex(avx) {
  const arcLon = parseXnotamCoordinate(childText(avx, 'geoLongArc'), 180);
  const arcLat = parseXnotamCoordinate(childText(avx, 'geoLatArc'), 90);
  return {
    type: childText(avx, 'codeType').toUpperCase(),
    lon: parseXnotamCoordinate(childText(avx, 'geoLong'), 180),
    lat: parseXnotamCoordinate(childText(avx, 'geoLat'), 90),
    arcCenter:
      arcLon !== null && arcLat !== null ? { lon: arcLon, lat: arcLat } : null,
    radiusMeters: radiusToMeters(
      childText(avx, 'valRadiusArc'),
      childText(avx, 'uomRadiusArc'),
    ),
  };
}

/**
 * Build one polygon ring from the `<Avx>` vertices of a shape or merged
 * area. Supported vertex types: `GRC`/`RHL` (a position), `CIR` (a circle
 * about the position with `valRadiusArc`), and `CWA`/`CCA` (a clockwise or
 * counter-clockwise arc about `geoLatArc`/`geoLongArc`, from the previous
 * vertex to the next one). Anything else (e.g. `FNT`, the national border)
 * cannot be drawn: the shape is dropped.
 * @param {Array<Object>} avxElements - Parsed `<Avx>` elements.
 * @returns {?Array<[number, number]>} A finished ring, or null.
 */
export function ringFromVertices(avxElements) {
  const vertices = avxElements.map(readVertex);
  if (!vertices.length) return null;
  if (vertices.length === 1 && vertices[0].type === 'CIR') {
    const [{ lon, lat, arcCenter, radiusMeters }] = vertices;
    const centerLon = lon ?? arcCenter?.lon ?? null;
    const centerLat = lat ?? arcCenter?.lat ?? null;
    if (centerLon === null || centerLat === null || !radiusMeters) return null;
    return finishRing(circleRing(centerLon, centerLat, radiusMeters));
  }
  const points = [];
  for (let i = 0; i < vertices.length; i++) {
    const vertex = vertices[i];
    if (vertex.type === 'GRC' || vertex.type === 'RHL') {
      if (vertex.lon === null || vertex.lat === null) return null;
      points.push([vertex.lon, vertex.lat]);
    } else if (vertex.type === 'CWA' || vertex.type === 'CCA') {
      const start = points.at(-1);
      const next = vertices[(i + 1) % vertices.length];
      if (
        !start ||
        !vertex.arcCenter ||
        !vertex.radiusMeters ||
        !['GRC', 'RHL'].includes(next.type) ||
        next.lon === null ||
        next.lat === null
      )
        return null;
      points.push(
        ...arcPoints(
          vertex.arcCenter,
          vertex.radiusMeters,
          start,
          [next.lon, next.lat],
          vertex.type === 'CWA',
        ),
      );
    } else return null;
  }
  return finishRing(points);
}

/**
 * Geometry of one `<TFRAreaGroup>`: the FAA's merged polygon when it reads,
 * otherwise a polygon (or MultiPolygon) built from its original shapes.
 * @returns {?{type: 'Polygon'|'MultiPolygon', coordinates: Array}}
 */
function areaGeometry(group) {
  const merged = firstChild(group, 'abdMergedArea');
  const mergedRing = merged
    ? ringFromVertices(childrenNamed(merged, 'Avx'))
    : null;
  if (mergedRing) return { type: 'Polygon', coordinates: [mergedRing] };
  const rings = childrenNamed(group, 'aseShapes')
    .flatMap((shape) => childrenNamed(shape, 'Abd'))
    .map((boundary) => ringFromVertices(childrenNamed(boundary, 'Avx')))
    .filter(Boolean);
  if (!rings.length) return null;
  return rings.length === 1
    ? { type: 'Polygon', coordinates: [rings[0]] }
    : { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
}

/**
 * An altitude limit from an `aseTFRArea`: feet plus the reference it is
 * measured from (`AGL` height above ground, `MSL` altitude, `FL` flight
 * level). `{ft: null}` when absent or meaningless (an upper limit of 0 AGL).
 */
function altitudeLimit(area, side) {
  const value = toNumber(childText(area, `valDistVer${side}`));
  const unit = childText(area, `uomDistVer${side}`).toUpperCase();
  const code = childText(area, `codeDistVer${side}`).toUpperCase();
  if (value === null || value < 0) return { ft: null, ref: null };
  let feet;
  if (unit === 'FL') feet = value * 100;
  else if (unit === 'FT' || unit === '') feet = value;
  else if (unit === 'M') feet = value * 3.28084;
  else return { ft: null, ref: null };
  let ref = null;
  if (unit === 'FL' || code === 'STD') ref = 'FL';
  else if (code === 'HEI') ref = 'AGL';
  else if (code === 'ALT') ref = 'MSL';
  if (side === 'Upper' && feet === 0) return { ft: null, ref: null };
  return { ft: Math.round(feet), ref };
}

/**
 * Normalize one per-NOTAM XNOTAM download into area features.
 *
 * One Polygon/MultiPolygon feature per restricted area (`Area A`, `Area B`
 * …) of the NOTAM, id `<notam>#<n>`; the NOTAM-wide times and text repeat on
 * each. A NOTAM whose areas carry no readable geometry (nationwide notices,
 * the border TFRs) yields `features: []` and `noGeometry: true`.
 * @param {string} xml - The `detail_<notam>.xml` body.
 * @param {{notamId: string, type: string, category: string, facility: string, state: string, description: string, created: string}} entry - The list entry it belongs to.
 * @returns {{features: Array<Object>, noGeometry: boolean}}
 * @throws {Error & {code: 'invalid_payload'}} When the body is not an XNOTAM
 *   document with a notice.
 */
export function normalizeTfrDetail(xml, entry) {
  const root = parseXml(xml);
  const notam = descendantsNamed(root, 'Not')[0];
  if (root.name !== 'XNOTAM-Update' || !notam)
    throw invalidPayload('not an XNOTAM document');
  const uid = firstChild(notam, 'NotUid');
  const tfr = firstChild(notam, 'TfrNot');
  const location = firstChild(notam, 'AffLocGroup');
  const zone = childText(notam, 'codeTimeZone') || 'UTC';
  const expireZone = childText(notam, 'codeExpirationTimeZone') || zone;
  const effective = xnotamTime(childText(notam, 'dateEffective'), zone);
  const expire = xnotamTime(childText(notam, 'dateExpire'), expireZone);
  // The XNOTAM `dateIssued` is UTC (the FAA site prints it as "0246 UTC").
  const issued = xnotamTime(childText(uid, 'dateIssued'), 'UTC');
  const place = [
    childText(location, 'txtNameCity'),
    childText(location, 'txtNameUSState'),
  ]
    .filter(Boolean)
    .join(', ');
  const text = clip(childText(notam, 'txtDescrUSNS'), MAX_TEXT);
  const groups = childrenNamed(tfr, 'TFRAreaGroup');
  const features = [];
  groups.forEach((group, index) => {
    const geometry = areaGeometry(group);
    if (!geometry) return;
    const area = firstChild(group, 'aseTFRArea');
    const lower = altitudeLimit(area, 'Lower');
    const upper = altitudeLimit(area, 'Upper');
    const name = clip(childText(area, 'txtName'), 40);
    features.push({
      type: 'Feature',
      id: `${entry.notamId}#${index + 1}`,
      geometry,
      properties: {
        notam: entry.notamId,
        type: entry.type,
        category: entry.category,
        facility: entry.facility,
        state: entry.state,
        description: entry.description,
        location: clip(place, 80),
        regulation: clip(childText(tfr, 'codeType'), 24),
        area: name || null,
        areaIndex: index + 1,
        areaCount: groups.length,
        lowerFt: lower.ft,
        lowerRef: lower.ref,
        upperFt: upper.ft,
        upperRef: upper.ref,
        scheduled:
          childText(area, 'isScheduledTfrArea').toUpperCase() === 'TRUE',
        effective,
        expire,
        text: text || null,
        link: tfrPageUrl(entry.notamId),
        timestamp: issued,
      },
    });
  });
  return { features, noGeometry: features.length === 0 };
}

/**
 * Whether a TFR feature's expiry has passed. A feature without an expiry
 * (until further notice) never expires here.
 * @param {Object} properties - Feature properties.
 * @param {number} nowMs
 */
export function tfrExpired(properties, nowMs) {
  const expire = Date.parse(properties?.expire);
  return Number.isFinite(expire) && expire <= nowMs;
}

// ---------------------------------------------------------------------------
// NAS Status (airport delays)
// ---------------------------------------------------------------------------

/** Program types, most severe first (see `programSeverity`). */
export const DELAY_TYPES = Object.freeze([
  'ground-stop',
  'ground-delay',
  'arrival-delay',
  'departure-delay',
  'closure',
]);

/**
 * Severity rank of a program type. A ground stop holds departures outright;
 * a ground delay program is metered; arrival and departure delays come next.
 * Closures rank last on purpose: the large majority of entries in the
 * "Airport Closures" list are partial NOTAM closures (a general-aviation
 * restriction, a runway) and must not mask a ground stop at the same airport;
 * the card lists every program anyway.
 */
export function programSeverity(type) {
  const index = DELAY_TYPES.indexOf(type);
  return index < 0 ? 0 : DELAY_TYPES.length - index;
}

/** "1 hour and 30 minutes" / "46 minutes" / "2 hours" → minutes, else null. */
export function parseDelayMinutes(text) {
  const value = String(text ?? '').toLowerCase();
  const hours = /(\d+)\s*h(?:ou)?r/.exec(value);
  const minutes = /(\d+)\s*min/.exec(value);
  if (!hours && !minutes) return null;
  const total = (hours ? +hours[1] * 60 : 0) + (minutes ? +minutes[1] : 0);
  return total <= 24 * 60 ? total : null;
}

const MONTHS = Object.freeze({
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
});

/** The feed's `Update_Time`, "Sun Oct 25 11:07:49 2026 GMT", as ISO UTC, else null. */
export function parseStatusTime(text) {
  const match =
    /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})(?:\s+GMT|\s+UTC)?$/.exec(
      String(text ?? '').trim(),
    );
  if (!match || !Object.hasOwn(MONTHS, match[1].toLowerCase())) return null;
  const [, month, day, hour, minute, second, year] = match;
  return toIsoTimestamp(
    Date.UTC(+year, MONTHS[month.toLowerCase()], +day, +hour, +minute, +second),
  );
}

/**
 * The window a closure's NOTAM text carries: the last token of a NOTAM is
 * `YYMMDDhhmm-YYMMDDhhmm` (UTC), with a full year, which the feed's own
 * "Start"/"Reopen" strings ("May 27 at 18:26 UTC.") lack.
 * @returns {?{start: string, reopen: string}}
 */
export function closureWindowFromNotam(reason) {
  const match = /(\d{10})-(\d{10})\s*$/.exec(String(reason ?? '').trim());
  if (!match) return null;
  const read = (digits) => {
    const [, yy, mm, dd, hh, mi] = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
      digits,
    );
    if (+mm < 1 || +mm > 12 || +dd < 1 || +dd > 31 || +hh > 23 || +mi > 59)
      return null;
    return toIsoTimestamp(Date.UTC(2000 + +yy, +mm - 1, +dd, +hh, +mi));
  };
  const start = read(match[1]);
  const reopen = read(match[2]);
  return start && reopen ? { start, reopen } : null;
}

/**
 * "May 27 at 18:26 UTC." with no year → ISO UTC, taking the year (this one,
 * last or next) that puts the time closest to `nowMs`.
 */
export function parseClosureClock(text, nowMs) {
  const match =
    /^([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})/.exec(
      String(text ?? '').trim(),
    );
  if (!match || !Object.hasOwn(MONTHS, match[1].toLowerCase())) return null;
  const [, month, day, hour, minute] = match;
  const year = new Date(nowMs).getUTCFullYear();
  let best = null;
  for (const candidate of [year - 1, year, year + 1]) {
    const ms = Date.UTC(
      candidate,
      MONTHS[month.toLowerCase()],
      +day,
      +hour,
      +minute,
    );
    if (best === null || Math.abs(ms - nowMs) < Math.abs(best - nowMs))
      best = ms;
  }
  return toIsoTimestamp(best);
}

/** Drop keys whose value is null/undefined/'' so features stay small. */
function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== null && value !== undefined && value !== '',
    ),
  );
}

/** FAA airport identifier: three or four letters/digits. */
const FAA_AIRPORT_ID = /^[A-Z0-9]{3,4}$/;

function programsOf(delayType, nowMs) {
  const programs = [];
  const add = (arpt, program) => {
    const airport = arpt.trim().toUpperCase();
    if (FAA_AIRPORT_ID.test(airport)) programs.push({ airport, ...program });
  };
  for (const list of delayType.children) {
    switch (list.name) {
      case 'Ground_Stop_List':
        for (const item of childrenNamed(list, 'Program'))
          add(
            childText(item, 'ARPT'),
            compact({
              type: 'ground-stop',
              reason: clip(childText(item, 'Reason'), MAX_REASON),
              endTime: clip(childText(item, 'End_Time'), 40),
            }),
          );
        break;
      case 'Ground_Delay_List':
        for (const item of childrenNamed(list, 'Ground_Delay'))
          add(
            childText(item, 'ARPT'),
            compact({
              type: 'ground-delay',
              reason: clip(childText(item, 'Reason'), MAX_REASON),
              avg: parseDelayMinutes(childText(item, 'Avg')),
              max: parseDelayMinutes(childText(item, 'Max')),
            }),
          );
        break;
      case 'Arrival_Departure_Delay_List':
        for (const item of childrenNamed(list, 'Delay'))
          for (const leg of childrenNamed(item, 'Arrival_Departure')) {
            const kind = String(leg.attrs.Type ?? '').toLowerCase();
            if (kind !== 'arrival' && kind !== 'departure') continue;
            add(
              childText(item, 'ARPT'),
              compact({
                type: `${kind}-delay`,
                reason: clip(childText(item, 'Reason'), MAX_REASON),
                min: parseDelayMinutes(childText(leg, 'Min')),
                max: parseDelayMinutes(childText(leg, 'Max')),
                trend: clip(childText(leg, 'Trend'), 24).toLowerCase(),
              }),
            );
          }
        break;
      case 'Airport_Closure_List':
        for (const item of childrenNamed(list, 'Airport')) {
          const reason = clip(childText(item, 'Reason'), MAX_REASON);
          const span = closureWindowFromNotam(childText(item, 'Reason'));
          add(
            childText(item, 'ARPT'),
            compact({
              type: 'closure',
              reason,
              start:
                span?.start ??
                parseClosureClock(childText(item, 'Start'), nowMs),
              reopen:
                span?.reopen ??
                parseClosureClock(childText(item, 'Reopen'), nowMs),
            }),
          );
        }
        break;
      default:
    }
  }
  return programs;
}

/**
 * Normalize the NAS Status XML into airports with their programs.
 *
 * Ground stops, ground delay programs, arrival/departure delays and airport
 * closures are read; the CTOP and airspace-flow lists (flow-control areas, no
 * airport) are ignored. Programs are grouped per FAA airport identifier and
 * sorted most severe first. An airport list that is simply empty ("no delays")
 * is a valid, empty result.
 * @param {string} xml - The feed body.
 * @param {{nowMs?: number}} [options]
 * @returns {{updated: ?string, airports: Array<{airport: string, programs: Array<Object>}>}}
 * @throws {Error & {code: 'invalid_payload'}} When the body is not an
 *   `AIRPORT_STATUS_INFORMATION` document.
 */
export function normalizeFaaStatus(xml, { nowMs = Date.now() } = {}) {
  const root = parseXml(xml);
  if (root.name !== 'AIRPORT_STATUS_INFORMATION')
    throw invalidPayload('not an airport status document');
  const byAirport = new Map();
  for (const delayType of childrenNamed(root, 'Delay_type'))
    for (const { airport, ...program } of programsOf(delayType, nowMs)) {
      if (!byAirport.has(airport)) byAirport.set(airport, []);
      byAirport.get(airport).push(program);
    }
  const airports = [...byAirport].map(([airport, programs]) => ({
    airport,
    programs: programs.sort(
      (a, b) =>
        programSeverity(b.type) - programSeverity(a.type) ||
        (b.max ?? b.avg ?? 0) - (a.max ?? a.avg ?? 0),
    ),
  }));
  return {
    updated: parseStatusTime(childText(root, 'Update_Time')),
    airports,
  };
}

// ---------------------------------------------------------------------------
// Airport coordinates
// ---------------------------------------------------------------------------

/**
 * FAA airport identifiers whose ICAO code is not simply `K` + the FAA code:
 * Alaska, Hawaii, Puerto Rico, the Virgin Islands and the Pacific
 * territories. Every other identifier is looked up as `K<id>`.
 */
export const AIRPORT_ICAO_OVERRIDES = Object.freeze({
  ANC: 'PANC',
  FAI: 'PAFA',
  JNU: 'PAJN',
  SIT: 'PASI',
  KTN: 'PAKT',
  BET: 'PABE',
  OTZ: 'PAOT',
  OME: 'PAOM',
  ADQ: 'PADQ',
  CDV: 'PACV',
  BRW: 'PABR',
  SCC: 'PASC',
  AKN: 'PAKN',
  DLG: 'PADL',
  HOM: 'PAHO',
  ENA: 'PAEN',
  HNL: 'PHNL',
  OGG: 'PHOG',
  KOA: 'PHKO',
  LIH: 'PHLI',
  ITO: 'PHTO',
  MKK: 'PHMK',
  LNY: 'PHNY',
  JHM: 'PHJH',
  MUE: 'PHMU',
  SJU: 'TJSJ',
  BQN: 'TJBQ',
  PSE: 'TJPS',
  MAZ: 'TJMZ',
  STT: 'TIST',
  STX: 'TISX',
  GUM: 'PGUM',
  SPN: 'PGSN',
  GSN: 'PGSN',
  TNI: 'PGWT',
  ROP: 'PGRO',
  GRO: 'PGRO',
  PPG: 'NSTU',
});

/**
 * The ICAO code to look up for an FAA airport identifier.
 * @param {string} faaId
 * @returns {?string} Null for an identifier that cannot be an airport code.
 */
export function icaoCandidate(faaId) {
  const id = String(faaId ?? '').toUpperCase();
  if (!FAA_AIRPORT_ID.test(id)) return null;
  if (Object.hasOwn(AIRPORT_ICAO_OVERRIDES, id))
    return AIRPORT_ICAO_OVERRIDES[id];
  return id.length === 3 ? `K${id}` : id;
}

/** The AWC lookup URL for a list of ICAO codes. */
export function airportLookupUrl(icaoCodes) {
  const ids = icaoCodes.filter((code) => /^[A-Z0-9]{3,4}$/.test(code));
  if (!ids.length) throw new TypeError('no airport ids to look up');
  return `${AIRPORT_LOOKUP_URL}?ids=${ids.join(',')}&format=json`;
}

/**
 * Normalize an AWC airport lookup response. `null` (HTTP 204: none of the
 * ids is known) is an empty result; an entry with a bad position or code is
 * skipped.
 * @param {unknown} payload - The parsed JSON array, or null.
 * @returns {Array<{icao: string, name: string, lon: number, lat: number}>}
 * @throws {Error & {code: 'invalid_payload'}} For anything but an array or null.
 */
export function normalizeAirportLookup(payload) {
  if (payload === null) return [];
  if (!Array.isArray(payload))
    throw invalidPayload('airport lookup is not an array');
  const airports = [];
  for (const item of payload) {
    if (!isObject(item)) continue;
    const icao = typeof item.icaoId === 'string' ? item.icaoId.trim() : '';
    const lon = toNumber(item.lon);
    const lat = toNumber(item.lat);
    if (!/^[A-Z0-9]{3,4}$/.test(icao) || lon === null || lat === null) continue;
    // The lookup has no coordinates for a few records; 0,0 is that gap.
    if (lon === 0 && lat === 0) continue;
    if (!isValidPosition([lon, lat])) continue;
    airports.push({
      icao,
      name: clip(item.name, MAX_NAME),
      lon: round5(lon),
      lat: round5(lat),
    });
  }
  return airports;
}

/**
 * Join normalized NAS programs to resolved airport coordinates and build the
 * delay features: one Point per airport, flattened from its most severe
 * program, with every program in `programs`.
 * @param {{updated: ?string, airports: Array<{airport: string, programs: Array<Object>}>}} status
 * @param {Map<string, {icao: string, name: string, lon: number, lat: number}>} located - FAA id → airport.
 * @returns {{features: Array<Object>, unresolved: string[]}} Airports without coordinates are listed, not drawn.
 */
export function buildDelayFeatures(status, located) {
  const features = [];
  const unresolved = [];
  for (const { airport, programs } of status.airports) {
    const place = located.get(airport);
    if (!place) {
      unresolved.push(airport);
      continue;
    }
    const [primary] = programs;
    const { type, ...rest } = primary;
    features.push({
      type: 'Feature',
      id: airport,
      geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
      properties: {
        airport,
        icao: place.icao,
        name: place.name || null,
        delayType: type,
        ...rest,
        programCount: programs.length,
        programs,
        link: NAS_STATUS_PAGE,
        timestamp: status.updated,
      },
    });
  }
  return { features, unresolved };
}
