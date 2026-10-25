import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { VOLCANOES_LAYER_ID } from './records.js';
import {
  VOLCANO_SUBSOURCES,
  buildVolcanoCard,
  volcanoAnalystRecord,
  volcanoLegend,
  volcanoStyle,
} from './cards.js';
export { createVolcanoesSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Volcanoes: Smithsonian Global Volcanism Program continuing eruptions and
 * USGS Volcano Hazards Program alert levels as one point per volcano (a
 * volcano both feeds list is joined), with a row chip per feed and a click
 * card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createVolcanoesLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: VOLCANOES_LAYER_ID,
    name: 'Volcanoes',
    icon: '🌋',
    sourceName: 'Smithsonian GVP · USGS',
    // USGS refreshes server-side every 10 min; GVP every 6 h.
    updateInterval: 10 * 60_000,
    subsources: VOLCANO_SUBSOURCES,
    style: volcanoStyle,
    card: buildVolcanoCard,
    legend: volcanoLegend,
    analystRecord: volcanoAnalystRecord,
    ...options,
  });
}
