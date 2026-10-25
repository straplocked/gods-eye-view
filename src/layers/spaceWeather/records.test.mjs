import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AURORA_BANDS,
  AURORA_MIN_PROBABILITY,
  auroraBandIndex,
  kpToGScale,
  normalizeAurora,
  normalizeKp,
  spaceWeatherFromMetadata,
  wrapLongitude,
} from './records.js';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  auroraCells,
  auroraPayload,
  kpLegacyRows,
  kpRows,
  ovation,
} from '../../testSupport/spaceWeatherFixtures.mjs';

const byId = (collection) =>
  Object.fromEntries(collection.features.map((f) => [f.id, f]));

/** Shoelace area of a ring in square degrees (counter-clockwise is positive). */
function ringArea(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++)
    sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return sum / 2;
}

/** Area of a Polygon/MultiPolygon: outer rings minus holes. */
function geometryArea(geometry) {
  const polygons =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce(
    (total, [outer, ...holes]) =>
      total +
      ringArea(outer) -
      holes.reduce((sum, hole) => sum + Math.abs(ringArea(hole)), 0),
    0,
  );
}

test('longitude wraps from 0..359 into -180..180, with 180 on the western side', () => {
  const expected = [
    [0, 0],
    [1, 1],
    [179, 179],
    [180, -180],
    [181, -179],
    [270, -90],
    [350, -10],
    [359, -1],
    [-180, -180],
    [-5, -5],
  ];
  for (const [input, output] of expected)
    assert.equal(wrapLongitude(input), output, `lon ${input}`);
});

test('NOAA G-scale from Kp: whole values G1=5 to G5=9, thirds round to the nearest, 9- stays G4', () => {
  const expected = [
    [0, 0],
    [1.67, 0],
    [4.33, 0],
    [4.67, 1],
    [5, 1],
    [5.33, 1],
    [5.67, 2],
    [6, 2],
    [6.33, 2],
    [6.67, 3],
    [7, 3],
    [7.33, 3],
    [7.67, 4],
    [8, 4],
    [8.33, 4],
    [8.67, 4],
    [9, 5],
    [-1, 0],
    [Number.NaN, 0],
  ];
  for (const [kp, scale] of expected)
    assert.equal(kpToGScale(kp), scale, `Kp ${kp}`);
});

test('probability bands start at the 10% minimum and tile upward', () => {
  assert.equal(AURORA_MIN_PROBABILITY, 10);
  assert.deepEqual(
    AURORA_BANDS.map(({ min, max }) => [min, max]),
    [
      [10, 20],
      [20, 40],
      [40, 60],
      [60, null],
    ],
  );
  const expected = [
    [0, -1],
    [9, -1],
    [9.99, -1],
    [10, 0],
    [19, 0],
    [20, 1],
    [39, 1],
    [40, 2],
    [59, 2],
    [60, 3],
    [100, 3],
    [Number.NaN, -1],
  ];
  for (const [probability, index] of expected)
    assert.equal(auroraBandIndex(probability), index, `${probability}%`);
});

