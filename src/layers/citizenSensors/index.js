import { createKeylessFeatureLayer } from '../common/featureLayer.js';
import { CITIZEN_SENSORS_LAYER_ID } from './records.js';
import {
  CITIZEN_SENSOR_SUBSOURCES,
  buildCitizenCard,
  citizenLegend,
  citizenStyle,
} from './cards.js';
export { createCitizenSensorsSource } from './source.js';
export * from './records.js';
export * from './cards.js';

/**
 * Citizen Air & Radiation Sensors: Sensor.Community outdoor particulate
 * sensors binned to a 0.1 degree grid and colored by the US EPA air quality
 * category of the median PM2.5, and Safecast radiation readings (the latest of
 * each device in the last six hours) colored by dose rate, with a row chip per
 * feed and a click card.
 * @param {Object} options - See createKeylessFeatureLayer (source, overlayHost, picking, …).
 */
export function createCitizenSensorsLayer(options = {}) {
  return createKeylessFeatureLayer({
    id: CITIZEN_SENSORS_LAYER_ID,
    name: 'Citizen Air & Radiation Sensors',
    icon: '☢️',
    sourceName: 'Sensor.Community · Safecast',
    // The server refreshes particulates every 10 min and radiation every 30.
    updateInterval: 10 * 60_000,
    subsources: CITIZEN_SENSOR_SUBSOURCES,
    style: citizenStyle,
    card: buildCitizenCard,
    legend: citizenLegend,
    ...options,
  });
}
