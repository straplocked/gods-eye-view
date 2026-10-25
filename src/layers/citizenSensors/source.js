import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { CITIZEN_SENSORS_LAYER_ID } from './records.js';

/**
 * Request the Sensor.Community particulate cells and Safecast radiation
 * readings through the same-origin keyless route
 * (/api/v1/layers/citizen-sensors). Portable: no i18n catalog, Cesium or DOM;
 * failures stay English data the Layers panel translates. The 4 MiB cap is
 * above the ~1.3 MB that ~3,900 cells and a few hundred readings serialize to.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createCitizenSensorsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: CITIZEN_SENSORS_LAYER_ID,
    label: msg('Citizen Air & Radiation Sensors'),
    maxBytes: 4 * 1024 * 1024,
    fetchImpl,
  });
}
