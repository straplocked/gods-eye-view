import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIRSPACE_LAYER_ID,
  airportLookupUrl,
  arcPoints,
  buildDelayFeatures,
  circleRing,
  closureWindowFromNotam,
  destinationPoint,
  distanceMeters,
  finishRing,
  icaoCandidate,
  initialBearing,
  normalizeAirportLookup,
  normalizeFaaStatus,
  normalizeTfrDetail,
  normalizeTfrList,
  parseClosureClock,
  parseDelayMinutes,
  parseStatusTime,
  parseXnotamCoordinate,
  programSeverity,
  radiusToMeters,
  tfrCategory,
  tfrDetailUrl,
  tfrExpired,
  tfrPageUrl,
  xnotamTime,
} from './records.js';
import { assertValidKeylessLayerCollection } from '../../testSupport/geojson.mjs';
import {
  AWC_AIRPORTS,
  BAD_LIST_ROWS,
  FAA_STATUS_CLOSURES_ONLY_XML,
  FAA_STATUS_EMPTY_XML,
  FAA_STATUS_XML,
  NOW_MS,
  TFR_DETAILS,
  TFR_LIST,
  arc,
  area,
  cir,
  grc,
  xnotam,
} from '../../testSupport/airspaceFixtures.mjs';

const entries = normalizeTfrList(TFR_LIST);
const entry = (notamId) => entries.find((item) => item.notamId === notamId);
const detail = (notamId) =>
  normalizeTfrDetail(TFR_DETAILS[notamId], entry(notamId));
const only = (xml) =>
  normalizeTfrDetail(xml, entry('6/2117')).features[0]?.geometry;

/** The collection as the keyless proxy would serve it, for the shared validator. */
function served(features, source) {
  return {
    type: 'FeatureCollection',
    features: features.map((feature) => ({
      ...feature,
      id: `${source}:${feature.id}`,
      properties: {
        ...feature.properties,
        layer: AIRSPACE_LAYER_ID,
        source,
      },
    })),
    metadata: {
      layer: AIRSPACE_LAYER_ID,
      fetchedAt: '2026-10-25T11:00:00.000Z',
      stale: false,
      partial: false,
      sources: [],
    },
  };
}

