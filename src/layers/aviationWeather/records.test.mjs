import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLIGHT_CATEGORIES,
  cleanRing,
  deriveFlightCategory,
  normalizeMetars,
  normalizeSigmets,
  parseCsv,
} from './records.js';
import {
  GOOD_METAR_ROWS,
  METAR_HEADER,
  NOW_MS,
  collection,
  internationalAdvisory,
  internationalPayload,
  metarCsv,
  metarRow,
  usAdvisory,
  usPayload,
} from '../../testSupport/aviationWeatherFixtures.mjs';
import {
  assertValidFeatureCollection,
  assertValidKeylessLayerCollection,
} from '../../testSupport/geojson.mjs';

const stamp = (collection, source) => ({
  ...collection,
  features: collection.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      layer: 'aviation-weather',
      source,
    },
  })),
});
const byId = (collection, id) =>
  collection.features.find((feature) => feature.id === id);

test('FAA thresholds: the worse of ceiling and visibility decides, at every boundary', () => {
  const cases = [
    // [visibility, ceiling, expected]
    [10, null, 'VFR'],
    [5.01, 3001, 'VFR'],
    [5, null, 'MVFR'],
    [6, 3000, 'MVFR'],
    [3, 5000, 'MVFR'],
    [10, 1000, 'MVFR'],
    [2.99, 5000, 'IFR'],
    [10, 999, 'IFR'],
    [1, 5000, 'IFR'],
    [10, 500, 'IFR'],
    [0.99, 5000, 'LIFR'],
    [10, 499, 'LIFR'],
    [10, 0, 'LIFR'],
    // The worse element wins whichever it is.
    [2, 800, 'IFR'],
    [0.5, 4000, 'LIFR'],
    [8, 400, 'LIFR'],
    [4, 700, 'IFR'],
  ];
  for (const [visibilityMi, ceilingFt, expected] of cases)
    assert.equal(
      deriveFlightCategory({ visibilityMi, ceilingFt }),
      expected,
      `vis ${visibilityMi} ceiling ${ceilingFt}`,
    );
  // Unknown visibility is never guessed from the ceiling alone.
  assert.equal(
    deriveFlightCategory({ visibilityMi: null, ceilingFt: 300 }),
    null,
  );
  assert.deepEqual(FLIGHT_CATEGORIES, ['VFR', 'MVFR', 'IFR', 'LIFR']);
});

test('parseCsv handles quoted commas, doubled quotes, CRLF and blank lines', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n"x,y","he said ""hi""",\n\nlast,,'), [
    ['a', 'b', 'c'],
    ['x,y', 'he said "hi"', ''],
    ['last', '', ''],
  ]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
  assert.deepEqual(parseCsv(''), []);
  assert.equal(parseCsv('a\nb\nc\nd\n', 2).length, 2);
});

