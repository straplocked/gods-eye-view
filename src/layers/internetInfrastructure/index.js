import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { INTERNET_INFRASTRUCTURE_LAYER_ID } from './records.js';
import {
  INTERNET_SUBSOURCES,
  buildInternetCard,
  internetLegend,
  internetStyle,
} from './cards.js';
export { createInternetInfrastructureSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Internet Outages & Data Centers: Georgia Tech IODA internet outage alerts as
 * one marker per country colored by level, and PeeringDB data center and
 * interconnection facilities as points sized by the networks present, with a
 * row chip per feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createInternetInfrastructureLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: INTERNET_INFRASTRUCTURE_LAYER_ID,
    name: 'Internet Outages & Data Centers',
    icon: '🌐',
    sourceName: 'Georgia Tech IODA · PeeringDB',
    // The server refreshes the outages every 10 min (facilities daily).
    updateInterval: 10 * 60_000,
    subsources: INTERNET_SUBSOURCES,
    style: internetStyle,
    card: buildInternetCard,
    legend: internetLegend,
    ...options,
  });
}
