// Hand-written NOAA SWPC payloads for the Aurora & Space Weather tests,
// modeled on real responses (services.swpc.noaa.gov/json/ovation_aurora_latest.json
// and products/noaa-planetary-k-index.json, October 2026) and trimmed to a few
// cells and rows. Not a test file: the unit runner only collects *.test.mjs.

/**
 * An OVATION-shaped payload around hand-written cells
 * `[longitude 0..359, latitude, probability %]`.
 * @param {Array<Array<number>>} cells
 * @param {{observation?: string, forecast?: string}} [times]
 */
export function ovation(
  cells,
  {
    observation = '2026-10-25T08:38:00Z',
    forecast = '2026-10-25T09:55:00Z',
  } = {},
) {
  return {
    'Observation Time': observation,
    'Forecast Time': forecast,
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates: cells,
    type: 'MultiPoint',
  };
}

/**
 * A small grid in the real file's order (longitude-major, latitude rising).
 *   - lon 350/351 at lat 65 (25 %, 27 %) are -10 and -9 degrees: one cell pair
 *     in the 20-40 % band, north;
 *   - lon 352 at lat 65 (9 %) is just under the 10 % minimum and is dropped;
 *   - lon 350 at lat 66 (12 %) is the faint 10-20 % band, north;
 *   - lon 10 at lat -60 (70 %) is the 60 %+ band, south;
 *   - the polar and zero rows are below the minimum.
 */
export const auroraCells = [
  [0, -90, 3],
  [0, -89, 0],
  [0, -88, 4],
  [10, -60, 70],
  [350, 64, 4],
  [350, 65, 25],
  [350, 66, 12],
  [351, 65, 27],
  [352, 65, 9],
  [359, 90, 5],
];

export const auroraPayload = ovation(auroraCells);

/** Planetary K-index rows as the product now serves them (objects, zone-less UTC). */
export const kpRows = [
  { time_tag: '2026-10-24T09:00:00', Kp: 1.67, a_running: 6, station_count: 8 },
  { time_tag: '2026-10-24T12:00:00', Kp: 2.0, a_running: 7, station_count: 8 },
  {
    time_tag: '2026-10-24T15:00:00',
    Kp: 3.33,
    a_running: 15,
    station_count: 8,
  },
  {
    time_tag: '2026-10-24T18:00:00',
    Kp: 4.67,
    a_running: 27,
    station_count: 8,
  },
  { time_tag: '2026-10-24T21:00:00', Kp: 5.0, a_running: 48, station_count: 8 },
  {
    time_tag: '2026-10-25T00:00:00',
    Kp: 6.33,
    a_running: 80,
    station_count: 8,
  },
  {
    time_tag: '2026-10-25T03:00:00',
    Kp: 4.33,
    a_running: 32,
    station_count: 8,
  },
  {
    time_tag: '2026-10-25T06:00:00',
    Kp: 7.33,
    a_running: 132,
    station_count: 8,
  },
];

/** The same rows in the older layout: a header row, then string cells. */
export const kpLegacyRows = [
  ['time_tag', 'Kp', 'a_running', 'station_count'],
  ['2026-10-24T21:00:00', '5.00', '48', '8'],
  ['2026-10-25T00:00:00', '6.33', '80', '8'],
  ['2026-10-25T03:00:00', '4.33', '32', '8'],
  ['2026-10-25T06:00:00', '7.33', '132', '8'],
];