test('METAR rows become one point per station with hand-checked properties', () => {
  const result = normalizeMetars(metarCsv(...GOOD_METAR_ROWS), {
    nowMs: NOW_MS,
  });
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    ['KSEA', 'KCAG', 'EGLL', 'KSRR', 'LFPG', 'PHNL', 'KJDN'],
  );
  assert.deepEqual(byId(result, 'KSEA'), {
    type: 'Feature',
    id: 'KSEA',
    geometry: { type: 'Point', coordinates: [-122.3138, 47.4444] },
    properties: {
      station: 'KSEA',
      category: 'VFR',
      wdir: 180,
      wspd: 8,
      vis: 10,
      visPlus: true,
      // FEW does not make a ceiling; BKN at 25,000 does.
      ceiling: 25000,
      temp: 12,
      dew: 8,
      altim: 30.12,
      raw: 'METAR KSEA 251053Z 18008KT 10SM FEW040 BKN250 12/08 A3012',
      timestamp: '2026-10-25T10:53:00.000Z',
    },
  });
  assert.deepEqual(byId(result, 'KCAG').properties, {
    station: 'KCAG',
    category: 'IFR',
    type: 'SPECI',
    wdir: 210,
    wspd: 5,
    wgst: 15,
    vis: 2,
    // SCT 200 is not a ceiling; the lowest BKN is 600.
    ceiling: 600,
    temp: 1.7,
    dew: 1.7,
    altim: 30.21,
    wx: 'BR',
    raw: 'SPECI KCAG 251050Z AUTO 21005G15KT 2SM BR SCT002 BKN006 OVC100 02/02 A3021',
    timestamp: '2026-10-25T10:50:00.000Z',
  });
  // Quoted field with a comma and quotes survives intact.
  assert.equal(
    byId(result, 'EGLL').properties.raw,
    'METAR EGLL 251050Z 24012KT 6SM BKN025 14/10 Q1012 RMK "TEST", COMMA',
  );
  assert.equal(byId(result, 'EGLL').properties.category, 'MVFR');
  // Vertical visibility (OVX) counts as a ceiling.
  assert.equal(byId(result, 'KSRR').properties.ceiling, 100);
  assert.equal(byId(result, 'KSRR').properties.category, 'LIFR');
  // Calm wind is 0, not missing.
  assert.equal(byId(result, 'PHNL').properties.wspd, 0);
  assert.equal(byId(result, 'PHNL').properties.wdir, 0);
  assert.equal('ceiling' in byId(result, 'PHNL').properties, false);
});

test('GUARD: a missing flight category is derived (ceiling 800 ft + 2 SM is IFR) and an unknown one stays null', () => {
  const result = normalizeMetars(metarCsv(...GOOD_METAR_ROWS), {
    nowMs: NOW_MS,
  });
  // The CSV spells the missing category "null": 800 ft ceiling and 2 SM -> IFR.
  assert.equal(byId(result, 'LFPG').properties.category, 'IFR');
  assert.equal(byId(result, 'LFPG').properties.ceiling, 800);
  assert.equal(byId(result, 'LFPG').properties.vis, 2);
  // An empty category with 10+ SM and no cloud -> VFR.
  assert.equal(byId(result, 'PHNL').properties.category, 'VFR');
  // No visibility reported and category "null" -> unknown, not VFR.
  assert.equal(byId(result, 'KJDN').properties.category, null);
  assert.equal('vis' in byId(result, 'KJDN').properties, false);

  // The same row with an empty category field and each boundary reading.
  const derived = (vis, base) =>
    normalizeMetars(
      metarCsv(
        metarRow(
          {
            raw_text: 'X',
            station_id: 'KTST',
            observation_time: '2026-10-25T10:40:00.000Z',
            latitude: '40',
            longitude: '-100',
            visibility_statute_mi: vis,
            flight_category: '',
          },
          base ? [['OVC', base]] : [],
        ),
      ),
      { nowMs: NOW_MS },
    ).features[0].properties.category;
  assert.equal(derived('2', 800), 'IFR');
  // Ceiling alone decides when visibility is good.
  assert.equal(derived('10+', 800), 'IFR');
  assert.equal(derived('2', 2000), 'IFR');
  assert.equal(derived('4', 2000), 'MVFR');
  assert.equal(derived('0.75', 4000), 'LIFR');
  assert.equal(derived('10+', 450), 'LIFR');
  assert.equal(derived('10+', 3500), 'VFR');
  // A reported category wins over the derivation.
  const reported = normalizeMetars(
    metarCsv(
      metarRow({
        raw_text: 'X',
        station_id: 'KTST',
        observation_time: '2026-10-25T10:40:00.000Z',
        latitude: '40',
        longitude: '-100',
        visibility_statute_mi: '10',
        flight_category: 'mvfr',
      }),
    ),
    { nowMs: NOW_MS },
  );
  assert.equal(reported.features[0].properties.category, 'MVFR');
});

