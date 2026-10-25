import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUOY_MAX_AGE_MS,
  FLOOD_CATEGORIES,
  KNOTS_PER_MS,
  MIN_GAUGES_LISTED,
  NWPS_TILES,
  floodRank,
  msToKnots,
  normalizeBuoys,
  normalizeGauges,
  nwpsTileUrl,
} from './records.js';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  ALL_GAUGES,
  BAD_BUOY_ROWS,
  FLOOD_GAUGES,
  FLOOD_GAUGE_IDS,
  GOOD_BUOY_ROWS,
  NDBC_HEADER,
  NOW_MS,
  OTHER_GAUGES,
  fillerGauges,
  ndbcText,
  nwpsTilePayload,
} from '../../testSupport/waterObservationsFixtures.mjs';

const options = { nowMs: NOW_MS };
const byId = (collection, id) =>
  collection.features.find((feature) => feature.id === id);
const invalid = { code: 'invalid_payload' };

test('guard: MM fields become null (not 0, not NaN) and a row yields the exact time and knots', () => {
  const collection = normalizeBuoys(ndbcText(GOOD_BUOY_ROWS[0]), options);
  assert.equal(collection.features.length, 1);
  // Hand-computed: 13.0 m/s x 3600 / 1852 = 25.27 kt -> 25.3; 16.0 m/s = 31.10 -> 31.1.
  assert.deepEqual(collection.features[0], {
    type: 'Feature',
    id: '41008',
    geometry: { type: 'Point', coordinates: [-80.866, 31.4] },
    properties: {
      station: '41008',
      windDir: 30,
      windMs: 13,
      windKt: 25.3,
      gustMs: 16,
      gustKt: 31.1,
      waveM: 2.4,
      wavePeriodS: 7,
      avgPeriodS: 5.4,
      waveDir: 76,
      pressureHpa: 1023.2,
      // The row says MM for these four.
      pressureTrendHpa: null,
      airC: 21,
      waterC: null,
      dewC: 19.4,
      visNmi: null,
      tideFt: null,
      timestamp: '2026-10-25T10:50:00.000Z',
    },
  });
});

test('every good row becomes one point with hand-written values, in file order', () => {
  const collection = normalizeBuoys(ndbcText(...GOOD_BUOY_ROWS), options);
  assertValidFeatureCollection(collection);
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['41008', '15009', '22108', '41004', 'BURL1'],
  );
  // 5.0 m/s = 9.72 kt -> 9.7. Latitude 0 is a real position.
  const gulf = byId(collection, '15009');
  assert.deepEqual(gulf.geometry.coordinates, [-3.051, 0]);
  assert.deepEqual(
    [
      gulf.properties.windDir,
      gulf.properties.windMs,
      gulf.properties.windKt,
      gulf.properties.gustMs,
      gulf.properties.gustKt,
      gulf.properties.waveM,
      gulf.properties.pressureHpa,
      gulf.properties.waterC,
      gulf.properties.timestamp,
    ],
    [160, 5, 9.7, null, null, null, 1011.3, 27.4, '2026-10-25T06:00:00.000Z'],
  );
  // Calm is a reading: 0 m/s, 0 kt, zero-length wave period; east longitude.
  const calm = byId(collection, '22108');
  assert.deepEqual(calm.geometry.coordinates, [125.75, 36.25]);
  assert.deepEqual(
    [
      calm.properties.windMs,
      calm.properties.windKt,
      calm.properties.waveM,
      calm.properties.wavePeriodS,
      calm.properties.gustKt,
    ],
    [0, 0, 0.5, 0, null],
  );
  // No anemometer: wind stays null; "+0.0" tendency is the number 0.
  const noWind = byId(collection, '41004');
  assert.deepEqual(
    [
      noWind.properties.windDir,
      noWind.properties.windMs,
      noWind.properties.windKt,
      noWind.properties.pressureTrendHpa,
      noWind.properties.visNmi,
      noWind.properties.tideFt,
    ],
    [null, null, null, 0, 1.6, 0.57],
  );
  // 21.0 m/s = 40.82 kt -> 40.8; 26.0 m/s = 50.54 kt -> 50.5; falling pressure.
  const storm = byId(collection, 'BURL1');
  assert.deepEqual(
    [
      storm.properties.windKt,
      storm.properties.gustKt,
      storm.properties.pressureTrendHpa,
      storm.properties.timestamp,
    ],
    [40.8, 50.5, -1.8, '2026-10-25T10:30:00.000Z'],
  );
});

