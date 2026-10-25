import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { NEWS_EVENTS_LAYER_ID } from './records.js';

/**
 * Request the GDELT geolocated news points through the same-origin keyless
 * route (/api/v1/layers/news-events). Portable: no i18n catalog, Cesium or
 * DOM; failures stay English data the Layers panel translates. The 8 MiB cap
 * is well above the ~1.5 MB that 2,000 places with five headlines each
 * serialize to.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createNewsEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: NEWS_EVENTS_LAYER_ID,
    label: msg('Geolocated News (GDELT)'),
    maxBytes: 8 * 1024 * 1024,
    fetchImpl,
  });
}
