import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { VOLCANOES_LAYER_ID } from './records.js';

/**
 * Request the merged Smithsonian GVP + USGS snapshot through the same-origin
 * keyless route (/api/v1/layers/volcanoes). Portable: no i18n catalog, Cesium
 * or DOM; failures stay English data the Layers panel translates.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createVolcanoesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: VOLCANOES_LAYER_ID,
    label: msg('Volcanoes'),
    maxBytes: 2 * 1024 * 1024,
    fetchImpl,
  });
}