test('aurora: lon 350 comes out at -10, cells under 10% are dropped, bands and hemispheres split', () => {
  const result = normalizeAurora(auroraPayload);
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((f) => f.id),
    ['north-10-1', 'north-20-1', 'south-60-2'],
  );
  const features = byId(result);
  // Cells (-10, 65) and (-9, 65), each covering +-0.5 degrees.
  assert.deepEqual(features['north-20-1'].geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [-10.5, 64.5],
        [-9.5, 64.5],
        [-8.5, 64.5],
        [-8.5, 65.5],
        [-9.5, 65.5],
        [-10.5, 65.5],
        [-10.5, 64.5],
      ],
    ],
  });
  assert.deepEqual(features['north-10-1'].geometry, {
    type: 'Polygon',
    coordinates: [
      [
        [-10.5, 65.5],
        [-9.5, 65.5],
        [-9.5, 66.5],
        [-10.5, 66.5],
        [-10.5, 65.5],
      ],
    ],
  });
  assert.deepEqual(features['south-60-2'].geometry.coordinates, [
    [
      [9.5, -60.5],
      [10.5, -60.5],
      [10.5, -59.5],
      [9.5, -59.5],
      [9.5, -60.5],
    ],
  ]);
  // The 9% cell at lon 352 (-8) is nowhere in the output.
  assert.ok(
    !JSON.stringify(result.features).includes('-7.5'),
    'the 9% cell leaked into a polygon',
  );
  assert.deepEqual(features['north-20-1'].properties, {
    hemisphere: 'north',
    band: 20,
    bandMax: 40,
    probability: 27,
    cells: 2,
    observationTime: '2026-10-25T08:38:00.000Z',
    forecastTime: '2026-10-25T09:55:00.000Z',
    timestamp: '2026-10-25T08:38:00.000Z',
  });
  assert.deepEqual(features['south-60-2'].properties, {
    hemisphere: 'south',
    band: 60,
    bandMax: null,
    probability: 70,
    cells: 1,
    observationTime: '2026-10-25T08:38:00.000Z',
    forecastTime: '2026-10-25T09:55:00.000Z',
    timestamp: '2026-10-25T08:38:00.000Z',
  });
  assert.deepEqual(result.details, {
    observationTime: '2026-10-25T08:38:00.000Z',
    forecastTime: '2026-10-25T09:55:00.000Z',
    activeCells: 4,
    peakProbability: 70,
    skippedCells: 0,
  });
});

test('aurora: exactly 10% is kept and 9% is not, so the threshold is inclusive', () => {
  const kept = normalizeAurora(
    ovation([
      [100, 60, 10],
      [0, 0, 0],
    ]),
  );
  assert.deepEqual(
    kept.features.map((f) => f.id),
    ['north-10-3'],
  );
  const dropped = normalizeAurora(
    ovation([
      [100, 60, 9],
      [0, 0, 0],
    ]),
  );
  assert.deepEqual(dropped.features, []);
  assert.equal(dropped.details.activeCells, 0);
});

test('aurora: a quiet sky is a valid empty collection, not an error', () => {
  const quiet = normalizeAurora(
    ovation([
      [0, -90, 3],
      [0, -89, 0],
      [1, 0, 0],
    ]),
  );
  assert.deepEqual(quiet.features, []);
  assertValidFeatureCollection(quiet);
});

test('aurora: band edges 19/20/39/40/59/60 land in the right band', () => {
  // x = 100..150 is longitude block 3.
  const cells = [19, 20, 39, 40, 59, 60].map((p, i) => [100 + 10 * i, 60, p]);
  const result = normalizeAurora(ovation(cells));
  assert.deepEqual(
    result.features.map((f) => [
      f.id,
      f.properties.cells,
      f.properties.probability,
    ]),
    [
      ['north-10-3', 1, 19],
      ['north-20-3', 2, 39],
      ['north-40-3', 2, 59],
      ['north-60-3', 1, 60],
    ],
  );
});

test('aurora: the cell on the antimeridian also covers its eastern half', () => {
  const result = normalizeAurora(ovation([[180, 70, 15]]));
  assertValidFeatureCollection(result, { requireIds: true });
  const features = byId(result);
  assert.deepEqual(features['north-10-0'].geometry.coordinates, [
    [
      [-180, 69.5],
      [-179.5, 69.5],
      [-179.5, 70.5],
      [-180, 70.5],
      [-180, 69.5],
    ],
  ]);
  assert.deepEqual(features['north-10-3'].geometry.coordinates, [
    [
      [179.5, 69.5],
      [180, 69.5],
      [180, 70.5],
      [179.5, 70.5],
      [179.5, 69.5],
    ],
  ]);
  assert.equal(result.details.activeCells, 1);
});

test('aurora: cells at the poles are clipped to +-90', () => {
  const result = normalizeAurora(
    ovation([
      [0, 90, 30],
      [0, -90, 30],
    ]),
  );
  assertValidFeatureCollection(result, { requireIds: true });
  const features = byId(result);
  assert.deepEqual(features['north-20-2'].geometry.coordinates, [
    [
      [-0.5, 89.5],
      [0.5, 89.5],
      [0.5, 90],
      [-0.5, 90],
      [-0.5, 89.5],
    ],
  ]);
  assert.deepEqual(features['south-20-2'].geometry.coordinates, [
    [
      [-0.5, -90],
      [0.5, -90],
      [0.5, -89.5],
      [-0.5, -89.5],
      [-0.5, -90],
    ],
  ]);
});

