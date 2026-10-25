import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AQI_CATEGORIES,
  MAX_RADIATION_FEATURES,
  SAFECAST_MEASUREMENTS_URL,
  aqiCategory,
  aqiFromPm25,
  median,
  normalizeAirPm,
  normalizeRadiation,
  safecastUrl,
} from './records.js';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  AIR_READINGS,
  BAD_AIR_READINGS,
  BAD_RADIATION_ROWS,
  CELL_A_BAD_READINGS,
  CELL_A_READINGS,
  GOOD_RADIATION_ROWS,
  NOW_MS,
  OTHER_CELL_READINGS,
  RADIATION_ROWS,
  measurement,
  pmValues,
  reading,
} from '../../testSupport/citizenSensorsFixtures.mjs';

const air = (readings, options) =>
  normalizeAirPm(readings, { nowMs: NOW_MS, ...options });
const radiation = (rows, options) =>
  normalizeRadiation(rows, { nowMs: NOW_MS, ...options });

/** The cells the hand-written air payload must produce, busiest first. */
const EXPECTED_CELLS = [
  {
    id: '1891_1385',
    coordinates: [9.15, 48.55],
    properties: {
      pm25: 28,
      pm10: 47.5,
      sensors: 4,
      aqi: 86,
      category: 'moderate',
      timestamp: '2026-10-25T08:55:00.000Z',
    },
  },
  {
    id: '1093_565',
    coordinates: [-70.65, -33.45],
    properties: {
      pm25: 9,
      pm10: 13,
      sensors: 2,
      aqi: 50,
      category: 'good',
      timestamp: '2026-10-25T08:35:00.000Z',
    },
  },
  {
    id: '1823_1388',
    coordinates: [2.35, 48.85],
    properties: {
      pm25: 9.1,
      pm10: null,
      sensors: 1,
      aqi: 51,
      category: 'moderate',
      timestamp: '2026-10-25T08:20:00.000Z',
    },
  },
  {
    id: '2572_1186',
    coordinates: [77.25, 28.65],
    properties: {
      pm25: 1000,
      pm10: 1000,
      sensors: 1,
      aqi: 500,
      category: 'hazardous',
      timestamp: '2026-10-25T08:10:00.000Z',
    },
  },
  {
    id: '2964_1299',
    coordinates: [116.45, 39.95],
    properties: {
      pm25: 150,
      pm10: 200,
      sensors: 1,
      aqi: 225,
      category: 'very-unhealthy',
      timestamp: '2026-10-25T08:58:00.000Z',
    },
  },
  {
    id: '3599_1000',
    coordinates: [179.95, 10.05],
    properties: {
      pm25: 5,
      pm10: 6,
      sensors: 1,
      aqi: 28,
      category: 'good',
      timestamp: '2026-10-25T08:05:00.000Z',
    },
  },
];

test('GUARD: indoor and implausible readings are filtered, and each cell serves its hand-computed median and AQI category', () => {
  const { features } = air(AIR_READINGS);
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  // Cell A holds four outdoor sensors with PM2.5 10, 20, 40 and 36 (location
  // 101's older 999 report is superseded). The median of the four is
  // (20 + 36) / 2 = 28.0, not their mean (26.5) and not what the indoor 500
  // or the implausible values would make it.
  const a = byId.get('1891_1385');
  assert.equal(a.properties.pm25, 28);
  assert.equal(a.properties.pm10, 47.5);
  assert.equal(a.properties.sensors, 4);
  // 28.0 µg/m³ is "moderate" (9.1-35.4) at AQI 86.
  assert.equal(a.properties.category, 'moderate');
  assert.equal(a.properties.aqi, 86);
  // The single 150 µg/m³ sensor lands in "very unhealthy".
  assert.equal(byId.get('2964_1299').properties.category, 'very-unhealthy');
  // A reading of exactly 1000 is the largest plausible value; 1000.01 is not.
  assert.equal(byId.get('2572_1186').properties.pm25, 1000);
  assert.equal(features.length, 6);
});

test('the hand-written air payload becomes exactly the expected cells', () => {
  const result = air(AIR_READINGS);
  assert.equal(result.type, 'FeatureCollection');
  assert.deepEqual(
    result.features,
    EXPECTED_CELLS.map(({ id, coordinates, properties }) => ({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates },
      properties,
    })),
  );
  // Ten distinct outdoor locations survive the filters.
  assert.deepEqual(result.details, { sensors: 10 });
  assertValidFeatureCollection(result);
});

