import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { WEATHER_WARNINGS_LAYER_ID } from './records.js';

/**
 * Request the merged NWS alerts + NOAA tsunami snapshot through the
 * same-origin keyless route (/api/v1/layers/weather-warnings). Portable: no
 * i18n catalog, Cesium or DOM; failures stay English data the Layers panel
 * translates. The 8 MiB cap leaves room for the ~3 MB the server targets.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createWeatherWarningsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: WEATHER_WARNINGS_LAYER_ID,
    label: msg('Weather & Tsunami Warnings'),
    maxBytes: 8 * 1024 * 1024,
    fetchImpl,
  });
}