test('knot conversion uses 3600/1852 and rounds to 0.1', () => {
  assert.equal(KNOTS_PER_MS, 3600 / 1852);
  assert.equal(msToKnots(10), 19.4);
  assert.equal(msToKnots(7.2), 14);
  assert.equal(msToKnots(0), 0);
  assert.equal(msToKnots(null), null);
  assert.equal(msToKnots(NaN), null);
});

test('each bad row is skipped for its own reason and the good ones survive', () => {
  for (const [name, row] of Object.entries(BAD_BUOY_ROWS)) {
    const collection = normalizeBuoys(
      ndbcText(GOOD_BUOY_ROWS[0], row),
      options,
    );
    assert.deepEqual(
      collection.features.map((feature) => feature.id),
      ['41008'],
      name,
    );
  }
  const all = normalizeBuoys(
    ndbcText(...Object.values(BAD_BUOY_ROWS), ...GOOD_BUOY_ROWS),
    options,
  );
  assert.equal(all.features.length, GOOD_BUOY_ROWS.length);
});

test('an observation right at the age limit is kept, one minute past is not', () => {
  const edge = (minute) =>
    `41008    31.400  -80.866 2026 10 25 05 ${minute}  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM`;
  assert.equal(BUOY_MAX_AGE_MS, 6 * 3_600_000);
  assert.equal(
    normalizeBuoys(ndbcText(GOOD_BUOY_ROWS[1], edge('00')), options).features
      .length,
    2,
  );
  assert.deepEqual(
    normalizeBuoys(
      ndbcText(GOOD_BUOY_ROWS[1], edge('59')),
      options,
    ).features.map((feature) => feature.id),
    ['15009', '41008'],
  );
  assert.deepEqual(
    normalizeBuoys(
      ndbcText(GOOD_BUOY_ROWS[1], edge('00').replace(' 05 00 ', ' 04 59 ')),
      options,
    ).features.map((feature) => feature.id),
    ['15009'],
  );
});

test('values outside a plausible range are null and the rest of the row is kept', () => {
  // Columns: WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE.
  // Only the 5.0 m/s wind is plausible.
  const row =
    'SANE1    31.400  -80.866 2026 10 25 10 50 999 5.0 500.0 99.0 999 99.0 999 12.0 99.9 200.0 99.0 200.0 999.0 99.0';
  const { properties } = normalizeBuoys(ndbcText(row), options).features[0];
  assert.deepEqual(properties, {
    station: 'SANE1',
    windDir: null,
    windMs: 5,
    windKt: 9.7,
    gustMs: null,
    gustKt: null,
    waveM: null,
    wavePeriodS: null,
    avgPeriodS: null,
    waveDir: null,
    pressureHpa: null,
    pressureTrendHpa: null,
    airC: null,
    waterC: null,
    dewC: null,
    visNmi: null,
    tideFt: null,
    timestamp: '2026-10-25T10:50:00.000Z',
  });
  // A row with nothing plausible left carries no measurement and is skipped.
  const nothing =
    'NONE1    31.400  -80.866 2026 10 25 10 50 999 500.0 500.0 99.0 999 99.0 999 12.0 99.9 200.0 99.0 200.0 999.0 99.0';
  assert.deepEqual(
    normalizeBuoys(ndbcText(nothing, GOOD_BUOY_ROWS[0]), options).features.map(
      (feature) => feature.id,
    ),
    ['41008'],
  );
});

test('a station listed twice keeps its newest observation, whichever comes first', () => {
  const older =
    '41008    31.400  -80.866 2026 10 25 09 50  10   1.0    MM  1.0   5  4.0  70 1020.0    MM  20.0    MM  18.0   MM     MM';
  for (const rows of [
    [older, GOOD_BUOY_ROWS[0]],
    [GOOD_BUOY_ROWS[0], older],
  ]) {
    const collection = normalizeBuoys(ndbcText(...rows), options);
    assert.equal(collection.features.length, 1);
    assert.equal(
      collection.features[0].properties.timestamp,
      '2026-10-25T10:50:00.000Z',
    );
    assert.equal(collection.features[0].properties.windMs, 13);
  }
});

test('columns are located by name: a reordered header and an extra column still parse', () => {
  const text = [
    '#STN LAT LON YYYY MM DD hh mm XTRA WSPD WDIR',
    '#text deg deg yr mo day hr mn x m/s degT',
    '41008 31.400 -80.866 2026 10 25 10 50 7 13.0 30',
    'BAD-ID 1 2 2026 10 25 10 50 7 13.0 30',
  ].join('\r\n');
  const collection = normalizeBuoys(text, options);
  assert.equal(collection.features.length, 1);
  assert.deepEqual(
    [
      collection.features[0].properties.windMs,
      collection.features[0].properties.windDir,
      collection.features[0].properties.waveM,
    ],
    [13, 30, null],
  );
});

