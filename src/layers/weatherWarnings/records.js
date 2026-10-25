/**
 * Normalizers for the Weather & Tsunami Warnings layer: US National Weather
 * Service active alerts (areas, from the alert polygon or from the zones the
 * alert names) and NOAA tsunami.gov bulletins (points). Pure and portable —
 * the server proxy (server/providers/weatherWarnings.js) and tests import
 * them.
 *
 * NWS publishes most alerts without a geometry, only the zone URLs in
 * `affectedZones`. The proxy resolves those zones one by one into a cache
 * (server/providers/nwsZones.js); `normalizeNwsAlerts()` joins alerts with
 * whatever the cache holds and reports the rest as pending.
 * @module layers/weatherWarnings/records
 */
import {
  isClosedRing,
  isValidPosition,
  toIsoTimestamp,
} from '../common/geojson.js';
import { httpsLink, invalidPayload } from '../common/normalize.js';

export const WEATHER_WARNINGS_LAYER_ID = 'weather-warnings';

/** NWS active alerts, actual (not test/exercise) messages only. */
export const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?status=actual';

/** api.weather.gov serves GeoJSON for this media type. */
export const NWS_ACCEPT = 'application/geo+json';

/** NOAA tsunami warning center Atom feeds: Alaska/West Coast and Pacific. */
export const TSUNAMI_FEEDS = Object.freeze([
  Object.freeze({
    center: 'PAAQ',
    url: 'https://www.tsunami.gov/events/xml/PAAQAtom.xml',
  }),
  Object.freeze({
    center: 'PHEB',
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
  }),
]);

/** NWS CAP severities, most severe first. */
export const NWS_SEVERITIES = Object.freeze([
  'Extreme',
  'Severe',
  'Moderate',
  'Minor',
  'Unknown',
]);

/** Tsunami bulletin levels, most severe first. */
export const TSUNAMI_LEVELS = Object.freeze([
  'warning',
  'advisory',
  'watch',
  'information',
]);

/** Zone URLs the proxy may fetch: api.weather.gov zone resources only. */
const NWS_ZONE_URL =
  /^https:\/\/api\.weather\.gov\/zones\/(?:forecast|county|fire|coastal|offshore)\/[A-Z0-9]{5,8}$/;

/** Simplification tolerance (degrees, ~1 km) for cached zone geometry. */
export const NWS_BASE_TOLERANCE = 0.01;

/**
 * Tolerances (degrees) tried in turn until the payload fits its byte target.
 * The last (~11 km) still keeps county-sized zones; coarser would erase them.
 */
const NWS_TOLERANCE_STEPS = Object.freeze([
  NWS_BASE_TOLERANCE,
  0.025,
  0.05,
  0.1,
]);

/** Payload size target for the NWS subsource (bytes of serialized features). */
export const NWS_TARGET_BYTES = 3 * 1024 * 1024;

const MAX_TEXT = 300;
const MAX_ALERTS = 4000;
const TSUNAMI_MAX_AGE_MS = 3 * 24 * 3600 * 1000;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value, max = MAX_TEXT) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** An `http:` weather.gov link read as its https equivalent. */
function upgradeNwsLink(value) {
  if (typeof value !== 'string') return null;
  return httpsLink(value.trim().replace(/^http:\/\//i, 'https://'), [
    'weather.gov',
    'www.weather.gov',
  ]);
}

// ---------------------------------------------------------------------------
// Geometry: polygon extraction and decimation
// ---------------------------------------------------------------------------

/** Squared distance from point p to segment a-b (planar degrees). */
function segmentDistance2(p, a, b) {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  let t = 0;
  if (length2 > 0) {
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
    t = Math.max(0, Math.min(1, t));
  }
  dx = a[0] + t * dx - p[0];
  dy = a[1] + t * dy - p[1];
  return dx * dx + dy * dy;
}

