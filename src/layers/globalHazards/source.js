import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { GLOBAL_HAZARDS_LAYER_ID } from './records.js';

/**
 * Request the merged GDACS + NASA EONET snapshot through the same-origin
 * keyless route (/api/v1/layers/global-hazards). Portable: no i18n, Cesium
 * or DOM; failures stay English data the Layers panel translates.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createGlobalHazardsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: GLOBAL_HAZARDS_LAYER_ID,
    label: msg('Global Hazards'),
    maxBytes: 8 * 1024 * 1024,
    fetchImpl,
  });
}