test('aurora: a band is split into 90-degree longitude blocks, ids by block', () => {
  const cells = [-1, 0, 89, 90].map((lon) => [(lon + 360) % 360, 60, 15]);
  const result = normalizeAurora(ovation(cells));
  assert.deepEqual(
    result.features.map((f) => [f.id, f.properties.cells]),
    [
      ['north-10-1', 1],
      ['north-10-2', 2],
      ['north-10-3', 1],
    ],
  );
});

test('aurora: a ring of cells is a polygon with a hole, wound per RFC 7946', () => {
  const cells = [];
  for (let lon = 100; lon <= 102; lon++)
    for (let lat = 60; lat <= 62; lat++)
      cells.push([lon, lat, lon === 101 && lat === 61 ? 5 : 15]);
  const result = normalizeAurora(ovation(cells));
  assertValidFeatureCollection(result, { requireIds: true });
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry.coordinates, [
    [
      [99.5, 59.5],
      [100.5, 59.5],
      [101.5, 59.5],
      [102.5, 59.5],
      [102.5, 60.5],
      [102.5, 61.5],
      [102.5, 62.5],
      [101.5, 62.5],
      [100.5, 62.5],
      [99.5, 62.5],
      [99.5, 61.5],
      [99.5, 60.5],
      [99.5, 59.5],
    ],
    [
      [100.5, 60.5],
      [100.5, 61.5],
      [101.5, 61.5],
      [101.5, 60.5],
      [100.5, 60.5],
    ],
  ]);
  assert.equal(result.features[0].properties.cells, 8);
  assert.equal(geometryArea(result.features[0].geometry), 8);
});

test('aurora: cells that touch only at a corner are separate polygons', () => {
  const result = normalizeAurora(
    ovation([
      [100, 60, 15],
      [101, 61, 15],
    ]),
  );
  assertValidFeatureCollection(result, { requireIds: true });
  const [feature] = result.features;
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.deepEqual(feature.geometry.coordinates, [
    [
      [
        [99.5, 59.5],
        [100.5, 59.5],
        [100.5, 60.5],
        [99.5, 60.5],
        [99.5, 59.5],
      ],
    ],
    [
      [
        [100.5, 60.5],
        [101.5, 60.5],
        [101.5, 61.5],
        [100.5, 61.5],
        [100.5, 60.5],
      ],
    ],
  ]);
});

test('aurora: an irregular shape traces to a polygon whose area is its cell count', () => {
  // An L of five cells plus a separate 2x2 block and a lone cell to its east.
  const cells = [
    [100, 60],
    [100, 61],
    [100, 62],
    [101, 60],
    [102, 60],
    [110, 60],
    [111, 60],
    [110, 61],
    [111, 61],
    [120, 55],
  ].map(([lon, lat]) => [lon, lat, 25]);
  const result = normalizeAurora(ovation(cells));
  assertValidFeatureCollection(result, { requireIds: true });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.cells, 10);
  assert.equal(result.features[0].geometry.coordinates.length, 3);
  assert.equal(geometryArea(result.features[0].geometry), 10);
  // The L's outline, counter-clockwise from its lowest-left corner.
  assert.deepEqual(result.features[0].geometry.coordinates[0][0], [
    [99.5, 59.5],
    [100.5, 59.5],
    [101.5, 59.5],
    [102.5, 59.5],
    [102.5, 60.5],
    [101.5, 60.5],
    [100.5, 60.5],
    [100.5, 61.5],
    [100.5, 62.5],
    [99.5, 62.5],
    [99.5, 61.5],
    [99.5, 60.5],
    [99.5, 59.5],
  ]);
});

