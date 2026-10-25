import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createGlobalHazardsSource } from '../layers/globalHazards/source.js';
import { createWeatherWarningsSource } from '../layers/weatherWarnings/source.js';
import { createVolcanoesSource } from '../layers/volcanoes/source.js';
import { createSpaceWeatherSource } from '../layers/spaceWeather/source.js';
import { createAviationWeatherSource } from '../layers/aviationWeather/source.js';
import { createAirspaceSource } from '../layers/airspace/source.js';
import { createWaterObservationsSource } from '../layers/waterObservations/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    'global-hazards': createGlobalHazardsSource(),
    'weather-warnings': createWeatherWarningsSource(),
    volcanoes: createVolcanoesSource(),
    'space-weather': createSpaceWeatherSource(),
    'aviation-weather': createAviationWeatherSource(),
    airspace: createAirspaceSource(),
    'water-observations': createWaterObservationsSource(),
  };
}