test('lowercase station ids are upper-cased and comment lines mid-file are ignored', () => {
  const text = ndbcText(
    '# a notice line',
    GOOD_BUOY_ROWS[4].replace('BURL1', 'burl1'),
  );
  const collection = normalizeBuoys(text, options);
  assert.deepEqual(
    collection.features.map((feature) => [
      feature.id,
      feature.properties.station,
    ]),
    [['BURL1', 'BURL1']],
  );
});

test('a corrupt, empty or stale NDBC file throws instead of becoming an empty map', () => {
  assert.throws(() => normalizeBuoys(null, options), invalid);
  assert.throws(() => normalizeBuoys('', options), invalid);
  assert.throws(
    () => normalizeBuoys('<html>maintenance</html>', options),
    invalid,
  );
  assert.throws(() => normalizeBuoys(NDBC_HEADER.join('\n'), options), invalid);
  assert.throws(
    () =>
      normalizeBuoys(
        '#STN LAT LON YYYY MM DD hh\n#text\n41008 1 2 2026 10 25 10\n',
        options,
      ),
    invalid,
  );
  // Every row skipped: all too old, as when the file stops updating.
  assert.throws(
    () =>
      normalizeBuoys(ndbcText(...GOOD_BUOY_ROWS), {
        nowMs: NOW_MS + 24 * 3_600_000,
      }),
    invalid,
  );
  assert.throws(
    () => normalizeBuoys(ndbcText(...Object.values(BAD_BUOY_ROWS)), options),
    invalid,
  );
});

test('the NWPS tiles cover the US and territories with valid, fixed URLs', () => {
  assert.equal(NWPS_TILES.length, 8);
  for (const [west, south, east, north] of NWPS_TILES) {
    assert.ok(west < east && south < north);
    assert.ok(west >= -180 && east <= 180 && south >= 0 && north <= 90);
  }
  assert.equal(
    nwpsTileUrl([-105, 35, -90, 75]),
    'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-105&bbox.ymin=35&bbox.xmax=-90&bbox.ymax=75&srid=EPSG_4326',
  );
  // Adjacent tiles share an edge, so no longitude or latitude strip is lost.
  const edges = new Set(NWPS_TILES.flatMap(([w, , e]) => [w, e]));
  for (const lon of [-180, -135, -120, -105, -90, -75, -60])
    assert.ok(edges.has(lon), `no tile edge at ${lon}`);
});

test('flooding gauges become points with hand-written values; the rest are left out', () => {
  const tiles = NWPS_TILES.map((tile) =>
    nwpsTilePayload(nwpsTileUrl(tile), ALL_GAUGES),
  );
  const collection = normalizeGauges(tiles);
  assertValidFeatureCollection(collection);
  // Tile order, then list order; EDGE1 sits on a boundary and is listed twice.
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['KCFS2', 'HNLH1', 'EDGE1', 'ASTF1', 'ATKG1', 'HYPO1'],
  );
  assert.deepEqual(collection.features.length, FLOOD_GAUGE_IDS.length);
  assert.deepEqual(byId(collection, 'ASTF1'), {
    type: 'Feature',
    id: 'ASTF1',
    geometry: {
      type: 'Point',
      coordinates: [-81.522222222222, 29.166666666667],
    },
    properties: {
      gauge: 'ASTF1',
      name: 'St. Johns River at Astor',
      state: 'FL',
      category: 'moderate',
      forecastCategory: 'moderate',
      stageFt: 3.34,
      flowKcfs: null,
      forecastStageFt: 3.6,
      timestamp: '2026-10-25T10:30:00.000Z',
    },
  });
  assert.deepEqual(byId(collection, 'ATKG1').properties, {
    gauge: 'ATKG1',
    name: 'Satilla River at Atkinson',
    state: 'GA',
    category: 'action',
    forecastCategory: 'action',
    stageFt: 12.89,
    flowKcfs: 5.24,
    forecastStageFt: 12.9,
    timestamp: '2026-10-25T10:45:00.000Z',
  });
  // Forecast-only flooding: no observed category, but the forecast is drawn.
  assert.deepEqual(byId(collection, 'HYPO1').properties, {
    gauge: 'HYPO1',
    name: 'Example Creek at Hypothetical',
    state: 'OH',
    category: null,
    forecastCategory: 'minor',
    stageFt: 8.1,
    flowKcfs: null,
    forecastStageFt: 11.2,
    timestamp: '2026-10-25T10:30:00.000Z',
  });
  // Primary kcfs, secondary ft: each lands in its own property.
  const alaska = byId(collection, 'KCFS2').properties;
  assert.deepEqual(
    [alaska.stageFt, alaska.flowKcfs, alaska.category, alaska.forecastCategory],
    [16.25, 41.5, 'major', null],
  );
  assert.equal(byId(collection, 'HNLH1').properties.state, 'HI');
});

