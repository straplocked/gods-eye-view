import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { AVIATION_WEATHER_LAYER_ID } from './records.js';
import {
  AVIATION_SUBSOURCES,
  aviationLegend,
  aviationStyle,
  buildAviationCard,
} from './cards.js';
export { createAviationWeatherSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Aviation Weather: NOAA Aviation Weather Center METARs as points colored by
 * flight category, and US and international SIGMET/AIRMET advisories as
 * hazard-colored areas, with a row chip per feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createAviationWeatherLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: AVIATION_WEATHER_LAYER_ID,
    name: 'Aviation Weather',
    icon: '🛩️',
    sourceName: 'NOAA AWC',
    // The server refreshes METARs and advisories every 5 min.
    updateInterval: 5 * 60_000,
    subsources: AVIATION_SUBSOURCES,
    style: aviationStyle,
    card: buildAviationCard,
    legend: aviationLegend,
    ...options,
  });
}
