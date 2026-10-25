import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { WEATHER_WARNINGS_LAYER_ID } from './records.js';
import {
  WEATHER_WARNING_SUBSOURCES,
  buildWarningCard,
  warningAnalystRecord,
  warningLegend,
  warningStyle,
} from './cards.js';
export { createWeatherWarningsSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Weather & Tsunami Warnings: US National Weather Service active alerts as
 * severity-colored areas plus NOAA tsunami.gov bulletins as points, with a
 * row chip per feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createWeatherWarningsLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: WEATHER_WARNINGS_LAYER_ID,
    name: 'Weather & Tsunami Warnings',
    icon: '⛈️',
    sourceName: 'NWS · NOAA tsunami.gov',
    // The NWS feed refreshes server-side every 2 min and tsunami every 5.
    updateInterval: 2 * 60_000,
    subsources: WEATHER_WARNING_SUBSOURCES,
    style: warningStyle,
    card: buildWarningCard,
    legend: warningLegend,
    analystRecord: warningAnalystRecord,
    ...options,
  });
}
