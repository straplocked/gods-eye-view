// Hand-written fixtures for the Citizen Air & Radiation Sensors layer, modeled
// on real Sensor.Community data.dust.min.json and Safecast
// api.safecast.org/measurements.json payloads. Not a test file: the unit
// runner only collects *.test.mjs.

/** 2026-10-25T09:00:00.000Z, the "now" of every test. */
export const NOW_MS = Date.UTC(2026, 9, 25, 9, 0, 0);

let nextId = 31_000_000_000;

/** A Sensor.Community PM value list the way the file writes it (strings, two decimals). */
export function pmValues(p1, p2) {
  const values = [];
  if (p1 !== undefined)
    values.push({
      id: 1,
      value: String(p1.toFixed?.(2) ?? p1),
      value_type: 'P1',
    });
  if (p2 !== undefined)
    values.push({
      id: 2,
      value: String(p2.toFixed?.(2) ?? p2),
      value_type: 'P2',
    });
  return values;
}

/** One Sensor.Community reading. `values` defaults to the PM list for p1/p2. */
export function reading({
  loc,
  lat,
  lon,
  time = '2026-10-25 08:50:00',
  p1,
  p2,
  indoor = 0,
  values = pmValues(p1, p2),
  id = nextId++,
}) {
  return {
    id,
    sampling_rate: null,
    timestamp: time,
    location: {
      id: loc,
      latitude: String(lat),
      longitude: String(lon),
      altitude: '120.0',
      country: 'DE',
      exact_location: 0,
      indoor,
    },
    sensor: {
      id: loc * 10,
      pin: '1',
      sensor_type: { id: 14, name: 'SDS011', manufacturer: 'Nova Fitness' },
    },
    sensordatavalues: values,
  };
}

/**
 * Grid cell A (0.1 degree cell 1891_1385, center 9.15, 48.55): four outdoor
 * sensors with PM2.5 10, 20, 40 and 36 and PM10 30, 40, 55 and 90.
 * Median PM2.5 = (20 + 36) / 2 = 28.0 (moderate, AQI 86); median PM10 =
 * (40 + 55) / 2 = 47.5. Location 101 reports twice; only its newest counts.
 */
export const CELL_A_READINGS = Object.freeze([
  reading({
    loc: 101,
    lat: 48.51,
    lon: 9.12,
    p1: 30,
    p2: 10,
    time: '2026-10-25 08:50:00',
  }),
  // An older report of location 101: ignored (would move the median to 36).
  reading({
    loc: 101,
    lat: 48.51,
    lon: 9.12,
    p1: 999,
    p2: 999,
    time: '2026-10-25 08:40:00',
  }),
  reading({
    loc: 102,
    lat: 48.52,
    lon: 9.13,
    p1: 40,
    p2: 20,
    time: '2026-10-25 08:52:30',
  }),
  reading({
    loc: 103,
    lat: 48.58,
    lon: 9.18,
    p1: 55,
    p2: 40,
    time: '2026-10-25 08:55:00',
  }),
  reading({
    loc: 104,
    lat: 48.59,
    lon: 9.19,
    p1: 90,
    p2: 36,
    time: '2026-10-25 08:45:10',
  }),
]);

/** Readings in cell A's neighborhood that must all be dropped. */
export const CELL_A_BAD_READINGS = Object.freeze({
  // Indoors: with the flag-less 600 below, a 500 would move the median to 38.
  indoor: reading({
    loc: 105,
    lat: 48.55,
    lon: 9.15,
    p1: 600,
    p2: 500,
    indoor: 1,
  }),
  // No indoor flag at all: not provably outdoors.
  indoorMissing: (() => {
    const r = reading({ loc: 106, lat: 48.55, lon: 9.15, p1: 700, p2: 600 });
    delete r.location.indoor;
    return r;
  })(),
  negative: reading({ loc: 107, lat: 48.55, lon: 9.15, p1: 5, p2: -1 }),
  tooHigh: reading({ loc: 108, lat: 48.55, lon: 9.15, p1: 1500, p2: 1000.01 }),
  negativePm10: reading({ loc: 109, lat: 48.55, lon: 9.15, p1: -3, p2: 50 }),
  notANumber: reading({ loc: 110, lat: 48.55, lon: 9.15, p1: 'NaN', p2: 50 }),
});

/**
 * Other cells. B: one sensor at 150 (very unhealthy, AQI 225). C: two sensors
 * at 9.0 (good, AQI 50, the top of the good range). D: one sensor at 9.1
 * (moderate, AQI 51) with no PM10 channel. E: one sensor at exactly 1000
 * (the largest plausible value; hazardous, AQI 500). F: longitude 180, which
 * the grid clamps into its last column.
 */
