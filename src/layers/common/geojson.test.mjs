import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isClosedRing,
  isIsoTimestamp,
  isValidPosition,
  toIsoTimestamp,
  validateFeatureCollection,
  validateKeylessLayerCollection,
} from './geojson.js';

const feature = (geometry, extra = {}) => ({
  type: 'Feature',
  geometry,
  properties: {},
  ...extra,
});
const collection = (...features) => ({ type: 'FeatureCollection', features });
const closed = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
];

test('accepts every RFC 7946 geometry type, null geometry and null properties', () => {
  const result = validateFeatureCollection(
    collection(
      feature({ type: 'Point', coordinates: [180, -90, 12] }, { id: 'a' }),
      feature({ type: 'MultiPoint', coordinates: [[1, 2]] }, { id: 7 }),
      feature({
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      }),
      feature({
        type: 'MultiLineString',
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
      feature({ type: 'Polygon', coordinates: [closed, closed] }),
      feature({ type: 'MultiPolygon', coordinates: [[closed]] }),
      feature({
        type: 'GeometryCollection',
        geometries: [{ type: 'Point', coordinates: [0, 0] }],
      }),
      { type: 'Feature', geometry: null, properties: null },
    ),
  );
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('rejects an open polygon ring', () => {
  const open = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const result = validateFeatureCollection(
    collection(feature({ type: 'Polygon', coordinates: [open] })),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'features[0].geometry.coordinates[0]: ring is not closed',
  ]);
  assert.equal(isClosedRing(open), false);
  assert.equal(isClosedRing(closed), true);
});

test('rejects out-of-range, non-finite and malformed positions', () => {
  for (const coordinates of [
    [181, 0],
    [-180.0001, 0],
    [0, 90.5],
    [0, -91],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
    ['1', 2],
    [1],
    [1, 2, 3, 4],
    null,
  ]) {
    assert.equal(isValidPosition(coordinates), false, String(coordinates));
    const result = validateFeatureCollection(
      collection(feature({ type: 'Point', coordinates })),
    );
    assert.equal(result.ok, false, String(coordinates));
  }
});

test('rejects short lines, short rings, MultiPolygon errors and unknown types', () => {
  const cases = [
    [
      { type: 'LineString', coordinates: [[0, 0]] },
      'features[0].geometry.coordinates: needs at least 2 positions',
    ],
    [
      {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      'features[0].geometry.coordinates[0]: ring needs at least 4 positions',
    ],
    [
      { type: 'Polygon', coordinates: [] },
      'features[0].geometry.coordinates: polygon needs at least one ring',
    ],
    [
      {
        type: 'MultiPolygon',
        coordinates: [
          [closed],
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
          ],
        ],
      },
      'features[0].geometry.coordinates[1][0]: ring is not closed',
    ],
    [
      { type: 'Circle', coordinates: [0, 0] },
      'features[0].geometry.type: unknown geometry type',
    ],
  ];
  for (const [geometry, message] of cases) {
    const result = validateFeatureCollection(collection(feature(geometry)));
    assert.deepEqual(result.errors, [message]);
  }
});

test('rejects bad collections, features, properties and duplicate ids', () => {
  assert.equal(validateFeatureCollection(null).ok, false);
  assert.equal(validateFeatureCollection([]).ok, false);
  assert.deepEqual(
    validateFeatureCollection({ type: 'FeatureCollection' }).errors,
    ['features: must be an array'],
  );
  assert.deepEqual(validateFeatureCollection({ features: [] }).errors, [
    'type: must be "FeatureCollection"',
  ]);
  const point = { type: 'Point', coordinates: [0, 0] };
  const result = validateFeatureCollection(
    collection(
      { type: 'Thing', geometry: point, properties: {} },
      { type: 'Feature', geometry: point, properties: [] },
      feature(point, { id: 'x' }),
      feature(point, { id: 'x' }),
      feature(point, { id: '' }),
    ),
  );
  assert.deepEqual(result.errors, [
    'features[0].type: must be "Feature"',
    'features[1].properties: must be an object or null',
    'features[3].id: duplicate id "x"',
    'features[4].id: must be a non-empty string or a number',
  ]);
  // A string "1" and a number 1 are different ids.
  assert.equal(
    validateFeatureCollection(
      collection(feature(point, { id: 1 }), feature(point, { id: '1' })),
    ).ok,
    true,
  );
});

test('requireIds demands a non-empty string id on every feature', () => {
  const point = { type: 'Point', coordinates: [0, 0] };
  assert.deepEqual(
    validateFeatureCollection(
      collection(feature(point), feature(point, { id: 3 })),
      { requireIds: true },
    ).errors,
    ['features[0].id: missing', 'features[1].id: must be a string'],
  );
});

test('error lists are capped', () => {
  const bad = Array.from({ length: 80 }, () =>
    feature({ type: 'Point', coordinates: [999, 0] }),
  );
  assert.equal(validateFeatureCollection(collection(...bad)).errors.length, 50);
});

test('keyless layer contract: layer, source, ISO timestamp and metadata', () => {
  const good = {
    type: 'FeatureCollection',
    features: [
      feature(
        { type: 'Point', coordinates: [1, 2] },
        {
          id: 'gdacs:EQ-1',
          properties: {
            layer: 'global-hazards',
            source: 'gdacs',
            timestamp: '2026-10-25T07:45:45.000Z',
          },
        },
      ),
    ],
    metadata: { layer: 'global-hazards', stale: false, sources: [] },
  };
  assert.deepEqual(
    validateKeylessLayerCollection(good, {
      layerId: 'global-hazards',
      requireMetadata: true,
    }),
    { ok: true, errors: [] },
  );
  const bad = structuredClone(good);
  bad.features[0].properties = {
    layer: 'other',
    source: '',
    timestamp: '25 Oct 2026',
  };
  delete bad.metadata.stale;
  assert.deepEqual(
    validateKeylessLayerCollection(bad, {
      layerId: 'global-hazards',
      requireMetadata: true,
    }).errors,
    [
      'features[0].properties.layer: must be "global-hazards"',
      'features[0].properties.source: must be a non-empty string',
      'features[0].properties.timestamp: must be an ISO-8601 string or null',
      'metadata.stale: must be a boolean',
    ],
  );
});

test('timestamps: zone-less upstream times are UTC; junk is null', () => {
  assert.equal(
    toIsoTimestamp('2026-10-25T07:45:45'),
    '2026-10-25T07:45:45.000Z',
  );
  assert.equal(
    toIsoTimestamp('2024-01-11 00:00:00'),
    '2024-01-11T00:00:00.000Z',
  );
  assert.equal(
    toIsoTimestamp('2026-10-22T21:45:00Z'),
    '2026-10-22T21:45:00.000Z',
  );
  assert.equal(
    toIsoTimestamp('2026-10-22T21:45:00+02:00'),
    '2026-10-22T19:45:00.000Z',
  );
  assert.equal(toIsoTimestamp(0), '1970-01-01T00:00:00.000Z');
  for (const junk of ['', 'yesterday', '25 Oct 2026', null, Number.NaN, {}])
    assert.equal(toIsoTimestamp(junk), null, String(junk));
  assert.equal(isIsoTimestamp('2026-10-25T07:45:45.000Z'), true);
  assert.equal(isIsoTimestamp('2026-10-25T07:45:45'), false);
});