/** Douglas-Peucker over open[from..to]; marks kept indices (iterative). */
function markKept(open, from, to, tolerance2, keep) {
  const stack = [[from, to]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let worst = -1;
    let worstDistance = tolerance2;
    for (let i = start + 1; i < end; i++) {
      const distance = segmentDistance2(open[i], open[start], open[end]);
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
}

const roundTo = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

function ringArea2(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum);
}

/**
 * Simplify one closed ring: Douglas-Peucker at `tolerance` degrees, then
 * round to `decimals` and drop repeated points. The ring is split at the
 * vertex farthest from its start so a closed loop simplifies like a line.
 * @param {Array<Array<number>>} ring - Closed ring of [lon, lat].
 * @param {number} tolerance - Degrees.
 * @param {number} [decimals=3]
 * @returns {Array<Array<number>>|null} A closed ring of >= 4 positions, or
 *   null when the ring collapses (fewer than 3 distinct points, no area).
 */
export function simplifyRing(ring, tolerance, decimals = 3) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  const points = ring.slice(0, -1);
  const open = [...points, points[0]];
  const last = open.length - 1;
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < last; i++) {
    const dx = open[i][0] - open[0][0];
    const dy = open[i][1] - open[0][1];
    const distance = dx * dx + dy * dy;
    if (distance > farDistance) {
      far = i;
      farDistance = distance;
    }
  }
  if (far === 0) return null;
  const keep = new Uint8Array(open.length);
  keep[0] = 1;
  keep[far] = 1;
  keep[last] = 1;
  const tolerance2 = tolerance * tolerance;
  markKept(open, 0, far, tolerance2, keep);
  markKept(open, far, last, tolerance2, keep);
  const out = [];
  for (let i = 0; i < last; i++) {
    if (!keep[i]) continue;
    const point = [
      roundTo(open[i][0], decimals),
      roundTo(open[i][1], decimals),
    ];
    const previous = out[out.length - 1];
    if (previous && previous[0] === point[0] && previous[1] === point[1])
      continue;
    out.push(point);
  }
  while (
    out.length > 1 &&
    out[0][0] === out[out.length - 1][0] &&
    out[0][1] === out[out.length - 1][1]
  )
    out.pop();
  if (out.length < 3 || ringArea2(out) === 0) return null;
  return [...out, [out[0][0], out[0][1]]];
}

function extent(ring) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

/** Whether `rings` is a polygon whose rings are all closed and valid. */
function validRings(rings) {
  return Array.isArray(rings) && rings.length > 0 && rings.every(isClosedRing);
}

/**
 * Every polygon (an array of rings) in a Polygon, MultiPolygon or flat
 * GeometryCollection of them; anything else yields nothing. Polygons with a
 * malformed or out-of-range ring are skipped.
 * @param {unknown} geometry
 * @returns {Array<Array<Array<Array<number>>>>}
 */
export function polygonsOf(geometry) {
  if (!isObject(geometry)) return [];
  switch (geometry.type) {
    case 'Polygon':
      return validRings(geometry.coordinates) ? [geometry.coordinates] : [];
    case 'MultiPolygon':
      return Array.isArray(geometry.coordinates)
        ? geometry.coordinates.filter(validRings)
        : [];
    case 'GeometryCollection':
      return Array.isArray(geometry.geometries)
        ? geometry.geometries.flatMap((child) =>
            child?.type === 'GeometryCollection' ? [] : polygonsOf(child),
          )
        : [];
    default:
      return [];
  }
}

/**
 * Simplify polygons: each ring through `simplifyRing`; holes that collapse or
 * are smaller than the tolerance are dropped, and so are polygons whose outer
 * ring collapses or is smaller than the tolerance (specks of island).
 * @param {Array<Array<Array<Array<number>>>>} polygons
 * @param {number} tolerance - Degrees.
 * @param {number} [decimals=3]
 * @returns {Array<Array<Array<Array<number>>>>}
 */
export function simplifyPolygons(polygons, tolerance, decimals = 3) {
  const simplified = [];
  for (const rings of polygons) {
    const outer = simplifyRing(rings[0], tolerance, decimals);
    if (!outer || extent(outer) < tolerance) continue;
    const holes = rings
      .slice(1)
      .map((hole) => simplifyRing(hole, tolerance, decimals))
      .filter((hole) => hole && extent(hole) >= tolerance);
    simplified.push([outer, ...holes]);
  }
  return simplified;
}

/** A Polygon for one polygon, a MultiPolygon for several, null for none. */
function polygonsGeometry(polygons) {
  if (!polygons.length) return null;
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

// ---------------------------------------------------------------------------
// NWS alerts
// ---------------------------------------------------------------------------

/** Whether a URL is an api.weather.gov zone resource the proxy may fetch. */
export function isNwsZoneUrl(value) {
  return typeof value === 'string' && NWS_ZONE_URL.test(value);
}

/**
 * Normalize one NWS zone resource to simplified polygons for the cache.
 * @param {Object} payload - `GET /zones/<type>/<id>` GeoJSON Feature.
 * @returns {Array<Array<Array<Array<number>>>>|null} Polygons (>= 1), or null
 *   when the zone has no usable area (the proxy remembers that as "gone").
 * @throws When the payload is not a GeoJSON Feature.
 */
export function normalizeNwsZone(payload) {
  if (!isObject(payload) || payload.type !== 'Feature')
    throw invalidPayload('NWS zone payload is not a Feature');
  const polygons = simplifyPolygons(
    polygonsOf(payload.geometry),
    NWS_BASE_TOLERANCE,
  );
  return polygons.length ? polygons : null;
}

function alertFeatures(payload) {
  if (
    !isObject(payload) ||
    payload.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features)
  )
    throw invalidPayload('NWS alerts payload is not a FeatureCollection');
  return payload.features;
}