test('bad METAR rows are skipped, the rest are served', () => {
  const row = (fields) =>
    metarRow({
      raw_text: 'METAR',
      observation_time: '2026-10-25T10:40:00.000Z',
      latitude: '40',
      longitude: '-100',
      flight_category: 'VFR',
      ...fields,
    });
  const csv = metarCsv(
    row({ station_id: 'KGOOD' }),
    row({ station_id: 'KNAN', latitude: 'abc' }),
    row({ station_id: 'KEMPTY', latitude: '' }),
    row({ station_id: 'KHIGH', latitude: '95' }),
    row({ station_id: 'KLON', longitude: '181' }),
    // AWC's missing-position sentinel.
    row({ station_id: 'KQEQ', latitude: '-99.9900', longitude: '-99.9900' }),
    row({ station_id: 'KZERO', latitude: '0', longitude: '0' }),
    row({ station_id: '', latitude: '41' }),
    row({ station_id: 'BAD ID!', latitude: '42' }),
    row({ station_id: 'KTIME', observation_time: 'yesterday' }),
    // 3h01m old at 11:00: past the limit.
    row({ station_id: 'KOLD', observation_time: '2026-10-25T07:59:00.000Z' }),
    row({ station_id: 'kLow', latitude: '43' }),
    // Out-of-range readings are dropped from the feature, not the station.
    row({
      station_id: 'KODD',
      latitude: '44',
      temp_c: '999',
      wind_speed_kt: '-5',
      wind_dir_degrees: 'VRB',
      altim_in_hg: '3012',
    }),
    // A short row still yields a station when the leading columns are there.
    'METAR,KSHORT,2026-10-25T10:40:00.000Z,40,-100',
  );
  const result = normalizeMetars(csv, { nowMs: NOW_MS });
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    ['KGOOD', 'KLOW', 'KODD', 'KSHORT'],
  );
  const odd = byId(result, 'KODD').properties;
  for (const key of ['temp', 'wspd', 'wdir', 'altim'])
    assert.equal(key in odd, false, `${key} should be dropped`);
});

test('a station listed twice keeps its newest observation', () => {
  const row = (time, wind) =>
    metarRow({
      raw_text: 'METAR',
      station_id: 'KDUP',
      observation_time: time,
      latitude: '40',
      longitude: '-100',
      wind_speed_kt: wind,
    });
  const result = normalizeMetars(
    metarCsv(
      row('2026-10-25T10:40:00.000Z', '5'),
      row('2026-10-25T10:50:00.000Z', '9'),
      row('2026-10-25T10:20:00.000Z', '1'),
    ),
    { nowMs: NOW_MS },
  );
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.wspd, 9);
});

test('notice lines before the header are tolerated; no header or a missing column throws', () => {
  const withNotice = `No errors\nNo warnings\n7 results\n${metarCsv(GOOD_METAR_ROWS[0])}`;
  assert.equal(
    normalizeMetars(withNotice, { nowMs: NOW_MS }).features.length,
    1,
  );
  for (const bad of [
    '<html>maintenance</html>',
    '',
    'station_id,latitude\nKSEA,47',
    // Header without a position column: the format changed.
    `${METAR_HEADER.replace(',longitude', ',lng')}\n`,
  ])
    assert.throws(
      () => normalizeMetars(bad, { nowMs: NOW_MS }),
      { code: 'invalid_payload' },
      JSON.stringify(bad.slice(0, 40)),
    );
  assert.throws(() => normalizeMetars(null), { code: 'invalid_payload' });
});

test('a header with no usable rows (or only stale ones) throws instead of an empty map', () => {
  assert.throws(() => normalizeMetars(metarCsv(), { nowMs: NOW_MS }), {
    code: 'invalid_payload',
  });
  assert.throws(
    () =>
      normalizeMetars(metarCsv(...GOOD_METAR_ROWS), {
        nowMs: NOW_MS + 24 * 3_600_000,
      }),
    { code: 'invalid_payload' },
  );
});

