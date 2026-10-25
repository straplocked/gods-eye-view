/**
 * Pure helpers behind the keyless feature layer (featureLayer.js): card
 * anchors, per-subsource filtering, row chips and the partial-feed status.
 * No Cesium types, so tests run without a viewer.
 * @module layers/common/featureModel
 */
import { msg } from '../../i18n/marker.js';

const TO_RAD = Math.PI / 180;

/** Shoelace area along short longitude edges (degree², relative sizes only). */
function ringArea(ring) {
  let sum = 0;
  let [x1, y1] = ring[0];
  for (let i = 1; i < ring.length; i++) {
    let delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    const x2 = x1 + delta;
    const y2 = ring[i][1];
    sum += x1 * y2 - x2 * y1;
    x1 = x2;
    y1 = y2;
  }
  return Math.abs(sum / 2);
}

/** Vertex mean of a closed ring (last point dropped) with circular longitude. */
function ringCenter(ring) {
  const count = Math.max(1, ring.length - 1);
  let sinLon = 0;
  let cosLon = 0;
  let lat = 0;
  for (let i = 0; i < count; i++) {
    sinLon += Math.sin(ring[i][0] * TO_RAD);
    cosLon += Math.cos(ring[i][0] * TO_RAD);
    lat += ring[i][1];
  }
  return { lon: Math.atan2(sinLon, cosLon) / TO_RAD, lat: lat / count };
}

/**
 * Where a feature's click card sits: the point itself, a line's middle
 * vertex, or the vertex mean of the largest polygon's outer ring.
 * @param {Object|null} geometry - A validated GeoJSON geometry.
 * @returns {{lon: number, lat: number}|null}
 */
export function featureAnchor(geometry) {
  if (!geometry) return null;
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return { lon: c[0], lat: c[1] };
    case 'MultiPoint':
      return c.length ? { lon: c[0][0], lat: c[0][1] } : null;
    case 'LineString': {
      const middle = c[Math.floor((c.length - 1) / 2)];
      return { lon: middle[0], lat: middle[1] };
    }
    case 'MultiLineString':
      return c.length
        ? featureAnchor({ type: 'LineString', coordinates: c[0] })
        : null;
    case 'Polygon':
      return ringCenter(c[0]);
    case 'MultiPolygon': {
      let best = null;
      let bestArea = -1;
      for (const rings of c) {
        const area = ringArea(rings[0]);
        if (area > bestArea) {
          bestArea = area;
          best = rings[0];
        }
      }
      return best ? ringCenter(best) : null;
    }
    case 'GeometryCollection':
      for (const child of geometry.geometries) {
        const anchor = featureAnchor(child);
        if (anchor) return anchor;
      }
      return null;
    default:
      return null;
  }
}

/**
 * Subsource ids behind a feature. A layer that joins one entity reported by
 * several feeds (Volcanoes: `gvp+usgs`) writes them joined with `+`.
 * @param {Object} feature - Server feature (properties.source set).
 * @returns {string[]}
 */
export function featureSources(feature) {
  const source = feature?.properties?.source;
  return typeof source === 'string' ? source.split('+') : [];
}

/**
 * Features whose subsource the viewer has not switched off. A joined feature
 * stays until every feed behind it is switched off.
 * @param {Array<Object>} features - Server features (properties.source set).
 * @param {Set<string>} hidden - Subsource ids switched off in the row.
 * @returns {Array<Object>}
 */
export function visibleFeatures(features, hidden) {
  if (!hidden.size) return features;
  return features.filter((feature) => {
    const sources = featureSources(feature);
    return !sources.length || sources.some((source) => !hidden.has(source));
  });
}

/** Count features per subsource id; a joined feature counts for each feed. */
export function countBySource(features) {
  const counts = new Map();
  for (const feature of features) {
    for (const source of featureSources(feature))
      counts.set(source, (counts.get(source) || 0) + 1);
  }
  return counts;
}

/**
 * Row chips, one per subsource: pressed while shown. `label` is the
 * already-translated subsource name.
 * @param {Array<{id: string, label: string, title?: string}>} subsources
 * @param {Set<string>} hidden
 * @param {(id: string) => void} onToggle
 * @returns {Array<Object>} Chip descriptors for the Layers panel.
 */
export function subsourceChips(subsources, hidden, onToggle) {
  return subsources.map(({ id, label, title }) => ({
    id: `source-${id}`,
    label,
    title: title || '',
    active: !hidden.has(id),
    onClick: () => onToggle(id),
  }));
}

/**
 * English status for a partial snapshot (translated by the Layers panel's
 * "<feed> feed unavailable" pattern), or null when every subsource served.
 * @param {Object|null} metadata - Response `metadata` (sources[].ok).
 * @param {Map<string, string>} names - Subsource id → English feed name.
 * @returns {string|null}
 */
export function partialFeedError(metadata, names) {
  const failed = (metadata?.sources || []).filter((entry) => !entry?.ok);
  if (!failed.length) return null;
  if (failed.length > 1) return msg('Some feeds unavailable');
  return `${names.get(failed[0].id) || failed[0].id} feed unavailable`;
}

/**
 * Whether a click-through link may open: an absolute https URL without
 * credentials. Upstream-supplied links are data, never trusted as-is.
 * @param {unknown} link
 * @returns {string|null} The normalized URL, or null.
 */
export function safeExternalLink(link) {
  if (typeof link !== 'string' || link.length > 2048) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href;
}