test('a reading that is indoors, implausible or unusable never reaches a cell', () => {
  const good = CELL_A_READINGS[0];
  const bad = {
    ...CELL_A_BAD_READINGS,
    ...BAD_AIR_READINGS,
    nullEntry: null,
    text: 'garbage',
  };
  for (const [name, entry] of Object.entries(bad)) {
    const { features, details } = air([good, entry]);
    assert.equal(features.length, 1, name);
    assert.equal(features[0].properties.sensors, 1, name);
    assert.equal(features[0].properties.pm25, 10, name);
    assert.deepEqual(details, { sensors: 1 }, name);
  }
});

test('indoor must be an explicit outdoor flag: 0, "0" and false pass, anything else does not', () => {
  const at = (indoor) =>
    reading({ loc: 1, lat: 10, lon: 10, p1: 3, p2: 2, indoor });
  for (const indoor of [0, '0', false])
    assert.equal(air([at(indoor)]).features.length, 1, String(indoor));
  for (const indoor of [1, '1', true, null, 2, 'no']) {
    assert.throws(() => air([at(indoor), at(indoor)]), {
      code: 'invalid_payload',
    });
  }
});

test('PM boundaries: 0 and 1000 are readings, a negative or 1000.01 is a faulty sensor', () => {
  const sensor = (p2, p1 = 5) => reading({ loc: 1, lat: 10, lon: 10, p1, p2 });
  assert.equal(air([sensor(0)]).features[0].properties.pm25, 0);
  assert.equal(air([sensor(1000)]).features[0].properties.pm25, 1000);
  for (const bad of [-0.01, 1000.01, 'x', '']) {
    assert.throws(() => air([sensor(bad)]), { code: 'invalid_payload' });
  }
  // A PM10 channel that is present but impossible drops the whole reading;
  // an absent one only leaves PM10 null.
  assert.throws(() => air([sensor(10, 1000.01)]), { code: 'invalid_payload' });
  assert.throws(() => air([sensor(10, -1)]), { code: 'invalid_payload' });
  const noPm10 = air([
    reading({ loc: 1, lat: 10, lon: 10, values: pmValues(undefined, 12) }),
  ]);
  assert.equal(noPm10.features[0].properties.pm10, null);
  assert.equal(noPm10.features[0].properties.pm25, 12);
});

test('a location reported twice keeps its newest reading; a tie keeps the higher reading id', () => {
  const at = (time, p2, id) =>
    reading({ loc: 7, lat: 10.01, lon: 10.01, p1: 1, p2, time, id });
  const newerLast = air([
    at('2026-10-25 08:00:00', 100, 1),
    at('2026-10-25 08:30:00', 20, 2),
  ]);
  assert.equal(newerLast.features[0].properties.pm25, 20);
  const newerFirst = air([
    at('2026-10-25 08:30:00', 20, 2),
    at('2026-10-25 08:00:00', 100, 1),
  ]);
  assert.equal(newerFirst.features[0].properties.pm25, 20);
  const tie = air([
    at('2026-10-25 08:30:00', 20, 9),
    at('2026-10-25 08:30:00', 30, 3),
  ]);
  assert.equal(tie.features[0].properties.pm25, 20);
  assert.equal(tie.features[0].properties.sensors, 1);
});

test('the grid is exact at cell edges, in every hemisphere, and clamps longitude 180', () => {
  const idOf = (lat, lon) =>
    air([reading({ loc: 1, lat, lon, p1: 1, p2: 1 })]).features[0].id;
  // 9.2 starts cell 1892; 9.1999 is the last of 1891 (no float drift).
  assert.equal(idOf(48.5, 9.2), '1892_1385');
  assert.equal(idOf(48.5, 9.1999), '1891_1385');
  // 48.5 starts latitude cell 1385; 48.4999 is the last of 1384.
  assert.equal(idOf(48.4999, 9.2), '1892_1384');
  assert.equal(idOf(-33.45, -70.65), '1093_565');
  // -180 is the first column; 180 and 89.99 are clamped into the last ones.
  assert.equal(idOf(-90, -180), '0_0');
  assert.equal(idOf(89.99, 179.99), '3599_1799');
  assert.equal(idOf(90, 180), '3599_1799');
  // Cell centers are the middle of the cell, not any sensor's position.
  const { coordinates } = air([
    reading({ loc: 1, lat: 48.5, lon: 9.2, p1: 1, p2: 1 }),
  ]).features[0].geometry;
  assert.deepEqual(coordinates, [9.25, 48.55]);
});

test('cells are ordered busiest first, then by id', () => {
  const readings = [];
  const place = (count, lat, lon) => {
    for (let i = 0; i < count; i++)
      readings.push(
        reading({ loc: readings.length + 1, lat, lon, p1: 1, p2: 1 }),
      );
  };
  place(1, 20.05, 20.05);
  place(3, 30.05, 30.05);
  place(1, 10.05, 10.05);
  place(2, 40.05, 40.05);
  assert.deepEqual(
    air(readings).features.map((f) => [f.id, f.properties.sensors]),
    [
      ['2100_1200', 3],
      ['2200_1300', 2],
      ['1900_1000', 1],
      ['2000_1100', 1],
    ],
  );
});