test('US advisories: SIGMET and AIRMET polygons with hand-checked properties', () => {
  const result = normalizeSigmets(usPayload, { kind: 'us', nowMs: NOW_MS });
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    [
      'sigmet-KKCI-15W-CONVECTIVE-202610251055',
      'airmet-KKCI-SFOT-TURB-202610251055',
    ],
  );
  const [convective, airmet] = result.features;
  assert.deepEqual(convective.properties, {
    advisory: 'sigmet',
    hazard: 'CONVECTIVE',
    severity: 5,
    top: 25000,
    issuer: 'KKCI',
    series: '15W',
    validFrom: '2026-10-25T10:55:00.000Z',
    validTo: '2026-10-25T12:55:00.000Z',
    raw: usPayload.features[0].properties.rawAirSigmet,
    timestamp: '2026-10-25T10:55:00.000Z',
  });
  // Two altitude bands: the lowest base and the highest top.
  assert.equal(airmet.properties.advisory, 'airmet');
  assert.equal(airmet.properties.base, 8000);
  assert.equal(airmet.properties.top, 18000);
  assert.equal('severity' in airmet.properties, false);
  assertValidKeylessLayerCollection(
    {
      ...stamp(result, 'sigmet'),
      metadata: {
        layer: 'aviation-weather',
        stale: false,
        sources: [],
      },
    },
    'aviation-weather',
  );
});

test('international advisories: qualifier, FIR, altitudes and trend', () => {
  const result = normalizeSigmets(internationalPayload, {
    kind: 'international',
    nowMs: NOW_MS,
  });
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    ['sigmet-MMMD-1-TURB-202610251000', 'sigmet-NZKL-18-VA-202610251000'],
  );
  assert.deepEqual(result.features[0].properties, {
    advisory: 'sigmet',
    hazard: 'TURB',
    qualifier: 'SEV',
    fir: 'MMFR',
    firName: 'MMFO MAZATLAN OCEANICA',
    base: 25000,
    top: 38000,
    change: 'WKN',
    issuer: 'MMMD',
    series: '1',
    validFrom: '2026-10-25T10:00:00.000Z',
    validTo: '2026-10-25T14:00:00.000Z',
    raw: internationalPayload.features[0].properties.rawSigmet,
    timestamp: '2026-10-25T10:00:00.000Z',
  });
  // A surface base is 0 and an absent top is omitted.
  const ash = result.features[1].properties;
  assert.equal(ash.base, 0);
  assert.equal('top' in ash, false);
  assert.equal(ash.qualifier, 'FUEGO');
});

test('GUARD: an open advisory ring is closed and 0..360 longitudes are folded into -180..180', () => {
  const open = internationalAdvisory(
    {},
    {
      type: 'Polygon',
      coordinates: [
        [
          [180.667, -57.5],
          [193.167, -55.167],
          [201.167, -48],
          [185, -45],
        ],
      ],
    },
  );
  const result = normalizeSigmets(collection(open), {
    kind: 'international',
    nowMs: NOW_MS,
  });
  assert.equal(result.features.length, 1);
  const [ring] = result.features[0].geometry.coordinates;
  // Closed: a fifth vertex equal to the first was appended.
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[4], ring[0]);
  // 180.667 -> -179.333, 193.167 -> -166.833, 201.167 -> -158.833, 185 -> -175.
  assert.deepEqual(ring, [
    [-179.333, -57.5],
    [-166.833, -55.167],
    [-158.833, -48],
    [-175, -45],
    [-179.333, -57.5],
  ]);
  // The shared validator agrees (closed rings, lon within range).
  assertValidFeatureCollection(result, { requireIds: true });
  for (const [lon] of ring) assert.ok(lon >= -180 && lon <= 180);
});

