import assert from 'node:assert/strict';
import test from 'node:test';
import {
  featureSources,
  countBySource,
  featureAnchor,
  partialFeedError,
  safeExternalLink,
  subsourceChips,
  visibleFeatures,
} from './featureModel.js';

test('card anchors: point, line middle, polygon vertex mean, largest part', () => {
  assert.deepEqual(featureAnchor({ type: 'Point', coordinates: [10, 20] }), {
    lon: 10,
    lat: 20,
  });
  assert.deepEqual(
    featureAnchor({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [5, 5],
        [9, 9],
      ],
    }),
    { lon: 5, lat: 5 },
  );
  const square = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];
  const anchor = featureAnchor({ type: 'Polygon', coordinates: [square] });
  assert.ok(Math.abs(anchor.lon - 1) < 1e-9 && Math.abs(anchor.lat - 1) < 1e-9);
  const big = [
    [10, 10],
    [20, 10],
    [20, 20],
    [10, 20],
    [10, 10],
  ];
  const multi = featureAnchor({
    type: 'MultiPolygon',
    coordinates: [[square], [big]],
  });
  assert.ok(Math.abs(multi.lon - 15) < 1e-9 && Math.abs(multi.lat - 15) < 1e-9);
  // Circular longitude keeps an antimeridian ring on its own side.
  const dateline = featureAnchor({
    type: 'Polygon',
    coordinates: [
      [
        [179, 0],
        [-179, 0],
        [-179, 1],
        [179, 1],
        [179, 0],
      ],
    ],
  });
  assert.ok(Math.abs(Math.abs(dateline.lon) - 180) < 1e-9);
  assert.equal(featureAnchor(null), null);
});

test('subsource filtering, counts and chips', () => {
  const features = [
    { properties: { source: 'a' } },
    { properties: { source: 'b' } },
    { properties: { source: 'a' } },
  ];
  assert.equal(visibleFeatures(features, new Set()), features);
  assert.equal(visibleFeatures(features, new Set(['a'])).length, 1);
  assert.deepEqual(
    [...countBySource(features)],
    [
      ['a', 2],
      ['b', 1],
    ],
  );
  const toggled = [];
  const chips = subsourceChips(
    [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta', title: 'B feed' },
    ],
    new Set(['b']),
    (id) => toggled.push(id),
  );
  assert.deepEqual(
    chips.map(({ id, label, title, active }) => ({ id, label, title, active })),
    [
      { id: 'source-a', label: 'Alpha', title: '', active: true },
      { id: 'source-b', label: 'Beta', title: 'B feed', active: false },
    ],
  );
  chips[1].onClick();
  assert.deepEqual(toggled, ['b']);
});

test('a joined feature (source "a+b") shows until every feed behind it is hidden', () => {
  const features = [
    { properties: { source: 'a+b' } },
    { properties: { source: 'a' } },
    { properties: { source: 'b' } },
    { properties: {} },
  ];
  assert.deepEqual(featureSources(features[0]), ['a', 'b']);
  assert.deepEqual(featureSources(features[1]), ['a']);
  assert.deepEqual(featureSources(features[3]), []);
  assert.deepEqual(featureSources(null), []);
  const shown = (hidden) =>
    visibleFeatures(features, new Set(hidden)).map((f) => f.properties.source);
  assert.deepEqual(shown(['a']), ['a+b', 'b', undefined]);
  assert.deepEqual(shown(['b']), ['a+b', 'a', undefined]);
  assert.deepEqual(shown(['a', 'b']), [undefined]);
  // A joined feature counts toward each of its feeds; sourceless ones toward none.
  assert.deepEqual(
    [...countBySource(features)],
    [
      ['a', 2],
      ['b', 2],
    ],
  );
});

test('partial feed errors name the one missing feed', () => {
  const names = new Map([
    ['gdacs', 'GDACS'],
    ['eonet', 'NASA EONET'],
  ]);
  assert.equal(
    partialFeedError({ sources: [{ id: 'gdacs', ok: true }] }, names),
    null,
  );
  assert.equal(
    partialFeedError(
      {
        sources: [
          { id: 'eonet', ok: false },
          { id: 'gdacs', ok: true },
        ],
      },
      names,
    ),
    'NASA EONET feed unavailable',
  );
  assert.equal(
    partialFeedError(
      {
        sources: [
          { id: 'eonet', ok: false },
          { id: 'gdacs', ok: false },
        ],
      },
      names,
    ),
    'Some feeds unavailable',
  );
  assert.equal(partialFeedError(null, names), null);
});

test('only credential-free https links may open', () => {
  assert.equal(
    safeExternalLink('https://www.gdacs.org/report.aspx?eventid=1'),
    'https://www.gdacs.org/report.aspx?eventid=1',
  );
  for (const bad of [
    'http://www.gdacs.org/',
    'javascript:alert(1)',
    'https://user:pw@example.com/',
    '/relative',
    null,
    `https://example.com/${'x'.repeat(3000)}`,
  ])
    assert.equal(safeExternalLink(bad), null, String(bad).slice(0, 40));
});