// An independent great-circle distance (mean Earth radius 6371 km), so the
// geometry tests do not lean on the module's own constants.
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const shoelace = (ring) => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++)
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return sum / 2;
};

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ?? 'value'} ${actual} not within ${tolerance} of ${expected}`,
  );

// ---------------------------------------------------------------------------
// TFR list
// ---------------------------------------------------------------------------

test('the TFR list keeps usable rows in order and skips ids that are not NOTAM ids', () => {
  const list = normalizeTfrList([...TFR_LIST, ...BAD_LIST_ROWS]);
  assert.deepEqual(
    list.map(({ notamId }) => notamId),
    [
      '6/2117',
      '6/0100',
      '6/1751',
      '6/2102',
      '6/9954',
      '6/1500',
      '6/0001',
      '6/0002',
    ],
  );
  assert.deepEqual(
    list.map(({ category }) => category),
    [
      'hazards',
      'security',
      'vip',
      'security',
      'security',
      'airshow',
      'hazards',
      'space',
    ],
  );
  assert.deepEqual(list[0], {
    notamId: '6/2117',
    type: 'HAZARDS',
    category: 'hazards',
    facility: 'ZDV',
    state: 'CO',
    description:
      'PAGOSA SPRINGS, CO, Sunday, October 25, 2026 through Sunday, November 1, 2026 UTC',
    created: '10/25/2026',
  });
  assert.equal(normalizeTfrList(TFR_LIST, { max: 3 }).length, 3);
  assert.deepEqual(normalizeTfrList([]), []);
});

test('a list that is not an array is a corrupt payload', () => {
  for (const bad of [null, undefined, 'x', 42, { notam_id: '6/1' }]) {
    assert.throws(() => normalizeTfrList(bad), { code: 'invalid_payload' });
  }
});

test('TFR categories map the FAA type names; anything else is other', () => {
  assert.equal(tfrCategory('VIP'), 'vip');
  assert.equal(tfrCategory(' security '), 'security');
  assert.equal(tfrCategory('AIR SHOWS/SPORTS'), 'airshow');
  assert.equal(tfrCategory('UAS PUBLIC GATHERING'), 'uas');
  assert.equal(tfrCategory('SPACE OPERATIONS'), 'space');
  for (const unknown of [
    'FIRE',
    '',
    null,
    undefined,
    '__proto__',
    'constructor',
  ])
    assert.equal(tfrCategory(unknown), 'other');
});

test('URLs are built only from NOTAM ids', () => {
  assert.equal(
    tfrDetailUrl('6/2117'),
    'https://tfr.faa.gov/download/detail_6_2117.xml',
  );
  assert.equal(
    tfrPageUrl('6/2117'),
    'https://tfr.faa.gov/tfr3/?page=detail_6_2117',
  );
  for (const bad of ['../x', '6/2117/../..', 'FDC 6/1', '', '6_2117'])
    assert.throws(() => tfrDetailUrl(bad), TypeError);
});

// ---------------------------------------------------------------------------
// XNOTAM times and coordinates
// ---------------------------------------------------------------------------

test('XNOTAM local times are converted with the zone offsets, hand-checked', () => {
  assert.equal(
    xnotamTime('2026-10-25T13:00:00', 'UTC'),
    '2026-10-25T13:00:00.000Z',
  );
  // EDT is UTC-4: 21:00 local is 01:00 the next day.
  assert.equal(
    xnotamTime('2026-10-31T21:00:00', 'EDT'),
    '2026-11-01T01:00:00.000Z',
  );
  assert.equal(
    xnotamTime('2026-10-24T23:30:00', 'CDT'),
    '2026-10-25T04:30:00.000Z',
  );
  assert.equal(
    xnotamTime('2026-10-25T00:00:00', 'MST'),
    '2026-10-25T07:00:00.000Z',
  );
  assert.equal(
    xnotamTime('2026-10-25T08:00:00', 'AKDT'),
    '2026-10-25T16:00:00.000Z',
  );
  // Guam is UTC+10.
  assert.equal(
    xnotamTime('2026-10-25T10:00:00', 'Guam'),
    '2026-10-25T00:00:00.000Z',
  );
  assert.equal(
    xnotamTime('2026-10-25T10:00', 'UTC'),
    '2026-10-25T10:00:00.000Z',
  );
  // A zone the table does not know, or a malformed time, is unknown rather than guessed.
  assert.equal(xnotamTime('2026-10-25T10:00:00', 'ATLANTIS'), null);
  assert.equal(xnotamTime('Oct 25 2026', 'UTC'), null);
  assert.equal(xnotamTime('', 'UTC'), null);
  assert.equal(xnotamTime(undefined, 'UTC'), null);
});

test('XNOTAM coordinates carry the hemisphere as a letter', () => {
  assert.equal(parseXnotamCoordinate('37.45527778N', 90), 37.45527778);
  assert.equal(parseXnotamCoordinate('107.13W', 180), -107.13);
  assert.equal(parseXnotamCoordinate('097.16361111W', 180), -97.16361111);
  assert.equal(parseXnotamCoordinate('12.5S', 90), -12.5);
  assert.equal(parseXnotamCoordinate('144.8E', 180), 144.8);
  assert.equal(parseXnotamCoordinate('-107.13', 180), -107.13);
  assert.equal(parseXnotamCoordinate('12.5', 90), 12.5);
  for (const bad of ['91N', 'abc', '', null, undefined, '1e9N', 'NaN'])
    assert.equal(parseXnotamCoordinate(bad, 90), null);
  assert.equal(parseXnotamCoordinate('181W', 180), null);
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

test('radii convert to metres; unknown units and non-positive radii are rejected', () => {
  assert.equal(radiusToMeters('1', 'NM'), 1852);
  assert.equal(radiusToMeters('2.5', 'nm'), 4630);
  assert.equal(radiusToMeters('3', undefined), 5556);
  assert.equal(radiusToMeters('5', 'KM'), 5000);
  assert.equal(radiusToMeters('300', 'M'), 300);
  assert.equal(radiusToMeters('1000', 'FT'), 304.8);
  assert.equal(radiusToMeters('1', 'SM'), 1609.344);
  for (const bad of [
    ['0', 'NM'],
    ['-1', 'NM'],
    ['x', 'NM'],
    ['', 'NM'],
    ['1', 'FURLONG'],
  ])
    assert.equal(radiusToMeters(...bad), null);
});

test('destination, bearing and distance agree with hand-checked values on the equator', () => {
  // One degree of longitude at the equator is 111.195 km on the mean sphere.
  const [lon, lat] = destinationPoint(10, 0, 90, 111_195);
  near(lon, 11, 0.001);
  near(lat, 0, 0.001);
  const [lon2, lat2] = destinationPoint(10, 0, 0, 111_195);
  near(lon2, 10, 0.001);
  near(lat2, 1, 0.001);
  near(initialBearing(10, 0, 11, 0), 90, 1e-6);
  near(initialBearing(10, 0, 10, 1), 0, 1e-6);
  near(initialBearing(10, 0, 9, 0), 270, 1e-6);
  near(distanceMeters(10, 0, 11, 0), 111_195, 5);
  // Longitudes fold across the antimeridian.
  near(destinationPoint(179.9, 0, 90, 22_239)[0], -179.9, 0.001);
});

test('finishRing closes, dedupes, rounds to ~1 m, and winds counter-clockwise', () => {
  const clockwise = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];
  const ring = finishRing(clockwise);
  assert.deepEqual(ring, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);
  assert.ok(shoelace(ring) > 0);
  // Already closed and counter-clockwise input is kept, with a repeated vertex dropped.
  assert.deepEqual(
    finishRing([
      [0, 0],
      [1, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  );
  assert.deepEqual(
    finishRing([
      [0.1234567, 0.7654321],
      [1, 0],
      [1, 1],
    ])[0],
    [0.12346, 0.76543],
  );
});

test('finishRing refuses degenerate, invalid and antimeridian-crossing shapes', () => {
  assert.equal(finishRing([]), null);
  assert.equal(
    finishRing([
      [0, 0],
      [1, 1],
    ]),
    null,
  );
  // Three collinear points enclose nothing.
  assert.equal(
    finishRing([
      [0, 0],
      [1, 1],
      [2, 2],
    ]),
    null,
  );
  assert.equal(
    finishRing([
      [0, 0],
      [1, 95],
      [2, 2],
    ]),
    null,
  );
  assert.equal(
    finishRing([
      [0, 0],
      [NaN, 1],
      [2, 2],
    ]),
    null,
  );
  assert.equal(
    finishRing([
      [179.9, 10],
      [-179.9, 10],
      [-179.9, 11],
    ]),
    null,
  );
});

// ---------------------------------------------------------------------------
// TFR detail
// ---------------------------------------------------------------------------

test('a TFR with a merged polygon becomes one area feature with hand-written properties', () => {
  const { features, noGeometry } = detail('6/2117');
  assert.equal(noGeometry, false);
  assert.equal(features.length, 1);
  const [feature] = features;
  assert.equal(feature.type, 'Feature');
  assert.equal(feature.id, '6/2117#1');
  // The FAA lists the corners clockwise; the feature is counter-clockwise (RFC 7946).
  assert.deepEqual(feature.geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [-107.39167, 37.45528],
        [-107.43639, 37.00139],
        [-107.13, 37.00139],
        [-107.12472, 37.45528],
        [-107.39167, 37.45528],
      ],
    ],
  });
  assert.deepEqual(feature.properties, {
    notam: '6/2117',
    type: 'HAZARDS',
    category: 'hazards',
    facility: 'ZDV',
    state: 'CO',
    description:
      'PAGOSA SPRINGS, CO, Sunday, October 25, 2026 through Sunday, November 1, 2026 UTC',
    location: 'PAGOSA SPRINGS, COLORADO',
    regulation: '91.137(a)(2)',
    area: 'Hazard Area1',
    areaIndex: 1,
    areaCount: 1,
    lowerFt: 0,
    lowerRef: 'AGL',
    upperFt: 1000,
    upperRef: 'AGL',
    scheduled: true,
    effective: '2026-10-25T13:00:00.000Z',
    expire: '2026-11-01T01:00:00.000Z',
    text: '!FDC 6/2117 ZDV CO..AIRSPACE PAGOSA SPRINGS, CO..TEMPORARY FLIGHT RESTRICTIONS.',
    link: 'https://tfr.faa.gov/tfr3/?page=detail_6_2117',
    timestamp: '2026-10-25T02:46:47.000Z',
  });
});

test('GUARD: a circular TFR (center + radius in NM) becomes a closed polygon whose vertices sit at the hand-computed radius', () => {
  // 6/0100: a 1 NM circle about 26.07194444N 097.16361111W, no merged polygon.
  const { features } = detail('6/0100');
  assert.equal(features.length, 1);
  const { geometry } = features[0];
  assert.equal(geometry.type, 'Polygon');
  const ring = geometry.coordinates[0];
  // 36 vertices (every 10 degrees) plus the closing one.
  assert.equal(ring.length, 37);
  assert.deepEqual(ring[0], ring[36]);
  assert.equal(new Set(ring.slice(0, 36).map(String)).size, 36);
  const center = [-97.16361111, 26.07194444];
  const nauticalMileKm = 1.852;
  for (const vertex of ring.slice(0, 36))
    near(
      haversineKm(center, vertex) / nauticalMileKm,
      1,
      0.005,
      `radius at ${vertex}`,
    );
  // Hand-computed extremes. One NM is 1/60 degree of latitude (0.016655 on
  // the mean sphere); due east it is that over cos(26.07194 deg) = 0.89824.
  const lons = ring.map(([lon]) => lon);
  const lats = ring.map(([, lat]) => lat);
  near(Math.max(...lats), 26.07194444 + 0.016655, 0.0001, 'north');
  near(Math.min(...lats), 26.07194444 - 0.016655, 0.0001, 'south');
  near(Math.max(...lons), -97.16361111 + 0.018542, 0.0001, 'east');
  near(Math.min(...lons), -97.16361111 - 0.018542, 0.0001, 'west');
  // Counter-clockwise, as RFC 7946 asks.
  assert.ok(shoelace(ring) > 0);
});

test('a 30 NM circle sits at 30 NM all the way round, at 47 degrees north', () => {
  const geometry = only(
    xnotam({
      seq: 1,
      effective: '2026-10-25T13:00:00',
      areas: [area({ shapes: [[cir('47.0N', '120.0W', '30')]] })],
    }),
  );
  const ring = geometry.coordinates[0];
  assert.equal(ring.length, 37);
  for (const vertex of ring.slice(0, 36))
    near(
      haversineKm([-120, 47], vertex) / 1.852,
      30,
      0.15,
      `radius at ${vertex}`,
    );
  // 30 NM is half a degree of latitude (0.49966 on the mean sphere).
  near(Math.max(...ring.map(([, lat]) => lat)), 47.4997, 0.001, 'north');
  near(Math.min(...ring.map(([, lat]) => lat)), 46.5003, 0.001, 'south');
});

test('circleRing places each vertex at its bearing and radius', () => {
  const ring = circleRing(-97, 26, 5556, 4);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  // Four vertices: north, east, south, west; 3 NM is 0.04997 degrees of latitude.
  near(ring[0][1], 26.04997, 0.0001, 'north latitude');
  near(ring[0][0], -97, 1e-9, 'north longitude');
  near(ring[2][1], 25.95003, 0.0001, 'south latitude');
  const eastWest = 0.04997 / Math.cos((26 * Math.PI) / 180);
  near(ring[1][0], -97 + eastWest, 0.0002, 'east');
  near(ring[3][0], -97 - eastWest, 0.0002, 'west');
});

test('a clockwise arc is built about its center from the previous vertex to the next', () => {
  const { features } = detail('6/1751');
  assert.equal(features.length, 1);
  const ring = features[0].geometry.coordinates[0];
  // A, B, the interior arc points (17 or 18 at <= 10 degrees for a ~180 degree sweep), A again.
  assert.ok(ring.length === 20 || ring.length === 21, `ring ${ring.length}`);
  const center = [-110.34944444, 31.5775];
  const eightNmKm = 8 * 1.852;
  // Every vertex is on the 8 NM circle (the corners were quoted to 8 NM).
  for (const vertex of ring)
    near(
      haversineKm(center, vertex) / eightNmKm,
      1,
      0.005,
      `radius at ${vertex}`,
    );
  // Clockwise from the west corner over the top to the east corner: the shape is the northern cap.
  near(
    Math.max(...ring.map(([, lat]) => lat)),
    31.5775 + 8 / 60,
    0.002,
    'north',
  );
  assert.ok(ring.every(([, lat]) => lat > 31.5775 - 0.012));
  assert.ok(shoelace(ring) > 0);
  assert.deepEqual(ring[0], ring.at(-1));
});

test('a counter-clockwise arc bulges the other way', () => {
  const geometry = only(
    xnotam({
      seq: 3,
      effective: '2026-10-25T13:00:00',
      areas: [
        area({
          shapes: [
            [
              grc('31.58694444N', '110.50555556W'),
              arc('CCA', '31.5775N', '110.34944444W', '8.0'),
              grc('31.56805556N', '110.19333333W'),
              grc('31.58694444N', '110.50555556W'),
            ],
          ],
        }),
      ],
    }),
  );
  const ring = geometry.coordinates[0];
  // From the west corner (bearing ~274) counter-clockwise runs through south to the east corner.
  near(
    Math.min(...ring.map(([, lat]) => lat)),
    31.5775 - 8 / 60,
    0.002,
    'south',
  );
  assert.ok(ring.every(([, lat]) => lat < 31.5775 + 0.012));
});

test('arcPoints sweeps at most 10 degrees per segment and never repeats an end', () => {
  const center = { lon: 0, lat: 0 };
  // A quarter circle of radius 1 NM, clockwise from north to east.
  const from = destinationPoint(0, 0, 0, 1852);
  const to = destinationPoint(0, 0, 90, 1852);
  const points = arcPoints(center, 1852, from, to, true);
  assert.equal(points.length, 8);
  for (const point of points) near(distanceMeters(0, 0, ...point), 1852, 1);
  near(initialBearing(0, 0, ...points[0]), 10, 0.2, 'first');
  near(initialBearing(0, 0, ...points.at(-1)), 80, 0.2, 'last');
  // Ends that coincide make a full circle.
  assert.equal(arcPoints(center, 1852, from, from, true).length, 35);
});

test('when both exist, the FAA merged polygon is used, not the shapes', () => {
  // 6/2102: merged square around Atlanta; the fixture's circle is in Kansas.
  const ring = detail('6/2102').features[0].geometry.coordinates[0];
  assert.ok(
    ring.every(
      ([lon, lat]) =>
        lon >= -84.4 && lon <= -84.36 && lat >= 33.74 && lat <= 33.78,
    ),
  );
  assert.equal(ring.length, 5);
});

test('times, altitudes and flags come from the XNOTAM with hand-checked values', () => {
  const edt = detail('6/2102').features[0].properties;
  assert.equal(edt.effective, '2026-11-01T01:00:00.000Z');
  assert.equal(edt.expire, '2026-11-01T05:00:00.000Z');
  assert.deepEqual(
    [edt.lowerFt, edt.lowerRef, edt.upperFt, edt.upperRef],
    [0, 'AGL', 3000, 'MSL'],
  );
  assert.equal(edt.scheduled, false);
  const cdt = detail('6/0100').features[0].properties;
  assert.equal(cdt.effective, '2026-10-25T04:30:00.000Z');
  assert.equal(cdt.expire, '2026-10-26T09:00:00.000Z');
  assert.equal(cdt.upperFt, 6000);
  assert.equal(cdt.regulation, '99.7');
  const mst = detail('6/1751').features[0].properties;
  assert.equal(mst.effective, '2026-10-25T07:00:00.000Z');
  assert.equal(mst.area, null);
  assert.deepEqual(
    [mst.lowerFt, mst.lowerRef, mst.upperFt, mst.upperRef],
    [0, 'MSL', 17999, 'MSL'],
  );
});

test('a NOTAM with several areas yields one feature per area, flight levels in feet', () => {
  const { features } = detail('6/1500');
  assert.deepEqual(
    features.map(({ id }) => id),
    ['6/1500#1', '6/1500#2'],
  );
  const [a, b] = features.map(({ properties }) => properties);
  assert.deepEqual([a.area, a.areaIndex, a.areaCount], ['Area A', 1, 2]);
  assert.deepEqual([b.area, b.areaIndex, b.areaCount], ['Area B', 2, 2]);
  assert.deepEqual(
    [a.lowerFt, a.lowerRef, a.upperFt, a.upperRef],
    [1000, 'MSL', 3500, 'MSL'],
  );
  // FL035 to FL180.
  assert.deepEqual(
    [b.lowerFt, b.lowerRef, b.upperFt, b.upperRef],
    [3500, 'FL', 18000, 'FL'],
  );
  assert.equal(features[0].geometry.coordinates[0].length, 5);
  assert.equal(features[1].geometry.coordinates[0].length, 37);
});

test('a NOTAM without geometry yields no feature and says so', () => {
  const result = detail('6/9954');
  assert.deepEqual(result, { features: [], noGeometry: true });
});

test('an unknown time zone leaves the times unknown but keeps the area', () => {
  const { features } = detail('6/0002');
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.effective, null);
  assert.equal(features[0].properties.expire, null);
  assert.equal(features[0].properties.regulation, '91.137(a)(1)');
});

test('expiry is judged against the clock, not cached state', () => {
  const expired = detail('6/0001').features[0].properties;
  assert.equal(tfrExpired(expired, NOW_MS), true);
  assert.equal(
    tfrExpired({ expire: '2026-10-25T11:00:00.000Z' }, NOW_MS),
    true,
  );
  assert.equal(
    tfrExpired({ expire: '2026-10-25T11:00:00.001Z' }, NOW_MS),
    false,
  );
  assert.equal(tfrExpired({ expire: null }, NOW_MS), false);
  assert.equal(tfrExpired({}, NOW_MS), false);
  assert.equal(tfrExpired(undefined, NOW_MS), false);
});

test('shapes that cannot be drawn are skipped, the rest of the NOTAM survives', () => {
  const good = area({
    name: 'Good',
    merged: [
      grc('10.0N', '020.0E'),
      grc('10.0N', '020.2E'),
      grc('10.2N', '020.2E'),
      grc('10.0N', '020.0E'),
    ],
  });
  const badAreas = [
    // Out-of-range latitude.
    area({
      name: 'lat',
      merged: [
        grc('95.0N', '020.0E'),
        grc('10.0N', '020.2E'),
        grc('10.2N', '020.2E'),
      ],
    }),
    // Non-numeric longitude.
    area({
      name: 'nan',
      merged: [
        grc('10.0N', 'abcE'),
        grc('10.0N', '020.2E'),
        grc('10.2N', '020.2E'),
      ],
    }),
    // Two vertices only.
    area({
      name: 'two',
      merged: [grc('10.0N', '020.0E'), grc('10.0N', '020.2E')],
    }),
    // Collinear: zero area.
    area({
      name: 'flat',
      merged: [
        grc('10.0N', '020.0E'),
        grc('10.1N', '020.1E'),
        grc('10.2N', '020.2E'),
      ],
    }),
    // A vertex type this layer cannot draw (national border following).
    area({
      name: 'fnt',
      merged: [
        grc('10.0N', '020.0E'),
        '<Avx><codeType>FNT</codeType><geoLat>10.1N</geoLat><geoLong>020.1E</geoLong></Avx>',
        grc('10.2N', '020.2E'),
      ],
    }),
    // Crosses the antimeridian.
    area({
      name: 'dateline',
      merged: [
        grc('10.0N', '179.9E'),
        grc('10.0N', '179.9W'),
        grc('10.2N', '179.9W'),
      ],
    }),
    // A circle with no radius.
    area({ name: 'radius', shapes: [[cir('10.0N', '020.0E', '0')]] }),
    // An arc with no vertex before it.
    area({
      name: 'arc',
      shapes: [[arc('CWA', '10.0N', '020.0E', '5'), grc('10.0N', '020.1E')]],
    }),
  ];
  const { features, noGeometry } = normalizeTfrDetail(
    xnotam({
      seq: 9,
      effective: '2026-10-25T13:00:00',
      areas: [...badAreas, good],
    }),
    entry('6/2117'),
  );
  assert.equal(noGeometry, false);
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.area, 'Good');
  // The ids count areas in the document, so skipped areas leave a gap.
  assert.equal(features[0].id, '6/2117#9');
  // An open ring (last vertex != first) is closed.
  assert.equal(features[0].geometry.coordinates[0].length, 4);
});

test('a merged polygon that cannot be read falls back to the shapes', () => {
  const geometry = only(
    xnotam({
      seq: 10,
      effective: '2026-10-25T13:00:00',
      areas: [
        area({
          merged: [grc('95N', '020E'), grc('10N', '020E'), grc('10N', '021E')],
          shapes: [[cir('10.0N', '020.0E', '2')]],
        }),
      ],
    }),
  );
  assert.equal(geometry.coordinates[0].length, 37);
});

test('several shapes without a merged polygon make a MultiPolygon', () => {
  const geometry = only(
    xnotam({
      seq: 11,
      effective: '2026-10-25T13:00:00',
      areas: [
        area({
          shapes: [
            [cir('10.0N', '020.0E', '2')],
            [cir('11.0N', '021.0E', '3')],
          ],
        }),
      ],
    }),
  );
  assert.equal(geometry.type, 'MultiPolygon');
  assert.equal(geometry.coordinates.length, 2);
  assert.equal(geometry.coordinates[0][0].length, 37);
});

test('a body that is not an XNOTAM document with a notice is a corrupt payload', () => {
  for (const bad of [
    '<html><body>Service unavailable</body></html>',
    'plain text',
    '',
    '<XNOTAM-Update><Group/></XNOTAM-Update>',
    '<Other><Not/></Other>',
    '<XNOTAM-Update><Group><Add><Not>',
  ]) {
    assert.throws(
      () => normalizeTfrDetail(bad, entry('6/2117')),
      { code: 'invalid_payload' },
      bad,
    );
  }
});

test('every TFR feature validates as an RFC 7946 keyless collection', () => {
  const features = entries.flatMap(({ notamId }) => detail(notamId).features);
  // Seven NOTAMs with geometry; 6/1500 has two areas.
  assert.equal(features.length, 8);
  assertValidKeylessLayerCollection(served(features, 'tfr'), AIRSPACE_LAYER_ID);
});

// ---------------------------------------------------------------------------
// NAS Status
// ---------------------------------------------------------------------------

test('durations in the status feed parse to minutes', () => {
  assert.equal(parseDelayMinutes('1 hour and 30 minutes'), 90);
  assert.equal(parseDelayMinutes('3 hours and 4 minutes'), 184);
  assert.equal(parseDelayMinutes('46 minutes'), 46);
  assert.equal(parseDelayMinutes('1 hour'), 60);
  assert.equal(parseDelayMinutes('2 hours'), 120);
  assert.equal(parseDelayMinutes('1 minute'), 1);
  assert.equal(parseDelayMinutes('1 hr 5 min'), 65);
  for (const bad of ['', 'soon', null, undefined, '99999 minutes'])
    assert.equal(parseDelayMinutes(bad), null);
});

test('the feed clock parses to ISO UTC', () => {
  assert.equal(
    parseStatusTime('Sun Oct 25 11:07:49 2026 GMT'),
    '2026-10-25T11:07:49.000Z',
  );
  assert.equal(
    parseStatusTime('Mon Jan 5 00:00:00 2026 UTC'),
    '2026-01-05T00:00:00.000Z',
  );
  for (const bad of ['', 'yesterday', 'Sun Foo 25 11:07:49 2026 GMT', null])
    assert.equal(parseStatusTime(bad), null);
});

test('a closure window comes from the NOTAM text when it has one, else from the clock', () => {
  assert.deepEqual(
    closureWindowFromNotam('!LAX 05/277 LAX AD AP CLSD 2605271826-2705281600'),
    { start: '2026-05-27T18:26:00.000Z', reopen: '2027-05-28T16:00:00.000Z' },
  );
  assert.equal(closureWindowFromNotam('!LAX 05/277 LAX AD AP CLSD'), null);
  assert.equal(closureWindowFromNotam('x 2613271826-2705281600'), null);
  assert.equal(closureWindowFromNotam(undefined), null);
  // "Oct 25 at 05:00 UTC." has no year: the nearest year to now wins.
  assert.equal(
    parseClosureClock('Oct 25 at 05:00 UTC.', NOW_MS),
    '2026-10-25T05:00:00.000Z',
  );
  assert.equal(
    parseClosureClock('Jan 02 at 06:00 UTC.', NOW_MS),
    '2027-01-02T06:00:00.000Z',
  );
  assert.equal(
    parseClosureClock('Dec 31 at 23:00 UTC.', NOW_MS),
    '2026-12-31T23:00:00.000Z',
  );
  assert.equal(
    parseClosureClock('May 27 at 18:26 UTC.', NOW_MS),
    '2026-05-27T18:26:00.000Z',
  );
  assert.equal(parseClosureClock('whenever', NOW_MS), null);
});

test('the status feed becomes airports with severity-ordered programs, hand-checked', () => {
  const status = normalizeFaaStatus(FAA_STATUS_XML, { nowMs: NOW_MS });
  assert.equal(status.updated, '2026-10-25T10:55:03.000Z');
  assert.deepEqual(status.airports, [
    {
      airport: 'EWR',
      programs: [
        { type: 'ground-delay', reason: 'thunderstorms', avg: 90, max: 184 },
      ],
    },
    {
      airport: 'JFK',
      programs: [
        {
          type: 'ground-stop',
          reason: 'low ceilings & fog',
          endTime: '3:15 pm EDT',
        },
        {
          type: 'arrival-delay',
          reason: 'WEATHER / LOW CEILINGS',
          min: 31,
          max: 45,
          trend: 'increasing',
        },
      ],
    },
    {
      airport: 'ORD',
      programs: [
        {
          type: 'departure-delay',
          reason: 'TM Initiatives:MIT:VOLUME',
          min: 46,
          max: 60,
          trend: 'steady',
        },
      ],
    },
    {
      airport: 'ZZZ',
      programs: [
        {
          type: 'departure-delay',
          reason: 'VOLUME',
          min: 16,
          max: 30,
          trend: 'decreasing',
        },
      ],
    },
    {
      airport: 'HNL',
      programs: [
        {
          type: 'closure',
          reason: '!HNL 10/050 HNL RWY 8R/26L CLSD 2610250900-2610251500',
          start: '2026-10-25T09:00:00.000Z',
          reopen: '2026-10-25T15:00:00.000Z',
        },
      ],
    },
    {
      airport: 'ASE',
      programs: [
        {
          type: 'closure',
          reason:
            '!ASE 10/220 ASE AD AP CLSD EXC LIFE FLT HEL AND SAR HEL 30MIN PPR 970-379-8406 2610250500-2610251300',
          start: '2026-10-25T05:00:00.000Z',
          reopen: '2026-10-25T13:00:00.000Z',
        },
        {
          type: 'closure',
          reason: '!ASE 10/221 ASE AD APRON CLSD',
          start: '2026-12-31T23:00:00.000Z',
          reopen: '2027-01-02T06:00:00.000Z',
        },
      ],
    },
  ]);
});

test('the quiet-day feed (closures only) and the empty feed parse', () => {
  const quiet = normalizeFaaStatus(FAA_STATUS_CLOSURES_ONLY_XML, {
    nowMs: NOW_MS,
  });
  assert.equal(quiet.updated, '2026-10-25T08:49:58.000Z');
  assert.equal(quiet.airports.length, 1);
  assert.equal(quiet.airports[0].airport, 'LAX');
  assert.equal(quiet.airports[0].programs[0].start, '2026-05-27T18:26:00.000Z');
  assert.equal(
    quiet.airports[0].programs[0].reopen,
    '2027-05-28T16:00:00.000Z',
  );
  assert.deepEqual(
    normalizeFaaStatus(FAA_STATUS_EMPTY_XML, { nowMs: NOW_MS }),
    {
      updated: '2026-10-25T08:49:58.000Z',
      airports: [],
    },
  );
});

test('rows without a usable airport or program are skipped', () => {
  const xml = `<AIRPORT_STATUS_INFORMATION><Update_Time>nonsense</Update_Time>
