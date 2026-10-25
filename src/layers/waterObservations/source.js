import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { WATER_OBSERVATIONS_LAYER_ID } from './records.js';

/**
 * Request the NOAA NDBC buoy observations and NWPS flooding river gauges
 * through the same-origin keyless route (/api/v1/layers/water-observations).
 * Portable: no i18n catalog, Cesium or DOM; failures stay English data the
 * Layers panel translates. The 4 MiB cap is above the ~0.5 MB that ~850
 * stations and a few hundred gauges serialize to.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createWaterObservationsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: WATER_OBSERVATIONS_LAYER_ID,
    label: msg('Buoys & River Gauges'),
    maxBytes: 4 * 1024 * 1024,
    fetchImpl,
  });
}
