import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { AIRSPACE_LAYER_ID } from './records.js';
import {
  AIRSPACE_SUBSOURCES,
  airspaceLegend,
  airspaceStyle,
  buildAirspaceCard,
} from './cards.js';
export { createAirspaceSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Airspace Restrictions & Airport Delays: FAA Temporary Flight Restrictions
 * as type-colored areas, and airports with ground stops, delay programs or
 * closures as dots colored by the most severe program, with a row chip per
 * feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createAirspaceLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: AIRSPACE_LAYER_ID,
    name: 'Airspace Restrictions & Airport Delays',
    icon: '🚧',
    sourceName: 'FAA',
    // The server refreshes delays every 5 min and the TFR list every 10.
    updateInterval: 5 * 60_000,
    subsources: AIRSPACE_SUBSOURCES,
    style: airspaceStyle,
    card: buildAirspaceCard,
    legend: airspaceLegend,
    ...options,
  });
}
