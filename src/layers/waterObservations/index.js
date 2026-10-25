import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { WATER_OBSERVATIONS_LAYER_ID } from './records.js';
import {
  WATER_SUBSOURCES,
  buildWaterCard,
  waterLegend,
  waterStyle,
} from './cards.js';
export { createWaterObservationsSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Buoys & River Gauges: NOAA NDBC buoy and coastal-station observations as
 * points colored by wind speed, and NWS river gauges at or above flood action
 * stage as points colored by flood category, with a row chip per feed and a
 * click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createWaterObservationsLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: WATER_OBSERVATIONS_LAYER_ID,
    name: 'Buoys & River Gauges',
    icon: '🌊',
    sourceName: 'NOAA NDBC · NWPS',
    // The server refreshes both feeds every 15 min.
    updateInterval: 15 * 60_000,
    subsources: WATER_SUBSOURCES,
    style: waterStyle,
    card: buildWaterCard,
    legend: waterLegend,
    ...options,
  });
}