test('gauges that are not flooding, have no position or no id are skipped', () => {
  const collection = normalizeGauges([{ gauges: [...OTHER_GAUGES] }], {
    minGauges: 0,
  });
  assert.deepEqual(collection.features, []);
  const mixed = normalizeGauges(
    [
      {
        gauges: [
          ...OTHER_GAUGES,
          null,
          'gauge',
          { lid: 7 },
          { ...FLOOD_GAUGES[0], lid: 'TOOLONGID9' },
          { ...FLOOD_GAUGES[0], lid: '  ' },
          FLOOD_GAUGES[1],
        ],
      },
    ],
    { minGauges: 0 },
  );
  assert.deepEqual(
    mixed.features.map((feature) => feature.id),
    ['ATKG1'],
  );
});

test('every flood category is kept and ranked; every other category is dropped', () => {
  const make = (category, extra = {}) => ({
    ...FLOOD_GAUGES[0],
    lid: `T${category.slice(0, 3).toUpperCase()}`.slice(0, 5),
    status: {
      ...FLOOD_GAUGES[0].status,
      observed: {
        ...FLOOD_GAUGES[0].status.observed,
        floodCategory: category,
      },
      forecast: {
        ...FLOOD_GAUGES[0].status.forecast,
        floodCategory: 'fcst_not_current',
      },
    },
    ...extra,
  });
  assert.deepEqual(FLOOD_CATEGORIES, ['action', 'minor', 'moderate', 'major']);
  const kept = ['action', 'minor', 'moderate', 'major'].map((c) => make(c));
  const dropped = [
    'no_flooding',
    'low_threshold',
    'not_defined',
    'obs_not_current',
    'out_of_service',
    'fcst_not_current',
    'ACTION',
    '',
  ].map((c, i) => make(c, { lid: `D${i}ABC` }));
  const collection = normalizeGauges([{ gauges: [...kept, ...dropped] }], {
    minGauges: 0,
  });
  assert.deepEqual(
    collection.features.map((feature) => feature.properties.category),
    ['action', 'minor', 'moderate', 'major'],
  );
  assert.deepEqual(
    ['action', 'minor', 'moderate', 'major', 'no_flooding', null].map(
      floodRank,
    ),
    [1, 2, 3, 4, 0, 0],
  );
});

test('placeholder values: -999 readings and the year-1 time are null', () => {
  const lonely = {
    ...FLOOD_GAUGES[0],
    status: {
      observed: {
        primary: -999,
        primaryUnit: 'ft',
        secondary: -999,
        secondaryUnit: 'kcfs',
        floodCategory: 'minor',
        validTime: '0001-01-01T00:00:00Z',
      },
    },
  };
  const { properties } = normalizeGauges([{ gauges: [lonely] }], {
    minGauges: 0,
  }).features[0];
  assert.deepEqual(
    [
      properties.stageFt,
      properties.flowKcfs,
      properties.forecastStageFt,
      properties.timestamp,
    ],
    [null, null, null, null],
  );
});

test('corrupt NWPS payloads throw; an all-empty answer does not become an empty map', () => {
  assert.throws(() => normalizeGauges(null), invalid);
  assert.throws(() => normalizeGauges([]), invalid);
  assert.throws(() => normalizeGauges([{}]), invalid);
  assert.throws(() => normalizeGauges([{ gauges: 'none' }]), invalid);
  assert.throws(() => normalizeGauges([null]), invalid);
  assert.throws(
    () => normalizeGauges([{ gauges: [...FLOOD_GAUGES] }, { error: 'x' }]),
    invalid,
  );
  // Eight tiles that all list nothing: a broken service, not a flood-free US.
  assert.throws(
    () => normalizeGauges(NWPS_TILES.map(() => ({ gauges: [] }))),
    invalid,
  );
  assert.equal(MIN_GAUGES_LISTED, 1000);
  // The same gauges, enough of them listed, are a legitimate empty answer.
  const quiet = normalizeGauges([
    { gauges: [...OTHER_GAUGES, ...fillerGauges(MIN_GAUGES_LISTED)] },
  ]);
  assert.deepEqual(quiet.features, []);
});
