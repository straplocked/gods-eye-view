import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { AVIATION_WEATHER_LAYER_ID } from './records.js';

/**
 * Request the NOAA AWC METAR and SIGMET snapshot through the same-origin
 * keyless route (/api/v1/layers/aviation-weather). Portable: no i18n catalog,
 * Cesium or DOM; failures stay English data the Layers panel translates. The
 * 8 MiB cap is well above the ~1.7 MB that ~5,100 METARs serialize to.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createAviationWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: AVIATION_WEATHER_LAYER_ID,
    label: msg('Aviation Weather'),
    maxBytes: 8 * 1024 * 1024,
    fetchImpl,
  });
}