<Delay_type><Name>Ground</Name><Ground_Delay_List>
  <Ground_Delay><Reason>no airport</Reason><Avg>5 minutes</Avg></Ground_Delay>
  <Ground_Delay><ARPT>../../x</ARPT><Reason>bad id</Reason></Ground_Delay>
  <Ground_Delay><ARPT> bos </ARPT><Reason>  rain   and
  wind </Reason><Avg>soon</Avg><Max>2 hours</Max></Ground_Delay>
</Ground_Delay_List></Delay_type>
<Delay_type><Name>AD</Name><Arrival_Departure_Delay_List>
  <Delay><ARPT>SFO</ARPT><Reason>x</Reason><Arrival_Departure Type="Sideways"><Min>5 minutes</Min></Arrival_Departure></Delay>
</Arrival_Departure_Delay_List></Delay_type>
</AIRPORT_STATUS_INFORMATION>`;
  const status = normalizeFaaStatus(xml, { nowMs: NOW_MS });
  assert.equal(status.updated, null);
  assert.deepEqual(status.airports, [
    {
      airport: 'BOS',
      programs: [{ type: 'ground-delay', reason: 'rain and wind', max: 120 }],
    },
  ]);
});

test('a body that is not the status document is a corrupt payload', () => {
  for (const bad of [
    '<html><body>Maintenance</body></html>',
    'plain text',
    '',
    '<AIRPORT_STATUS_INFORMATION>',
    '<Other/>',
  ]) {
    assert.throws(
      () => normalizeFaaStatus(bad),
      { code: 'invalid_payload' },
      bad,
    );
  }
});

test('program severity ranks a ground stop above everything and a closure last', () => {
  assert.ok(programSeverity('ground-stop') > programSeverity('ground-delay'));
  assert.ok(programSeverity('ground-delay') > programSeverity('arrival-delay'));
  assert.ok(
    programSeverity('arrival-delay') > programSeverity('departure-delay'),
  );
  assert.ok(programSeverity('departure-delay') > programSeverity('closure'));
  assert.equal(programSeverity('unknown'), 0);
});

// ---------------------------------------------------------------------------
// Airports
// ---------------------------------------------------------------------------

test('FAA identifiers map to the ICAO code to look up', () => {
  assert.equal(icaoCandidate('JFK'), 'KJFK');
  assert.equal(icaoCandidate('jfk'), 'KJFK');
  assert.equal(icaoCandidate('5B2'), 'K5B2');
  assert.equal(icaoCandidate('ANC'), 'PANC');
  assert.equal(icaoCandidate('HNL'), 'PHNL');
  assert.equal(icaoCandidate('SJU'), 'TJSJ');
  assert.equal(icaoCandidate('GUM'), 'PGUM');
  assert.equal(icaoCandidate('SPN'), 'PGSN');
  assert.equal(icaoCandidate('KJFK'), 'KJFK');
  for (const bad of ['', 'AB', '../x', 'TOOLONG', null, undefined, 'a b'])
    assert.equal(icaoCandidate(bad), null);
});

test('the lookup URL carries only well-formed ids', () => {
  assert.equal(
    airportLookupUrl(['KJFK', 'KEWR']),
    'https://aviationweather.gov/api/data/airport?ids=KJFK,KEWR&format=json',
  );
  assert.equal(
    airportLookupUrl(['KJFK', 'x&y=1', '../', 'PHNL']),
    'https://aviationweather.gov/api/data/airport?ids=KJFK,PHNL&format=json',
  );
  assert.throws(() => airportLookupUrl([]), TypeError);
  assert.throws(() => airportLookupUrl(['??']), TypeError);
});

test('the airport lookup normalizes to positions; 204 is empty; junk is skipped or refused', () => {
  const airports = normalizeAirportLookup(Object.values(AWC_AIRPORTS));
  assert.equal(airports.length, 6);
  assert.deepEqual(airports[0], {
    icao: 'KEWR',
    name: 'NEWARK/NEWARK LIBERTY INTL',
    lon: -74.1687,
    lat: 40.6925,
  });
  assert.deepEqual(normalizeAirportLookup(null), []);
  assert.deepEqual(normalizeAirportLookup([]), []);
  assert.deepEqual(
    normalizeAirportLookup([
      null,
      'x',
      { icaoId: 'KBAD', lat: 95, lon: 0.5 },
      { icaoId: 'KNAN', lat: 'x', lon: 1 },
      { icaoId: 'KZER', lat: 0, lon: 0 },
      { lat: 10, lon: 10 },
      { icaoId: '../..', lat: 10, lon: 10 },
      { icaoId: 'KGOO', lat: '10.5', lon: '-20.25', name: ' Good ' },
    ]),
    [{ icao: 'KGOO', name: 'Good', lon: -20.25, lat: 10.5 }],
  );
  for (const bad of [{}, 'x', 42])
    assert.throws(() => normalizeAirportLookup(bad), {
      code: 'invalid_payload',
    });
});

test('GUARD: a ground-delay record yields a point at the resolved airport coordinates', () => {
  const status = normalizeFaaStatus(FAA_STATUS_XML, { nowMs: NOW_MS });
  // FAA id by hand, not through the module's mapping.
  const faaIds = {
    KEWR: 'EWR',
    KJFK: 'JFK',
    KORD: 'ORD',
    KASE: 'ASE',
    PHNL: 'HNL',
    KLAX: 'LAX',
  };
  const located = new Map(
    normalizeAirportLookup(Object.values(AWC_AIRPORTS)).map((place) => [
      faaIds[place.icao],
      place,
    ]),
  );
  const { features, unresolved } = buildDelayFeatures(status, located);
  const ewr = features.find(({ id }) => id === 'EWR');
  assert.deepEqual(ewr.geometry, {
    type: 'Point',
    coordinates: [-74.1687, 40.6925],
  });
  assert.equal(ewr.properties.delayType, 'ground-delay');
  assert.equal(ewr.properties.airport, 'EWR');
  assert.equal(ewr.properties.reason, 'thunderstorms');
  assert.equal(ewr.properties.avg, 90);
  assert.equal(ewr.properties.max, 184);
  assert.equal(ewr.properties.timestamp, '2026-10-25T10:55:03.000Z');
  // ZZZ has no coordinates: listed, not drawn.
  assert.deepEqual(unresolved, ['ZZZ']);
  assert.deepEqual(
    features.map(({ id }) => id),
    ['EWR', 'JFK', 'ORD', 'HNL', 'ASE'],
  );
});

test('an airport point is flattened from its most severe program and keeps them all', () => {
  const status = normalizeFaaStatus(FAA_STATUS_XML, { nowMs: NOW_MS });
  const located = new Map([
    [
      'JFK',
      {
        icao: 'KJFK',
        name: 'NEW YORK/JOHN F KENNEDY INTL',
        lon: -73.7787,
        lat: 40.6399,
      },
    ],
  ]);
  const { features } = buildDelayFeatures(
    {
      ...status,
      airports: status.airports.filter(({ airport }) => airport === 'JFK'),
    },
    located,
  );
  assert.equal(features.length, 1);
  assert.deepEqual(features[0].properties, {
    airport: 'JFK',
    icao: 'KJFK',
    name: 'NEW YORK/JOHN F KENNEDY INTL',
    delayType: 'ground-stop',
    reason: 'low ceilings & fog',
    endTime: '3:15 pm EDT',
    programCount: 2,
    programs: [
      {
        type: 'ground-stop',
        reason: 'low ceilings & fog',
        endTime: '3:15 pm EDT',
      },
      {
        type: 'arrival-delay',
        reason: 'WEATHER / LOW CEILINGS',
        min: 31,
        max: 45,
        trend: 'increasing',
      },
    ],
    link: 'https://nasstatus.faa.gov/',
    timestamp: '2026-10-25T10:55:03.000Z',
  });
});

test('every delay feature validates as an RFC 7946 keyless collection', () => {
  const status = normalizeFaaStatus(FAA_STATUS_XML, { nowMs: NOW_MS });
  const located = new Map(
    [
      ['EWR', 'KEWR'],
      ['JFK', 'KJFK'],
      ['ORD', 'KORD'],
      ['HNL', 'PHNL'],
      ['ASE', 'KASE'],
    ].map(([faa, icao]) => [
      faa,
      normalizeAirportLookup([AWC_AIRPORTS[icao]])[0],
    ]),
  );
  const { features } = buildDelayFeatures(status, located);
  assert.equal(features.length, 5);
  assertValidKeylessLayerCollection(
    served(features, 'delays'),
    AIRSPACE_LAYER_ID,
  );
});
