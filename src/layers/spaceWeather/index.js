import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { SPACE_WEATHER_LAYER_ID } from './records.js';
import {
  SPACE_WEATHER_SUBSOURCES,
  auroraLegend,
  auroraStyle,
  buildAuroraCard,
  spaceWeatherRowInfo,
} from './cards.js';
export { createSpaceWeatherSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Aurora & Space Weather: the NOAA SWPC OVATION aurora nowcast as
 * probability-band areas, plus the latest planetary Kp and NOAA G-scale in
 * the panel row and on the click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createSpaceWeatherLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: SPACE_WEATHER_LAYER_ID,
    name: 'Aurora & Space Weather',
    icon: '🌌',
    sourceName: 'NOAA SWPC',
    // The aurora grid refreshes server-side every 5 min, Kp every 15.
    updateInterval: 5 * 60_000,
    subsources: SPACE_WEATHER_SUBSOURCES,
    style: auroraStyle,
    card: buildAuroraCard,
    legend: auroraLegend,
    rowInfo: spaceWeatherRowInfo,
    ...options,
  });
}