test('aurora: bad entries are skipped and counted, duplicates keep the first', () => {
  // Zero-probability cells, as most of a real file is, keep the grid plausible.
  const padding = Array.from({ length: 20 }, (_, i) => [i, 0, 0]);
  const cells = [
    ...padding,
    [100, 60, 15],
    [101, 60, 15],
    [102, 60, 15],
    [100.5, 61, 50], // fractional longitude
    [103, 61.5, 50], // fractional latitude
    [104, 91, 50], // latitude out of range
    [105, -91, 50], // latitude out of range
    [360, 60, 50], // longitude out of range
    [-181, 60, 50], // longitude out of range
    [106, 60, 101], // probability out of range
    [107, 60, -1], // probability out of range
    [108, 60, 'x'], // probability not a number
    [109, 60, Number.NaN], // probability not finite
    [110, 60], // short row
    null,
    'cell',
    [100, 60, 75], // duplicate of the first cell: ignored
  ];
  const result = normalizeAurora(ovation(cells));
  assertValidFeatureCollection(result, { requireIds: true });
  assert.deepEqual(
    result.features.map((f) => [
      f.id,
      f.properties.cells,
      f.properties.probability,
    ]),
    [['north-10-3', 3, 15]],
  );
  assert.equal(result.details.skippedCells, 14);
});

test('aurora: a grid that is mostly invalid is corrupt, never a calm sky', () => {
  // Same shape of file at a finer grid: every longitude is fractional.
  const finer = ovation(
    Array.from({ length: 50 }, (_, i) => [i + 0.5, 10, 50]),
  );
  assert.throws(() => normalizeAurora(finer), { code: 'invalid_payload' });
  // More bad rows than good ones.
  const mostlyBad = ovation([
    [100, 60, 15],
    [101.5, 60, 15],
    [102.5, 60, 15],
  ]);
  assert.throws(() => normalizeAurora(mostlyBad), { code: 'invalid_payload' });
});

test('aurora: corrupt or non-collection payloads throw invalid_payload', () => {
  for (const payload of [
    null,
    undefined,
    'text',
    42,
    [],
    [[0, 0, 50]],
    {},
    { coordinates: 'nope' },
    { coordinates: {} },
    { coordinates: [] },
    { error: 'maintenance' },
    ovation([]),
    ovation([null, 'x', [1]]),
  ])
    assert.throws(
      () => normalizeAurora(payload),
      (error) => error.code === 'invalid_payload',
      JSON.stringify(payload),
    );
});

test('aurora: a noisy grid over the vertex budget is refused', () => {
  // A checkerboard of 50% cells: every cell is its own ring.
  const cells = [];
  for (let lon = 0; lon < 360; lon++)
    for (let lat = -90; lat <= 90; lat++)
      cells.push([lon, lat, (lon + lat) % 2 === 0 ? 50 : 0]);
  assert.throws(() => normalizeAurora(ovation(cells)), {
    code: 'invalid_payload',
    message: /fragmented/,
  });
});

test('aurora: a large storm stays far below 500 KB', () => {
  // The whole 45-75 degree belt at 40%, both hemispheres: 2 x 31 x 360 cells.
  const cells = [];
  for (let lon = 0; lon < 360; lon++)
    for (let lat = -90; lat <= 90; lat++)
      cells.push([
        lon,
        lat,
        Math.abs(lat) >= 45 && Math.abs(lat) <= 75 ? 40 : 0,
      ]);
  const result = normalizeAurora(ovation(cells));
  assertValidFeatureCollection(result, { requireIds: true });
  assert.equal(result.details.activeCells, 22_320);
  assert.ok(JSON.stringify(result.features).length < 150_000);
  // Together the blocks cover exactly the belt (clipped areas are whole cells here).
  const area = result.features.reduce(
    (sum, feature) => sum + geometryArea(feature.geometry),
    0,
  );
  assert.equal(Math.round(area), 22_320);
});

test('aurora: unreadable times become null, not a failure', () => {
  const result = normalizeAurora(
    ovation([[100, 60, 15]], { observation: 'soon', forecast: null }),
  );
  assert.equal(result.features[0].properties.observationTime, null);
  assert.equal(result.features[0].properties.forecastTime, null);
  assert.equal(result.features[0].properties.timestamp, null);
});

test('kp: the latest interval wins, with its G-scale and the 24 hour peak', () => {
  const result = normalizeKp(kpRows);
  assert.deepEqual(result.features, []);
  assert.equal(result.type, 'FeatureCollection');
  assert.deepEqual(result.details, {
    kp: 7.33,
    kpTime: '2026-10-25T06:00:00.000Z',
    gScale: 3,
    kpMax24h: 7.33,
  });
});

