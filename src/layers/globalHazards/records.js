/**
 * Normalizers for the Global Hazards layer: GDACS current events and NASA
 * EONET open events, each to a GeoJSON FeatureCollection with one feature per
 * event. Pure and portable — the server proxy (server/providers/globalHazards.js)
 * and tests import them.
 *
 * Every feature carries the common hazard fields the card and style read:
 * `hazard` (a kind from HAZARD_KINDS), `name`, `alertlevel` (GDACS only),
 * `timestamp` (ISO) and `url` (an https page or null).
 * @module layers/globalHazards/records
 */
import {
  isValidGeometry,
  isValidPosition,
  toIsoTimestamp,
} from '../common/geojson.js';
import { httpsLink, invalidPayload } from '../common/normalize.js';

export const GLOBAL_HAZARDS_LAYER_ID = 'global-hazards';

/** GDACS event types, one MAP request each (the endpoint takes exactly one). */
export const GDACS_EVENT_TYPES = Object.freeze([
  'EQ',
  'TC',
  'FL',
  'VO',
  'DR',
  'WF',
]);

/** GDACS current-events URL for one event type. */
export function gdacsMapUrl(eventType) {
  return `https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=${eventType}`;
}

/** NASA EONET v3 open events of the last 30 days, as GeoJSON. */
export const EONET_URL =
  'https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30';

/** Hazard kinds shared by both subsources (style, legend and card keys). */
export const HAZARD_KINDS = Object.freeze([
  'earthquake',
  'cyclone',
  'storm',
  'flood',
  'volcano',
  'drought',
  'wildfire',
  'landslide',
  'ice',
  'snow',
  'temperature',
  'dust',
  'water',
  'manmade',
  'other',
]);

const GDACS_HAZARDS = Object.freeze({
  EQ: 'earthquake',
  TC: 'cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
});

const EONET_HAZARDS = Object.freeze({
  drought: 'drought',
  dustHaze: 'dust',
  earthquakes: 'earthquake',
  floods: 'flood',
  landslides: 'landslide',
  manmade: 'manmade',
  seaLakeIce: 'ice',
  severeStorms: 'storm',
  snow: 'snow',
  tempExtremes: 'temperature',
  volcanoes: 'volcano',
  waterColor: 'water',
  wildfires: 'wildfire',
});

const ALERT_LEVELS = new Set(['green', 'orange', 'red']);
const MAX_TEXT = 200;

const text = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
};

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function collectionFeatures(payload, label) {
  if (!isObject(payload) || !Array.isArray(payload.features))
    throw invalidPayload(`${label} payload is not a FeatureCollection`);
  return payload.features;
}

/**
 * Normalize GDACS event lists (one MAP or SEARCH FeatureCollection per event
 * type; null for a type with no current events) into one point per event.
 *
 * The MAP lists carry several features per event — the centroid point plus
 * affected-area polygons, cyclone tracks and buffers. Only the centroid
 * (`Class: "Point_Centroid"`, else the event's first point) is kept; the
 * areas would bury the globe. Feature ids are `<eventtype>-<eventid>`.
 * @param {Array<Object|null>} payloads
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws When a payload is not a FeatureCollection, or every type is empty
 *   (GDACS always lists some current events, so that means a broken feed).
 */