const severityRank = (severity) => {
  const index = NWS_SEVERITIES.indexOf(severity);
  return index === -1 ? NWS_SEVERITIES.length - 1 : index;
};

function alertId(feature) {
  const id = feature?.properties?.id ?? feature?.id;
  if (typeof id !== 'string' || !id) return null;
  const tail = id.replace(/^https:\/\/api\.weather\.gov\/alerts\//, '');
  return tail && tail.length <= 200 ? tail : null;
}

/** Valid zone URLs of one alert, deduplicated. */
function alertZones(feature) {
  const zones = feature?.properties?.affectedZones;
  return Array.isArray(zones) ? [...new Set(zones.filter(isNwsZoneUrl))] : [];
}

/** Whether an alert is a candidate: has an id, is actual and not yet expired. */
function liveAlert(feature, nowMs) {
  if (!isObject(feature) || !isObject(feature.properties)) return false;
  if (!alertId(feature)) return false;
  const { status, expires, ends } = feature.properties;
  if (status !== undefined && status !== 'Actual') return false;
  const endMs = Date.parse(ends ?? expires);
  return !(Number.isFinite(endMs) && endMs < nowMs);
}

/**
 * Zone URLs the proxy should fetch next: zones of geometry-less live alerts
 * that `needsFetch` says are unknown, most severe alerts first and, within a
 * severity, alerts with the fewest unknown zones first so they complete
 * sooner. Deduplicated.
 * @param {Object} payload - NWS alerts FeatureCollection.
 * @param {(zoneUrl: string) => boolean} needsFetch
 * @param {number} [nowMs=Date.now()]
 * @returns {string[]}
 */
export function nwsZonesToResolve(payload, needsFetch, nowMs = Date.now()) {
  const wanted = [];
  for (const feature of alertFeatures(payload)) {
    if (!liveAlert(feature, nowMs)) continue;
    if (polygonsOf(feature.geometry).length) continue;
    const missing = alertZones(feature).filter(needsFetch);
    if (missing.length)
      wanted.push({
        rank: severityRank(feature.properties.severity),
        missing,
      });
  }
  wanted.sort((a, b) => a.rank - b.rank || a.missing.length - b.missing.length);
  return [...new Set(wanted.flatMap(({ missing }) => missing))];
}

function alertProperties(feature) {
  const p = feature.properties;
  const severity = NWS_SEVERITIES.includes(p.severity) ? p.severity : 'Unknown';
  const timestamp = toIsoTimestamp(p.sent) ?? toIsoTimestamp(p.effective);
  return {
    event: text(p.event, 100) ?? null,
    severity,
    urgency: text(p.urgency, 40),
    certainty: text(p.certainty, 40),
    headline: text(p.headline),
    areaDesc: text(p.areaDesc),
    senderName: text(p.senderName, 100),
    onset: toIsoTimestamp(p.onset) ?? toIsoTimestamp(p.effective),
    expires: toIsoTimestamp(p.ends) ?? toIsoTimestamp(p.expires),
    url: upgradeNwsLink(p.web),
    timestamp,
  };
}

/**
 * Normalize NWS active alerts into one area feature per alert.
 *
 * An alert that carries its own polygon uses it. A geometry-less alert takes
 * the union (a MultiPolygon) of its zones from `zoneLookup`; it is omitted
 * while any of its zones is still unresolved (`undefined`), and reported as
 * pending. Zones the lookup says are gone (`null`) are skipped; an alert
 * left with no area at all is counted as unmapped. Geometry is decimated so
 * the serialized features fit `maxBytes`, coarsening the tolerance step by
 * step and finally dropping the least severe alerts.
 *
 * Feature ids are the CAP alert ids (`urn:oid:…`); the proxy prefixes `nws:`.
 * @param {Object} payload - `GET /alerts/active?status=actual` GeoJSON.
 * @param {Object} options
 * @param {(zoneUrl: string) => Array|null|undefined} options.zoneLookup -
 *   Polygons for a resolved zone, null for a zone without usable area,
 *   undefined for one not resolved yet.
 * @param {number} [options.nowMs=Date.now()] - Alerts already expired are skipped.
 * @param {number} [options.maxBytes=NWS_TARGET_BYTES]
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: {alerts: number, pendingAlerts: number, pendingZones: number, unmappedAlerts: number, tolerance: number}}}
 * @throws When the payload is not a FeatureCollection.
 */
export function normalizeNwsAlerts(
  payload,
  { zoneLookup, nowMs = Date.now(), maxBytes = NWS_TARGET_BYTES } = {},
) {
  const source = alertFeatures(payload);
  const seen = new Set();
  const candidates = [];
  let pendingAlerts = 0;
  let unmappedAlerts = 0;
  const pendingZones = new Set();
  for (const feature of source.slice(0, MAX_ALERTS)) {
    if (!liveAlert(feature, nowMs)) continue;
    const id = alertId(feature);
    if (seen.has(id)) continue;
    seen.add(id);
    const own = polygonsOf(feature.geometry);
    if (own.length) {
      candidates.push({ feature, id, polygons: own, own: true });
      continue;
    }
    const zones = alertZones(feature);
    const resolved = zones.map((zone) => [zone, zoneLookup?.(zone)]);
    const pending = resolved.filter(([, polygons]) => polygons === undefined);
    if (pending.length) {
      pendingAlerts += 1;
      for (const [zone] of pending) pendingZones.add(zone);
      continue;
    }
    const polygons = resolved.flatMap(([, zonePolygons]) => zonePolygons || []);
    if (!polygons.length) {
      unmappedAlerts += 1;
      continue;
    }
    candidates.push({ feature, id, polygons, own: false });
  }
  candidates.sort(
    (a, b) =>
      severityRank(a.feature.properties.severity) -
      severityRank(b.feature.properties.severity),
  );

  /** Features at one tolerance; zone simplification is shared by alerts. */
  const build = (tolerance) => {
    const memo = new Map();
    const features = [];
    for (const { feature, id, polygons, own } of candidates) {
      let simplified;
      if (own) simplified = simplifyPolygons(polygons, tolerance / 4);
      else {
        simplified = [];
        for (const zoneUrl of alertZones(feature)) {
          const zonePolygons = zoneLookup?.(zoneUrl);
          if (!zonePolygons) continue;
          if (!memo.has(zoneUrl))
            memo.set(
              zoneUrl,
              tolerance <= NWS_BASE_TOLERANCE
                ? zonePolygons
                : simplifyPolygons(zonePolygons, tolerance),
            );
          simplified.push(...memo.get(zoneUrl));
        }
      }
      const geometry = polygonsGeometry(simplified);
      if (!geometry) continue;
      features.push({
        type: 'Feature',
        id,
        geometry,
        properties: alertProperties(feature),
      });
    }
    return features;
  };

  let tolerance = NWS_TOLERANCE_STEPS[0];
  let features = build(tolerance);
  let bytes = JSON.stringify(features).length;
  for (const step of NWS_TOLERANCE_STEPS.slice(1)) {
    if (bytes <= maxBytes) break;
    tolerance = step;
    features = build(tolerance);
    bytes = JSON.stringify(features).length;
  }
  // Last resort: keep the most severe alerts that fit (features are sorted).
  while (features.length > 1 && bytes > maxBytes) {
    features = features.slice(
      0,
      Math.max(1, Math.floor(features.length * 0.9)),
    );
    bytes = JSON.stringify(features).length;
  }
  return {
    type: 'FeatureCollection',
    features,
    details: {
      alerts: features.length,
      pendingAlerts,
      pendingZones: pendingZones.size,
      unmappedAlerts,
      tolerance,
    },
  };
}

// ---------------------------------------------------------------------------
// NOAA tsunami.gov Atom feeds
// ---------------------------------------------------------------------------

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the XML entities and CDATA an Atom text node can carry. */
function xmlText(value) {
  if (typeof value !== 'string') return null;
  const decoded = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi,
      (m, d, h, n) => {
        if (n) return XML_ENTITIES[n.toLowerCase()];
        const code = d ? Number(d) : parseInt(h, 16);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      },
    );
  return text(decoded);
}