test('median is the middle value, the mean of the middle pair when even, rounded to 0.1', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([40, 10, 36, 20]), 28);
  assert.equal(median([1, 2, 3, 100000]), 2.5);
  // The mean of the middle pair rounds half up to 0.1.
  assert.equal(median([1.2, 1.3]), 1.3);
  assert.equal(median([1.21, 1.23]), 1.2);
  // One stuck sensor does not move the median of a neighborhood.
  assert.equal(median([8, 9, 9, 10, 1000]), 9);
});

test('EPA AQI: category edges and index values, from the published 2024 PM2.5 table', () => {
  const table = [
    [0, 'good', 0],
    [9.0, 'good', 50],
    [9.09, 'good', 50],
    [9.1, 'moderate', 51],
    [12, 'moderate', 56],
    [20, 'moderate', 71],
    [35.4, 'moderate', 100],
    [35.5, 'usg', 101],
    [55.4, 'usg', 150],
    [55.5, 'unhealthy', 151],
    [75, 'unhealthy', 165],
    [125.4, 'unhealthy', 200],
    [125.5, 'very-unhealthy', 201],
    [225.4, 'very-unhealthy', 300],
    [225.5, 'hazardous', 301],
    [325.4, 'hazardous', 500],
    [1000, 'hazardous', 500],
  ];
  for (const [pm25, category, aqi] of table) {
    assert.equal(aqiCategory(pm25), category, `category of ${pm25}`);
    assert.equal(aqiFromPm25(pm25), aqi, `AQI of ${pm25}`);
  }
  for (const bad of [-0.1, NaN, undefined, null, '5', Infinity]) {
    assert.equal(aqiCategory(bad), null, String(bad));
    assert.equal(aqiFromPm25(bad), null, String(bad));
  }
  assert.deepEqual(AQI_CATEGORIES, [
    'good',
    'moderate',
    'usg',
    'unhealthy',
    'very-unhealthy',
    'hazardous',
  ]);
});

test('a payload that is not an array, or has no usable outdoor reading, throws and is never an empty map', () => {
  for (const payload of [null, undefined, {}, 'text', 5, { readings: [] }]) {
    assert.throws(() => air(payload), { code: 'invalid_payload' });
  }
  assert.throws(() => air([]), { code: 'invalid_payload' });
  assert.throws(() => air(Object.values(BAD_AIR_READINGS)), {
    code: 'invalid_payload',
  });
  // Every reading stale: the file stopped updating.
  assert.throws(() => air(CELL_A_READINGS, { nowMs: NOW_MS + 4 * 3_600_000 }), {
    code: 'invalid_payload',
  });
  assert.ok(air(OTHER_CELL_READINGS).features.length > 0);
});

test('readings are accepted in the Sensor.Community time format and ISO', () => {
  const at = (time) =>
    air([reading({ loc: 1, lat: 10, lon: 10, p1: 1, p2: 1, time })]).features[0]
      .properties.timestamp;
  assert.equal(at('2026-10-25 08:50:00'), '2026-10-25T08:50:00.000Z');
  assert.equal(at('2026-10-25T08:50:00Z'), '2026-10-25T08:50:00.000Z');
});

test('Safecast: the hand-written payload becomes exactly the expected devices, newest first', () => {
  const result = radiation(RADIATION_ROWS);
  const props = (device, unit, cpm, usv, usvEstimated, timestamp) => ({
    device,
    unit,
    cpm,
    usv,
    usvEstimated,
    timestamp,
  });
  assert.deepEqual(
    result.features.map(({ id, geometry, properties }) => [
      id,
      geometry.coordinates,
      properties,
    ]),
    [
      [
        'd65002',
        [136.163, 34.483],
        props(65002, 'cpm', 50, 0.15, true, '2026-10-25T08:58:00.000Z'),
      ],
      [
        'd401',
        [6.8, 51.2],
        props(401, 'cpm', 167, 0.5, true, '2026-10-25T08:50:00.000Z'),
      ],
      [
        'd400',
        [-77.043, -12.046],
        props(400, 'usv', null, 0.2, false, '2026-10-25T08:40:00.000Z'),
      ],
      [
        'd301',
        [7, 51],
        props(301, 'cpm', 334, 1, true, '2026-10-25T08:30:00.000Z'),
      ],
      [
        'g18860_13765',
        [8.605, 47.655],
        props(null, 'cpm', 30, 0.09, true, '2026-10-25T08:20:00.000Z'),
      ],
      [
        'd255',
        [-76.583, 39.029],
        props(255, 'usv', null, 0.095, false, '2026-10-25T08:00:11.000Z'),
      ],
      [
        'g19069_14385',
        [10.69, 53.85],
        props(null, 'cpm', 25, 0.075, true, '2026-10-25T07:30:00.000Z'),
      ],
    ],
  );
  assert.deepEqual(result.details, { rows: RADIATION_ROWS.length });
  assert.ok(result.features.every((f) => f.geometry.type === 'Point'));
  assertValidFeatureCollection(result);
});