test('cleanRing closes, folds longitudes and refuses unusable rings', () => {
  assert.deepEqual(
    cleanRing([
      [0, 0],
      [10, 0],
      [10, 10],
    ]),
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ],
  );
  // Already closed rings are not extended.
  assert.equal(
    cleanRing([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 0],
    ]).length,
    4,
  );
  assert.deepEqual(
    cleanRing([
      [359.5, 1],
      [358, 1],
      [358, 2],
    ])[0],
    [-0.5, 1],
  );
  for (const bad of [
    null,
    'ring',
    [],
    [
      [0, 0],
      [1, 1],
    ],
    // Only two distinct vertices.
    [
      [0, 0],
      [1, 1],
      [0, 0],
      [1, 1],
    ],
    [
      [0, 0],
      [10, NaN],
      [10, 10],
    ],
    [
      [0, 0],
      [10, 91],
      [10, 10],
    ],
    [
      [0, 0],
      [400, 5],
      [10, 10],
    ],
    [[0, 0], 'x', [10, 10]],
  ])
    assert.equal(cleanRing(bad), null, JSON.stringify(bad));
});

test('bad advisories are skipped: no geometry, bad ring, expired, no hazard, wrong geometry type', () => {
  const good = usAdvisory();
  const feed = collection(
    good,
    usAdvisory({ seriesId: '1', hazard: 'ICE' }, null),
    usAdvisory(
      { seriesId: '2', hazard: 'ICE' },
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, NaN],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    ),
    usAdvisory({ seriesId: '3', validTimeTo: '2026-10-25T10:59:00.000Z' }),
    usAdvisory({ seriesId: '4', hazard: '' }),
    usAdvisory({ seriesId: '5' }, { type: 'Point', coordinates: [1, 2] }),
    { type: 'Feature', geometry: good.geometry, properties: null },
    null,
  );
  const result = normalizeSigmets(feed, { kind: 'us', nowMs: NOW_MS });
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    ['sigmet-KKCI-15W-CONVECTIVE-202610251055'],
  );
});

test('MultiPolygon keeps its good parts and drops bad holes; repeated ids get a suffix', () => {
  const part = [
    [-100, 30],
    [-99, 30],
    [-99, 31],
    [-100, 30],
  ];
  const multi = internationalAdvisory(
    {},
    {
      type: 'MultiPolygon',
      coordinates: [
        [part],
        // Outer ring unusable: the whole part goes.
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        // Good outer ring, one unusable hole.
        [
          [
            [-90, 30],
            [-80, 30],
            [-80, 40],
            [-90, 30],
          ],
          [
            [1, 1],
            [2, 2],
          ],
        ],
      ],
    },
  );
  const result = normalizeSigmets(
    collection(multi, internationalAdvisory({}, multi.geometry)),
    { kind: 'international', nowMs: NOW_MS },
  );
  assertValidFeatureCollection(result, { requireIds: true });
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0].geometry.type, 'MultiPolygon');
  assert.equal(result.features[0].geometry.coordinates.length, 2);
  assert.equal(result.features[0].geometry.coordinates[1].length, 1);
  assert.deepEqual(
    result.features.map((feature) => feature.id),
    ['sigmet-MMMD-1-TURB-202610251000', 'sigmet-MMMD-1-TURB-202610251000-2'],
  );
});

test('an empty advisory collection is legitimate; anything else throws', () => {
  for (const kind of ['us', 'international'])
    assert.deepEqual(normalizeSigmets(collection(), { kind, nowMs: NOW_MS }), {
      type: 'FeatureCollection',
      features: [],
    });
  for (const bad of [
    null,
    [],
    'x',
    {},
    { type: 'FeatureCollection' },
    { type: 'FeatureCollection', features: {} },
    { type: 'Feature', features: [] },
    { error: 'upstream detail' },
  ])
    assert.throws(
      () => normalizeSigmets(bad, { kind: 'us' }),
      { code: 'invalid_payload' },
      JSON.stringify(bad),
    );
});
