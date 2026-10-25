import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { SPACE_WEATHER_LAYER_ID } from './records.js';

/**
 * Request the NOAA SWPC aurora bands and Kp summary through the same-origin
 * keyless route (/api/v1/layers/space-weather). Portable: no i18n catalog,
 * Cesium or DOM; failures stay English data the Layers panel translates. The
 * 2 MiB cap is far above the few-hundred-kilobyte worst case the server allows.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createSpaceWeatherSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: SPACE_WEATHER_LAYER_ID,
    label: msg('Aurora & Space Weather'),
    maxBytes: 2 * 1024 * 1024,
    fetchImpl,
  });
}