test('Safecast: no user identifier and no raw position leaves the normalizer', () => {
  const text = JSON.stringify(radiation(RADIATION_ROWS));
  assert.doesNotMatch(text, /user/i);
  assert.doesNotMatch(text, /304/);
  assert.doesNotMatch(text, /34\.482657|136\.163205/);
});

test('Safecast: a row that is not a dose reading, is implausible or is unusable never becomes a device', () => {
  const good = GOOD_RADIATION_ROWS[1];
  for (const [name, row] of Object.entries({
    ...BAD_RADIATION_ROWS,
    nullEntry: null,
    text: 'garbage',
  })) {
    const { features } = radiation([good, row]);
    assert.deepEqual(
      features.map((f) => f.id),
      ['d65002'],
      name,
    );
  }
});

test('Safecast: 1000 µSv/h and its cpm equivalent are the largest plausible readings', () => {
  const at = (value, unit) =>
    radiation([
      measurement({
        device: 5,
        value,
        unit,
        at: '2026-10-25T08:50:00.000Z',
        lat: 10,
        lon: 10,
      }),
    ]).features[0].properties;
  assert.equal(at(1000, 'usv').usv, 1000);
  assert.equal(at(334000, 'cpm').usv, 1000);
  assert.throws(() => at(1000.01, 'usv'), { code: 'invalid_payload' });
  assert.throws(() => at(334000.5, 'cpm'), { code: 'invalid_payload' });
  assert.throws(() => at(0, 'cpm'), { code: 'invalid_payload' });
});

test("Safecast: a device's newest reading wins regardless of row order", () => {
  const at = (id, value, time) =>
    measurement({ id, device: 5, value, at: time, lat: 10, lon: 10 });
  for (const rows of [
    [at(1, 100, '2026-10-25T08:00:00Z'), at(2, 200, '2026-10-25T08:30:00Z')],
    [at(2, 200, '2026-10-25T08:30:00Z'), at(1, 100, '2026-10-25T08:00:00Z')],
  ]) {
    const { features } = radiation(rows);
    assert.equal(features.length, 1);
    assert.equal(features[0].properties.cpm, 200);
  }
});

test('Safecast: only the newest 600 devices are served', () => {
  const rows = [];
  for (let device = 1; device <= 650; device++)
    rows.push(
      measurement({
        device,
        value: 40,
        // Device 1 is the oldest, 650 the newest, one second apart.
        at: new Date(NOW_MS - 3_600_000 + device * 1000).toISOString(),
        lat: 10 + (device % 50) * 0.01,
        lon: 10,
      }),
    );
  const { features } = radiation(rows);
  assert.equal(MAX_RADIATION_FEATURES, 600);
  assert.equal(features.length, 600);
  assert.equal(features[0].id, 'd650');
  assert.equal(features.at(-1).id, 'd51');
});

test('Safecast: a payload that is not an array, or has no usable reading, throws', () => {
  for (const payload of [null, {}, 'text', 5]) {
    assert.throws(() => radiation(payload), { code: 'invalid_payload' });
  }
  assert.throws(() => radiation([]), { code: 'invalid_payload' });
  assert.throws(() => radiation(Object.values(BAD_RADIATION_ROWS)), {
    code: 'invalid_payload',
  });
  assert.throws(
    () => radiation(GOOD_RADIATION_ROWS, { nowMs: NOW_MS + 8 * 3_600_000 }),
    { code: 'invalid_payload' },
  );
});

test('Safecast URLs are fixed: the host, a UTC second-precision window and a page', () => {
  assert.equal(
    SAFECAST_MEASUREMENTS_URL,
    'https://api.safecast.org/measurements.json',
  );
  assert.equal(
    safecastUrl(Date.UTC(2026, 9, 25, 8, 0, 0), Date.UTC(2026, 9, 25, 9, 0, 0)),
    'https://api.safecast.org/measurements.json?captured_after=2026-10-25T08:00:00Z&captured_before=2026-10-25T09:00:00Z&per_page=1000&page=1',
  );
  assert.equal(
    safecastUrl(
      Date.UTC(2026, 9, 25, 7, 0, 0, 999),
      Date.UTC(2026, 9, 25, 8, 0, 0, 999),
      3,
    ),
    'https://api.safecast.org/measurements.json?captured_after=2026-10-25T07:00:00Z&captured_before=2026-10-25T08:00:00Z&per_page=1000&page=3',
  );
});