export function normalizeGdacsEvents(payloads) {
  if (!Array.isArray(payloads))
    throw invalidPayload('GDACS payload list missing');
  if (!payloads.some(Boolean))
    throw invalidPayload('GDACS returned no event lists');
  const byEvent = new Map();
  for (const payload of payloads) {
    if (payload == null) continue;
    for (const feature of collectionFeatures(payload, 'GDACS')) {
      const properties = feature?.properties;
      const geometry = feature?.geometry;
      if (!isObject(properties) || geometry?.type !== 'Point') continue;
      const eventType = properties.eventtype;
      const hazard = GDACS_HAZARDS[eventType];
      const eventId = Number(properties.eventid);
      if (!hazard || !Number.isSafeInteger(eventId) || eventId <= 0) continue;
      if (!isValidPosition(geometry.coordinates)) continue;
      const id = `${eventType}-${eventId}`;
      const centroid = properties.Class === 'Point_Centroid';
      const previous = byEvent.get(id);
      if (previous && (previous.centroid || !centroid)) continue;
      byEvent.set(id, { centroid, feature, eventType, eventId, hazard });
    }
  }
  const features = [];
  for (const [id, { feature, eventType, eventId, hazard }] of byEvent) {
    const p = feature.properties;
    const alert = String(p.alertlevel || '').toLowerCase();
    const fromdate = toIsoTimestamp(p.fromdate);
    const todate = toIsoTimestamp(p.todate);
    const [lon, lat] = feature.geometry.coordinates;
    features.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        hazard,
        eventtype: eventType,
        eventid: eventId,
        episodeid: Number.isSafeInteger(Number(p.episodeid))
          ? Number(p.episodeid)
          : null,
        alertlevel: ALERT_LEVELS.has(alert) ? alert : null,
        name: text(p.name) || text(p.eventname),
        country: text(p.country),
        fromdate,
        todate,
        severity: text(p.severitydata?.severitytext),
        url: httpsLink(p.url?.report, ['www.gdacs.org', 'gdacs.org']),
        // The latest time GDACS reports for the event (its last episode).
        timestamp: todate ?? fromdate,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** One dated candidate geometry for an EONET event, or null. */
function eonetCandidate(feature) {
  const geometry = feature?.geometry;
  const properties = feature?.properties;
  if (!isObject(geometry)) return null;
  if (geometry.type === 'Point' || geometry.type === 'Polygon') {
    if (!isValidGeometry(geometry)) return null;
    const coordinates =
      geometry.type === 'Point'
        ? geometry.coordinates.slice(0, 2)
        : geometry.coordinates.map((ring) =>
            ring.map((position) => position.slice(0, 2)),
          );
    return {
      geometry: { type: geometry.type, coordinates },
      timestamp: toIsoTimestamp(properties?.date),
    };
  }
  // Drift tracks (icebergs) arrive as a LineString dated by geometryDates;
  // the event's current position is its last vertex.
  if (geometry.type === 'LineString' && isValidGeometry(geometry)) {
    const last = geometry.coordinates[geometry.coordinates.length - 1];
    const dates = Array.isArray(properties?.geometryDates)
      ? properties.geometryDates
      : [];
    return {
      geometry: { type: 'Point', coordinates: last.slice(0, 2) },
      timestamp: toIsoTimestamp(dates[dates.length - 1]),
    };
  }
  return null;
}

/**
 * Normalize an EONET v3 GeoJSON events payload into one feature per open
 * event, at its most recent Point or Polygon.
 *
 * EONET emits one feature per observation (a storm track is dozens of dated
 * points sharing an event id), so features are grouped by `properties.id`
 * and the latest-dated geometry wins. Closed events are skipped.
 * @param {Object} payload
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws When the payload is not a FeatureCollection.
 */
export function normalizeEonetEvents(payload) {
  const latest = new Map();
  for (const feature of collectionFeatures(payload, 'EONET')) {
    const properties = feature?.properties;
    if (!isObject(properties)) continue;
    const id = typeof properties.id === 'string' ? properties.id.trim() : '';
    if (!id || id.length > 64 || properties.closed != null) continue;
    const candidate = eonetCandidate(feature);
    if (!candidate) continue;
    const previous = latest.get(id);
    if (
      previous &&
      (candidate.timestamp ?? '') <= (previous.candidate.timestamp ?? '')
    )
      continue;
    latest.set(id, { candidate, properties });
  }
  const features = [];
  for (const [id, { candidate, properties }] of latest) {
    const category = Array.isArray(properties.categories)
      ? properties.categories.find((entry) => isObject(entry))
      : null;
    const categoryId = typeof category?.id === 'string' ? category.id : null;
    const sources = Array.isArray(properties.sources) ? properties.sources : [];
    const magnitude = Number(properties.magnitudeValue);
    features.push({
      type: 'Feature',
      id,
      geometry: candidate.geometry,
      properties: {
        hazard: EONET_HAZARDS[categoryId] || 'other',
        category: categoryId,
        categoryTitle: text(category?.title),
        alertlevel: null,
        name: text(properties.title),
        description: text(properties.description),
        magnitudeValue:
          properties.magnitudeValue != null && Number.isFinite(magnitude)
            ? magnitude
            : null,
        magnitudeUnit: text(properties.magnitudeUnit),
        // EONET links to the reporting agency's page (InciWeb, JTWC, …).
        url:
          sources.map((entry) => httpsLink(entry?.url)).find(Boolean) ?? null,
        timestamp: candidate.timestamp,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