export const OTHER_CELL_READINGS = Object.freeze([
  reading({
    loc: 201,
    lat: 39.91,
    lon: 116.41,
    p1: 200,
    p2: 150,
    time: '2026-10-25 08:58:00',
  }),
  reading({
    loc: 301,
    lat: -33.45,
    lon: -70.65,
    p1: 12,
    p2: 9,
    time: '2026-10-25 08:30:00',
  }),
  reading({
    loc: 302,
    lat: -33.452,
    lon: -70.652,
    p1: 14,
    p2: 9,
    time: '2026-10-25 08:35:00',
  }),
  reading({
    loc: 401,
    lat: 48.85,
    lon: 2.35,
    p2: 9.1,
    time: '2026-10-25 08:20:00',
  }),
  reading({
    loc: 501,
    lat: 28.6,
    lon: 77.2,
    p1: 1000,
    p2: 1000,
    time: '2026-10-25 08:10:00',
  }),
  reading({
    loc: 601,
    lat: 10.05,
    lon: 180,
    p1: 6,
    p2: 5,
    time: '2026-10-25 08:05:00',
  }),
]);

/** Readings that must never become a feature, each for a different reason. */
export const BAD_AIR_READINGS = Object.freeze({
  nanLat: reading({ loc: 701, lat: 'abc', lon: 9, p1: 1, p2: 1 }),
  badLat: reading({ loc: 702, lat: 95, lon: 9, p1: 1, p2: 1 }),
  badLon: reading({ loc: 703, lat: 45, lon: 181, p1: 1, p2: 1 }),
  nullIsland: reading({ loc: 704, lat: 0, lon: 0, p1: 1, p2: 1 }),
  badTime: reading({
    loc: 705,
    lat: 45,
    lon: 9,
    p1: 1,
    p2: 1,
    time: 'yesterday',
  }),
  feb31: reading({
    loc: 706,
    lat: 45,
    lon: 9,
    p1: 1,
    p2: 1,
    time: '2026-02-31 08:00:00',
  }),
  tooOld: reading({
    loc: 707,
    lat: 45,
    lon: 9,
    p1: 1,
    p2: 1,
    time: '2026-10-25 04:00:00',
  }),
  future: reading({
    loc: 708,
    lat: 45,
    lon: 9,
    p1: 1,
    p2: 1,
    time: '2026-10-25 11:00:00',
  }),
  humidityOnly: reading({
    loc: 709,
    lat: 45,
    lon: 9,
    values: [{ id: 3, value: '55.2', value_type: 'humidity' }],
  }),
  noLocation: { id: 1, timestamp: '2026-10-25 08:50:00', sensordatavalues: [] },
  noValues: {
    ...reading({ loc: 710, lat: 45, lon: 9, p1: 1, p2: 1 }),
    sensordatavalues: 'x',
  },
});

/** The hand-written air payload: cell A, the other cells and every bad reading. */
export const AIR_READINGS = Object.freeze([
  ...CELL_A_READINGS,
  ...Object.values(CELL_A_BAD_READINGS),
  ...OTHER_CELL_READINGS,
  ...Object.values(BAD_AIR_READINGS),
  null,
  'garbage',
]);

/** One Safecast measurement row. */
export function measurement({
  id = nextId++,
  value,
  unit = 'cpm',
  device = null,
  at,
  lat,
  lon,
}) {
  return {
    id,
    user_id: 304,
    value,
    unit,
    location_name: null,
    device_id: device,
    original_id: id,
    measurement_import_id: null,
    captured_at: at,
    height: 72,
    devicetype_id: null,
    sensor_id: null,
    station_id: null,
    channel_id: null,
    latitude: lat,
    longitude: lon,
  };
}

/**
 * Rows that become features, in the order the layer serves them (newest
 * first). Device 65002 reports twice: only the 08:58 row counts.
 */
