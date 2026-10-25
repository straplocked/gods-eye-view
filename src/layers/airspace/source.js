import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { AIRSPACE_LAYER_ID } from './records.js';

/**
 * Request the FAA Temporary Flight Restrictions and NAS airport delays
 * through the same-origin keyless route (/api/v1/layers/airspace). Portable:
 * no i18n catalog, Cesium or DOM; failures stay English data the Layers panel
 * translates. The 4 MiB cap is far above the few-hundred-kilobyte worst case
 * the server allows.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createAirspaceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: AIRSPACE_LAYER_ID,
    label: msg('Airspace'),
    maxBytes: 4 * 1024 * 1024,
    fetchImpl,
  });
}