test('kp: row order does not matter and the 24 hour peak covers the last 8 intervals', () => {
  const rows = [
    {
      time_tag: '2026-10-20T00:00:00',
      Kp: 9,
      a_running: 400,
      station_count: 8,
    },
    ...kpRows,
  ].reverse();
  const { details } = normalizeKp(rows);
  assert.equal(details.kpTime, '2026-10-25T06:00:00.000Z');
  // The 9.00 from five days earlier is outside the latest eight rows.
  assert.equal(details.kpMax24h, 7.33);
  const quiet = normalizeKp([
    { time_tag: '2026-10-25T03:00:00', Kp: 0.67 },
    { time_tag: '2026-10-25T00:00:00', Kp: 2.33 },
  ]);
  assert.deepEqual(quiet.details, {
    kp: 0.67,
    kpTime: '2026-10-25T03:00:00.000Z',
    gScale: 0,
    kpMax24h: 2.33,
  });
});

test('kp: the older header-row layout with string cells reads the same way', () => {
  const { details } = normalizeKp(kpLegacyRows);
  assert.deepEqual(details, {
    kp: 7.33,
    kpTime: '2026-10-25T06:00:00.000Z',
    gScale: 3,
    kpMax24h: 7.33,
  });
});

test('kp: bad rows are skipped; no valid row, or a different layout, is corrupt', () => {
  const { details } = normalizeKp([
    { time_tag: 'later', Kp: 5 },
    { time_tag: '2026-10-25T00:00:00', Kp: 'high' },
    { time_tag: '2026-10-25T03:00:00', Kp: 12 },
    { time_tag: '2026-10-25T06:00:00', Kp: -1 },
    null,
    { time_tag: '2026-10-24T21:00:00', Kp: '4.67' },
    { time_tag: '2026-10-24T21:00:00', Kp: 4.67 },
  ]);
  assert.equal(details.kp, 4.67);
  assert.equal(details.gScale, 1);
  for (const payload of [
    null,
    {},
    'x',
    [],
    [{}],
    [{ time_tag: '2026-10-25T06:00:00' }],
    [['time_tag', 'Kp']],
    [
      ['when', 'value'],
      ['2026-10-25T06:00:00', '3.00'],
    ],
    { error: 'maintenance' },
  ])
    assert.throws(
      () => normalizeKp(payload),
      (error) => error.code === 'invalid_payload',
      JSON.stringify(payload),
    );
});

test('the space-weather summary is read back from response metadata', () => {
  const metadata = {
    layer: 'space-weather',
    stale: false,
    partial: false,
    sources: [
      {
        id: 'aurora',
        ok: true,
        observationTime: '2026-10-25T08:38:00.000Z',
        forecastTime: '2026-10-25T09:55:00.000Z',
      },
      {
        id: 'kp',
        ok: false,
        stale: true,
        kp: 7.33,
        kpTime: '2026-10-25T06:00:00.000Z',
        gScale: 3,
        kpMax24h: 7.33,
      },
    ],
  };
  assert.deepEqual(spaceWeatherFromMetadata(metadata), {
    kp: 7.33,
    kpTime: '2026-10-25T06:00:00.000Z',
    gScale: 3,
    kpMax24h: 7.33,
    stale: true,
    auroraObservation: '2026-10-25T08:38:00.000Z',
    auroraForecast: '2026-10-25T09:55:00.000Z',
  });
  // No Kp reading (the feed failed with nothing cached): no summary.
  for (const value of [
    null,
    {},
    { sources: [] },
    { sources: [{ id: 'kp', ok: false, error: 'timeout' }] },
    { sources: [{ id: 'kp', kp: 12 }] },
    { sources: [{ id: 'kp', kp: 'x' }] },
  ])
    assert.equal(spaceWeatherFromMetadata(value), null);
  // The G-scale is recomputed when the metadata lacks it.
  assert.equal(
    spaceWeatherFromMetadata({ sources: [{ id: 'kp', kp: 5.33 }] }).gScale,
    1,
  );
});

test('the real fixture cells keep their input order independent of output', () => {
  const shuffled = ovation([...auroraCells].reverse());
  assert.deepEqual(
    normalizeAurora(shuffled).features,
    normalizeAurora(auroraPayload).features,
  );
});