export const GOOD_RADIATION_ROWS = Object.freeze([
  measurement({
    id: 11,
    device: 65002,
    value: 42,
    at: '2026-10-25T08:55:52.000Z',
    lat: 34.482657,
    lon: 136.163205,
  }),
  measurement({
    id: 12,
    device: 65002,
    value: 50,
    at: '2026-10-25T08:58:00.000Z',
    lat: 34.482657,
    lon: 136.163205,
  }),
  // 08:50, cpm newer than the earlier µSv/h row of the same device.
  measurement({
    id: 21,
    device: 401,
    value: 0.1,
    unit: 'usv',
    at: '2026-10-25T08:00:00.000Z',
    lat: 51.2,
    lon: 6.8,
  }),
  measurement({
    id: 22,
    device: 401,
    value: 167,
    at: '2026-10-25T08:50:00.000Z',
    lat: 51.2,
    lon: 6.8,
  }),
  // Same instant: the µSv/h row wins although its id is lower.
  measurement({
    id: 31,
    device: 400,
    value: 0.2,
    unit: 'usv',
    at: '2026-10-25T08:40:00.000Z',
    lat: -12.0464,
    lon: -77.0428,
  }),
  measurement({
    id: 32,
    device: 400,
    value: 100,
    at: '2026-10-25T08:40:00.000Z',
    lat: -12.0464,
    lon: -77.0428,
  }),
  // 334 cpm is exactly 1 µSv/h at the nominal factor.
  measurement({
    id: 41,
    device: 301,
    value: 334,
    at: '2026-10-25T08:30:00.000Z',
    lat: 51.0,
    lon: 7.0,
  }),
  // No device: one reading per 0.01 degree cell, newest kept (30, not 32).
  measurement({
    id: 51,
    device: null,
    value: 32,
    at: '2026-10-25T08:10:00.000Z',
    lat: 47.65443,
    lon: 8.60453,
  }),
  measurement({
    id: 52,
    device: null,
    value: 30,
    at: '2026-10-25T08:20:00.000Z',
    lat: 47.6549,
    lon: 8.6049,
  }),
  // A device read directly as µSv/h.
  measurement({
    id: 61,
    device: 255,
    value: 0.095,
    unit: 'usv',
    at: '2026-10-25T08:00:11.000Z',
    lat: 39.0287,
    lon: -76.5834,
  }),
  // Device id 0 is no device.
  measurement({
    id: 71,
    device: 0,
    value: 25,
    at: '2026-10-25T07:30:00.000Z',
    lat: 53.85,
    lon: 10.69,
  }),
]);

/** Rows that must never become a feature, each for a different reason. */
export const BAD_RADIATION_ROWS = Object.freeze({
  temperature: measurement({
    device: 9001,
    value: 22.8,
    unit: 'celcius',
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  status: measurement({
    device: 9002,
    value: 32.6,
    unit: 'status',
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  unknownUnit: measurement({
    device: 9003,
    value: 17,
    unit: '211',
    at: '2026-10-25T08:50:00.000Z',
    lat: 51.4,
    lon: 7.0,
  }),
  zero: measurement({
    device: 9004,
    value: 0,
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  negative: measurement({
    device: 9005,
    value: -5,
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  hugeCpm: measurement({
    device: 9006,
    value: 334001,
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  hugeUsv: measurement({
    device: 9007,
    value: 1000.5,
    unit: 'usv',
    at: '2026-10-25T08:50:00.000Z',
    lat: 37.4,
    lon: 139.9,
  }),
  badLat: measurement({
    device: 9008,
    value: 40,
    at: '2026-10-25T08:50:00.000Z',
    lat: 91,
    lon: 9,
  }),
  badLon: measurement({
    device: 9009,
    value: 40,
    at: '2026-10-25T08:50:00.000Z',
    lat: 45,
    lon: -181,
  }),
  nullIsland: measurement({
    device: 9010,
    value: 40,
    at: '2026-10-25T08:50:00.000Z',
    lat: 0,
    lon: 0,
  }),
  futureYear: measurement({
    device: 9011,
    value: 40,
    at: '2029-11-01T13:49:46.000Z',
    lat: 45,
    lon: 9,
  }),
  tooOld: measurement({
    device: 9012,
    value: 40,
    at: '2026-10-25T02:00:00.000Z',
    lat: 45,
    lon: 9,
  }),
  noTime: measurement({ device: 9013, value: 40, at: null, lat: 45, lon: 9 }),
  notANumber: measurement({
    device: 9014,
    value: 'abc',
    at: '2026-10-25T08:50:00.000Z',
    lat: 45,
    lon: 9,
  }),
});

/** The hand-written radiation payload. */
export const RADIATION_ROWS = Object.freeze([
  ...GOOD_RADIATION_ROWS,
  ...Object.values(BAD_RADIATION_ROWS),
  null,
  'garbage',
]);

/**
 * A Safecast upstream double's answer for one URL: the rows whose
 * captured_at falls in [captured_after, captured_before], oldest first, one
 * `per_page` page of them.
 */
export function safecastAnswer(url, rows = RADIATION_ROWS) {
  const query = new URL(url).searchParams;
  const after = Date.parse(query.get('captured_after'));
  const before = Date.parse(query.get('captured_before'));
  const perPage = Number(query.get('per_page'));
  const page = Number(query.get('page'));
  const inWindow = rows
    .filter((row) => {
      const ms = Date.parse(row?.captured_at);
      return Number.isFinite(ms) && ms >= after && ms <= before;
    })
    .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
  return inWindow.slice((page - 1) * perPage, page * perPage);
}