/** Inner text of the first `<tag>` in `xml` (tag names may contain a colon). */
function tagText(xml, tag) {
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,
    'i',
  ).exec(xml);
  return match ? match[1] : null;
}

/** Attributes of every `<link …/>` in `xml`, as plain objects. */
function linkTags(xml) {
  const links = [];
  for (const match of xml.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attributes = {};
    for (const pair of match[1].matchAll(/([A-Za-z:]+)\s*=\s*"([^"]*)"/g))
      attributes[pair[1].toLowerCase()] = pair[2];
    links.push(attributes);
  }
  return links;
}

/** A decimal degree like "28.000", "28." or "-139.9", else NaN. */
function degrees(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^[+-]?\d+(?:\.\d*)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Bulletin level from the category text in the entry summary. */
export function tsunamiLevel(category) {
  const word = typeof category === 'string' ? category.toLowerCase() : '';
  if (word.includes('warning')) return 'warning';
  if (word.includes('advisory')) return 'advisory';
  // A PTWC "threat" message says hazardous waves are possible: a watch.
  if (word.includes('watch') || word.includes('threat')) return 'watch';
  return 'information';
}

function summaryField(summary, label) {
  const match = new RegExp(
    `<strong>\\s*${label}:?\\s*</strong>\\s*([^<]*)`,
    'i',
  ).exec(summary);
  return match ? xmlText(match[1]) : null;
}

/**
 * Normalize one tsunami.gov Atom feed to a point per bulletin entry.
 *
 * The feeds (one per warning center) hold the center's latest bulletin, so
 * an entry older than `maxAgeMs` is dropped rather than shown forever. The
 * epicentre comes from `geo:lat`/`geo:long` (or `georss:point`), the level
 * from the summary's "Category", the link from the bulletin `alternate` link
 * (https, tsunami.gov only). Entries without valid coordinates are skipped.
 *
 * Parsed with small tag/attribute regexes — the feeds are machine-written
 * Atom with a fixed shape and no namespaced tricks. Feature ids are
 * `<center>-<entry id>`.
 * @param {string} xml - The Atom document.
 * @param {Object} options
 * @param {string} options.center - Warning center code (`PAAQ`, `PHEB`).
 * @param {number} [options.nowMs=Date.now()]
 * @param {number} [options.maxAgeMs=3 days]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws When the text is not an Atom feed.
 */
export function normalizeTsunamiFeed(
  xml,
  { center, nowMs = Date.now(), maxAgeMs = TSUNAMI_MAX_AGE_MS } = {},
) {
  if (typeof xml !== 'string' || !/<feed\b/i.test(xml))
    throw invalidPayload('tsunami.gov response is not an Atom feed');
  const features = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    let lat = degrees(tagText(entry, 'geo:lat'));
    let lon = degrees(tagText(entry, 'geo:long'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const point = /^\s*([+-]?[\d.]+)[\s,]+([+-]?[\d.]+)\s*$/.exec(
        tagText(entry, 'georss:point') ?? '',
      );
      lat = point ? degrees(point[1]) : Number.NaN;
      lon = point ? degrees(point[2]) : Number.NaN;
    }
    if (!isValidPosition([lon, lat])) continue;
    const timestamp = toIsoTimestamp(xmlText(tagText(entry, 'updated')));
    if (!timestamp) continue;
    if (nowMs - Date.parse(timestamp) > maxAgeMs) continue;
    const summary = tagText(entry, 'summary') ?? '';
    const rawId = xmlText(tagText(entry, 'id'));
    const entryId =
      rawId?.replace(/^urn:uuid:/i, '') || `${timestamp}@${lat},${lon}`;
    const id = `${center}-${entryId}`.slice(0, 200);
    if (seen.has(id)) continue;
    seen.add(id);
    const links = linkTags(entry);
    const bulletin =
      links.find((link) => link.rel === 'alternate') ??
      links.find((link) => /bulletin/i.test(link.title ?? ''));
    const magnitude = /^([\d.]+)\s*\(?([A-Za-z]*)\)?/.exec(
      summaryField(summary, 'Preliminary Magnitude') ?? '',
    );
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        title: xmlText(tagText(entry, 'title')) ?? null,
        level: tsunamiLevel(summaryField(summary, 'Category')),
        center: text(center, 8),
        magnitude:
          magnitude && Number.isFinite(Number(magnitude[1]))
            ? Number(magnitude[1])
            : null,
        magnitudeType: magnitude?.[2] || null,
        url: httpsLink(bulletin?.href, ['www.tsunami.gov', 'tsunami.gov']),
        timestamp,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Merge the normalized collections of the tsunami feeds, most severe level
 * first.
 * @param {Array<{features: Array<Object>}>} collections
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 */
export function mergeTsunamiFeeds(collections) {
  const features = collections
    .flatMap((collection) => collection.features)
    .sort(
      (a, b) =>
        TSUNAMI_LEVELS.indexOf(a.properties.level) -
        TSUNAMI_LEVELS.indexOf(b.properties.level),
    );
  return { type: 'FeatureCollection', features };
}
