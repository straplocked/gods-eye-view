import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { NEWS_EVENTS_LAYER_ID } from './records.js';
import {
  NEWS_SUBSOURCES,
  buildNewsCard,
  newsLegend,
  newsRowInfo,
  newsStyle,
} from './cards.js';
export { createNewsEventsSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Geolocated News (GDELT): the newest 15-minute GDELT Global Knowledge Graph
 * batch as one point per place, sized by the number of articles and colored
 * red when conflict, unrest or terror themes appear, with a click card of the
 * headlines.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createNewsEventsLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: NEWS_EVENTS_LAYER_ID,
    name: 'Geolocated News (GDELT)',
    icon: '📰',
    sourceName: 'GDELT',
    // GDELT publishes every 15 minutes and the server caches for the same.
    updateInterval: 15 * 60_000,
    subsources: NEWS_SUBSOURCES,
    style: newsStyle,
    card: buildNewsCard,
    legend: newsLegend,
    rowInfo: newsRowInfo,
    ...options,
  });
}
