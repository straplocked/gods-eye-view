import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { GLOBAL_HAZARDS_LAYER_ID } from './records.js';
import {
  GLOBAL_HAZARD_SUBSOURCES,
  buildHazardCard,
  hazardAnalystRecord,
  hazardLegend,
  hazardStyle,
} from './cards.js';
export { createGlobalHazardsSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Global Hazards: GDACS current disaster alerts and NASA EONET open natural
 * events as one keyless layer, with a row chip per feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createGlobalHazardsLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: GLOBAL_HAZARDS_LAYER_ID,
    name: 'Global Hazards',
    icon: '⚠️',
    sourceName: 'GDACS · NASA EONET',
    // GDACS refreshes every 15 min and EONET every 30 min server-side.
    updateInterval: 15 * 60_000,
    subsources: GLOBAL_HAZARD_SUBSOURCES,
    style: hazardStyle,
    card: buildHazardCard,
    legend: hazardLegend,
    analystRecord: hazardAnalystRecord,
    ...options,
  });
}
