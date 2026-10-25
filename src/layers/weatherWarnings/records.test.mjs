import assert from 'node:assert/strict';
import test from 'node:test';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  NWS_BASE_TOLERANCE,
  isNwsZoneUrl,
  mergeTsunamiFeeds,
  normalizeNwsAlerts,
  normalizeNwsZone,
  normalizeTsunamiFeed,
  nwsZonesToResolve,
  polygonsOf,
  simplifyPolygons,
  simplifyRing,
  tsunamiLevel,
} from './records.js';
import {
  noisySquareRing,
  nwsAlert,
  nwsCollection,
  polygonGeometry,
  squareRing,
  tsunamiEntry,
  tsunamiFeedOf,
  tsunamiPaaq,
  tsunamiPheb,
  zoneFeature,
  zoneUrl,
} from '../../testSupport/weatherWarningsFixtures.mjs';

const NOW = Date.parse('2026-10-25T09:00:00Z');
const FLZ115 = zoneUrl('FLZ115');
const FLZ116 = zoneUrl('FLZ116');
const NMC015 = zoneUrl('NMC015', 'county');

/** Zone lookup over a plain object: polygons, null (gone) or absent (pending). */
const lookupOf = (table) => (url) => (url in table ? table[url] : undefined);
const squarePolygons = (lon, lat) => [[squareRing(lon, lat, 1)]];
const vertexCount = (geometry) =>
  JSON.stringify(geometry.coordinates).split('],[').length;

function circleRing(radius, points) {
  const ring = [];
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points;
    ring.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  ring.push([...ring[0]]);
  return ring;
}

test('zone urls: only api.weather.gov zone resources qualify', () => {
  assert.equal(isNwsZoneUrl(FLZ115), true);
  assert.equal(isNwsZoneUrl(NMC015), true);
  for (const bad of [
    'http://api.weather.gov/zones/forecast/FLZ115',
    'https://evil.example/zones/forecast/FLZ115',
    'https://api.weather.gov/zones/forecast/FLZ115/../../alerts',
    'https://api.weather.gov/zones/forecast/FLZ115?x=1',
    'https://api.weather.gov/zones/forecast/flz115',
    'https://api.weather.gov/alerts/active',
    null,
    42,
  ])
    assert.equal(isNwsZoneUrl(bad), false, String(bad));
});

test('simplifyRing collapses collinear survey points to the corners', () => {
  const noisy = noisySquareRing(10, 20, 1, 20);
  assert.equal(noisy.length, 81);
  assert.deepEqual(simplifyRing(noisy, 0.01), [
    [10, 20],
    [11, 20],
    [11, 21],
    [10, 21],
    [10, 20],
  ]);
});

test('simplifyRing rounds to three decimals and drops what collapses', () => {
  assert.deepEqual(
    simplifyRing(
      [
        [0.00049, 0],
        [1.0004, 0],
        [1.0004, 1.00051],
        [0.00049, 1.00051],
        [0.00049, 0],
      ],
      0.01,
    ),
    [
      [0, 0],
      [1, 0],
      [1, 1.001],
      [0, 1.001],
      [0, 0],
    ],
  );
  // A 0.001-degree square is inside the tolerance: nothing is left of it.
  assert.equal(simplifyRing(squareRing(5, 5, 0.001), 0.01), null);
  assert.equal(simplifyRing([[0, 0]], 0.01), null);
  assert.equal(simplifyRing(null, 0.01), null);
});

test('simplifyPolygons drops specks and collapsed holes, keeps real islands', () => {
  const result = simplifyPolygons(
    [
      [squareRing(0, 0, 2), squareRing(0.5, 0.5, 0.001)],
      [squareRing(10, 10, 0.004)],
      [squareRing(20, 20, 0.5)],
    ],
    0.01,
  );
  assert.deepEqual(result, [[squareRing(0, 0, 2)], [squareRing(20, 20, 0.5)]]);
});

test('polygonsOf flattens geometry collections and skips invalid polygons', () => {
  const collection = {
    type: 'GeometryCollection',
    geometries: [
      {
        type: 'MultiPolygon',
        coordinates: [[squareRing(0, 0)], [squareRing(5, 5)]],
      },
      polygonGeometry(squareRing(9, 9)),
      // Open: the last position differs from the first.
      polygonGeometry([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0.5],
      ]),
      polygonGeometry([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
      polygonGeometry(squareRing(190, 0)),
      { type: 'Point', coordinates: [1, 1] },
    ],
  };
  const found = polygonsOf(collection);
  // The two open rings, the out-of-range longitude and the point are skipped.
  assert.deepEqual(found, [
    [squareRing(0, 0)],
    [squareRing(5, 5)],
    [squareRing(9, 9)],
  ]);
  assert.deepEqual(polygonsOf(null), []);
  assert.deepEqual(polygonsOf({ type: 'Point', coordinates: [0, 0] }), []);
});

test('zone normalizer simplifies a zone and rejects non-features', () => {
  const polygons = normalizeNwsZone(
    zoneFeature('FLZ115', polygonGeometry(noisySquareRing(-85, 29, 1, 50))),
  );
  assert.deepEqual(polygons, [
    [
      [
        [-85, 29],
        [-84, 29],
        [-84, 30],
        [-85, 30],
        [-85, 29],
      ],
    ],
  ]);
  assert.equal(normalizeNwsZone(zoneFeature('FLZ115', null)), null);
  assert.equal(
    normalizeNwsZone(
      zoneFeature('FLZ115', { type: 'Point', coordinates: [1, 1] }),
    ),
    null,
  );
  for (const payload of [
    null,
    [],
    'x',
    { type: 'FeatureCollection', features: [] },
  ])
    assert.throws(() => normalizeNwsZone(payload), { code: 'invalid_payload' });
});

test('a polygon alert is used as published, with its alert id and properties', () => {
  const ring = squareRing(-104.85, 32, 0.5);
  const payload = nwsCollection(
    nwsAlert({
      id: 'urn:oid:2.49.0.1.840.0.abc.001.1',
      geometry: polygonGeometry(ring),
      zones: [NMC015],
      severity: 'Severe',
      event: 'Flash Flood Warning',
      areaDesc: 'Eddy, NM',
      senderName: 'NWS Midland/Odessa TX',
      expires: '2026-10-25T03:30:00-06:00',
      onset: '2026-10-25T02:01:00-06:00',
      sent: '2026-10-25T02:01:00-06:00',
    }),
  );
  // The zone is never consulted: the alert carries its own area.
  const result = normalizeNwsAlerts(payload, {
    zoneLookup: () => assert.fail('zone lookup for a polygon alert'),
    nowMs: Date.parse('2026-10-25T08:30:00Z'),
  });
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0], {
    type: 'Feature',
    id: 'urn:oid:2.49.0.1.840.0.abc.001.1',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      event: 'Flash Flood Warning',
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      headline:
        'Flash Flood Warning issued October 25 at 3:45AM EDT by NWS Midland/Odessa TX',
      areaDesc: 'Eddy, NM',
      senderName: 'NWS Midland/Odessa TX',
      onset: '2026-10-25T08:01:00.000Z',
      expires: '2026-10-25T09:30:00.000Z',
      url: 'https://www.weather.gov/',
      timestamp: '2026-10-25T08:01:00.000Z',
    },
  });
  assert.deepEqual(result.details, {
    alerts: 1,
    pendingAlerts: 0,
    pendingZones: 0,
    unmappedAlerts: 0,
    tolerance: NWS_BASE_TOLERANCE,
  });
  assertValidFeatureCollection(result, { requireIds: true });
});

test('a zone-only alert becomes a polygon feature with the alert id', () => {
  const payload = nwsCollection(
    nwsAlert({
      id: 'urn:oid:2.49.0.1.840.0.zoned.001.1',
      zones: [FLZ115, FLZ116],
      severity: 'Minor',
    }),
  );
  const result = normalizeNwsAlerts(payload, {
    zoneLookup: lookupOf({
      [FLZ115]: squarePolygons(-85, 29),
      [FLZ116]: squarePolygons(-83, 29),
    }),
    nowMs: NOW,
  });
  assert.equal(result.features.length, 1);
  const [feature] = result.features;
  assert.equal(feature.id, 'urn:oid:2.49.0.1.840.0.zoned.001.1');
  assert.deepEqual(feature.geometry, {
    type: 'MultiPolygon',
    coordinates: [[squareRing(-85, 29)], [squareRing(-83, 29)]],
  });
  assert.equal(feature.properties.severity, 'Minor');
  assert.equal(result.details.pendingAlerts, 0);
  assertValidFeatureCollection(result, { requireIds: true });
});

test('a one-zone alert is a plain Polygon', () => {
  const result = normalizeNwsAlerts(
    nwsCollection(nwsAlert({ zones: [FLZ115] })),
    { zoneLookup: lookupOf({ [FLZ115]: squarePolygons(-85, 29) }), nowMs: NOW },
  );
  assert.equal(result.features[0].geometry.type, 'Polygon');
});

test('alerts with unresolved zones are omitted and counted as pending', () => {
  const payload = nwsCollection(
    nwsAlert({ id: 'urn:oid:ready', zones: [FLZ115] }),
    nwsAlert({ id: 'urn:oid:waiting', zones: [FLZ115, FLZ116] }),
    nwsAlert({ id: 'urn:oid:waiting-too', zones: [FLZ116, NMC015] }),
  );
  const result = normalizeNwsAlerts(payload, {
    zoneLookup: lookupOf({ [FLZ115]: squarePolygons(-85, 29) }),
    nowMs: NOW,
  });
  assert.deepEqual(
    result.features.map(({ id }) => id),
    ['urn:oid:ready'],
  );
  assert.equal(result.details.pendingAlerts, 2);
  // FLZ116 is needed by both omitted alerts but counts once.
  assert.equal(result.details.pendingZones, 2);
});

test('gone zones are skipped; an alert with no area at all is unmapped', () => {
  const payload = nwsCollection(
    nwsAlert({ id: 'urn:oid:partial', zones: [FLZ115, FLZ116] }),
    nwsAlert({ id: 'urn:oid:nothing', zones: [FLZ116] }),
    nwsAlert({ id: 'urn:oid:no-zones', zones: [] }),
    nwsAlert({ id: 'urn:oid:bad-zone-url', zones: ['https://evil.example/z'] }),
  );
  const result = normalizeNwsAlerts(payload, {
    zoneLookup: lookupOf({
      [FLZ115]: squarePolygons(-85, 29),
      [FLZ116]: null,
    }),
    nowMs: NOW,
  });
  assert.deepEqual(
    result.features.map(({ id }) => id),
    ['urn:oid:partial'],
  );
  assert.equal(result.features[0].geometry.type, 'Polygon');
  assert.equal(result.details.unmappedAlerts, 3);
  assert.equal(result.details.pendingAlerts, 0);
});

test('bad alerts are skipped: expired, test status, no id, duplicate, bad geometry', () => {
  const lookup = lookupOf({ [FLZ115]: squarePolygons(-85, 29) });
  const payload = nwsCollection(
    nwsAlert({ id: 'urn:oid:good', zones: [FLZ115] }),
    nwsAlert({
      id: 'urn:oid:expired',
      zones: [FLZ115],
      expires: '2026-10-25T02:00:00-04:00',
    }),
    nwsAlert({ id: 'urn:oid:test', zones: [FLZ115], status: 'Test' }),
    nwsAlert({ id: 'urn:oid:good', zones: [FLZ115] }),
    {
      type: 'Feature',
      geometry: null,
      properties: { affectedZones: [FLZ115] },
    },
    null,
    'text',
    nwsAlert({
      id: 'urn:oid:open-ring',
      geometry: polygonGeometry([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
      zones: [FLZ115],
    }),
    nwsAlert({
      id: 'urn:oid:nan',
      geometry: polygonGeometry([
        [0, 0],
        [Number.NaN, 0],
        [1, 1],
        [0, 0],
      ]),
      zones: [],
    }),
    nwsAlert({
      id: 'urn:oid:out-of-range',
      geometry: polygonGeometry(squareRing(200, 95)),
      zones: [],
    }),
  );
  const result = normalizeNwsAlerts(payload, {
    zoneLookup: lookup,
    nowMs: NOW,
  });
  // The open-ring alert falls back to its zone; the two unusable polygons
  // with no zones are unmapped.
  assert.deepEqual(result.features.map(({ id }) => id).sort(), [
    'urn:oid:good',
    'urn:oid:open-ring',
  ]);
  assert.equal(result.details.unmappedAlerts, 2);
  assertValidFeatureCollection(result, { requireIds: true });
});

test('alerts are ordered most severe first and unknown severities read as Unknown', () => {
  const lookup = lookupOf({ [FLZ115]: squarePolygons(-85, 29) });
  const result = normalizeNwsAlerts(
    nwsCollection(
      nwsAlert({ id: 'urn:oid:a', zones: [FLZ115], severity: 'Minor' }),
      nwsAlert({ id: 'urn:oid:b', zones: [FLZ115], severity: 'Extreme' }),
      nwsAlert({ id: 'urn:oid:c', zones: [FLZ115], severity: 'Bogus' }),
      nwsAlert({ id: 'urn:oid:d', zones: [FLZ115], severity: 'Severe' }),
    ),
    { zoneLookup: lookup, nowMs: NOW },
  );
  assert.deepEqual(
    result.features.map((f) => [f.id, f.properties.severity]),
    [
      ['urn:oid:b', 'Extreme'],
      ['urn:oid:d', 'Severe'],
      ['urn:oid:a', 'Minor'],
      ['urn:oid:c', 'Unknown'],
    ],
  );
});

test('only weather.gov links survive, upgraded to https', () => {
  const lookup = lookupOf({ [FLZ115]: squarePolygons(-85, 29) });
  const urlFor = (web) =>
    normalizeNwsAlerts(nwsCollection(nwsAlert({ zones: [FLZ115], web })), {
      zoneLookup: lookup,
      nowMs: NOW,
    }).features[0].properties.url;
  assert.equal(urlFor('http://www.weather.gov'), 'https://www.weather.gov/');
  assert.equal(
    urlFor('https://www.weather.gov/tae/'),
    'https://www.weather.gov/tae/',
  );
  assert.equal(urlFor('http://evil.example/weather.gov'), null);
  assert.equal(urlFor('javascript:alert(1)'), null);
  assert.equal(urlFor(null), null);
});

test('a corrupt or non-collection alerts payload throws invalid_payload', () => {
  for (const payload of [
    null,
    'oops',
    [],
    { type: 'FeatureCollection' },
    { type: 'FeatureCollection', features: 'x' },
    { type: 'Feature', features: [] },
  ])
    assert.throws(
      () => normalizeNwsAlerts(payload, { zoneLookup: () => undefined }),
      { code: 'invalid_payload' },
    );
  assert.throws(() => nwsZonesToResolve(null, () => true), {
    code: 'invalid_payload',
  });
  // A legitimately empty list is not corrupt.
  assert.deepEqual(
    normalizeNwsAlerts(nwsCollection(), { zoneLookup: () => undefined })
      .features,
    [],
  );
});

test('decimation: a payload over the byte target is coarsened step by step', () => {
  const dense = polygonGeometry(circleRing(1, 400));
  const payload = nwsCollection(
    nwsAlert({ id: 'urn:oid:big', geometry: dense, severity: 'Severe' }),
  );
  const fine = normalizeNwsAlerts(payload, {
    zoneLookup: () => undefined,
    nowMs: NOW,
  });
  assert.equal(fine.details.tolerance, 0.01);
  const fineBytes = JSON.stringify(fine.features).length;
  const coarse = normalizeNwsAlerts(payload, {
    zoneLookup: () => undefined,
    nowMs: NOW,
    maxBytes: fineBytes - 1,
  });
  // One step up the tolerance ladder: 0.01 to 0.025 degrees.
  assert.equal(coarse.details.tolerance, 0.025);
  assert.ok(
    vertexCount(coarse.features[0].geometry) <
      vertexCount(fine.features[0].geometry),
  );
  assertValidFeatureCollection(coarse, { requireIds: true });
});

test('decimation: when no tolerance fits, the least severe alerts go first', () => {
  const lookup = lookupOf({ [FLZ115]: squarePolygons(-85, 29) });
  const features = ['Minor', 'Extreme', 'Moderate', 'Severe'].map((severity) =>
    nwsAlert({ id: `urn:oid:${severity}`, zones: [FLZ115], severity }),
  );
  const one = normalizeNwsAlerts(nwsCollection(features[1]), {
    zoneLookup: lookup,
    nowMs: NOW,
  });
  const oneBytes = JSON.stringify(one.features).length;
  const result = normalizeNwsAlerts(nwsCollection(...features), {
    zoneLookup: lookup,
    nowMs: NOW,
    maxBytes: oneBytes * 2 + 10,
  });
  assert.deepEqual(
    result.features.map(({ id }) => id),
    ['urn:oid:Extreme', 'urn:oid:Severe'],
  );
});

test('zone fetch priority: severe alerts first, then the fewest missing zones', () => {
  const z = (n) => zoneUrl(`TXZ${100 + n}`);
  const payload = nwsCollection(
    nwsAlert({ id: 'urn:oid:minor', zones: [z(1)], severity: 'Minor' }),
    nwsAlert({
      id: 'urn:oid:severe-big',
      zones: [z(2), z(3), z(4)],
      severity: 'Severe',
    }),
    nwsAlert({
      id: 'urn:oid:severe-small',
      zones: [z(5), z(2)],
      severity: 'Severe',
    }),
    nwsAlert({
      id: 'urn:oid:own',
      geometry: polygonGeometry(squareRing(0, 0)),
      zones: [z(6)],
      severity: 'Extreme',
    }),
    nwsAlert({ id: 'urn:oid:cached', zones: [z(7)], severity: 'Extreme' }),
    nwsAlert({
      id: 'urn:oid:expired',
      zones: [z(8)],
      severity: 'Extreme',
      expires: '2026-10-25T01:00:00-04:00',
    }),
  );
  const known = new Set([z(7)]);
  assert.deepEqual(
    nwsZonesToResolve(payload, (url) => !known.has(url), NOW),
    [z(5), z(2), z(3), z(4), z(1)],
  );
});

// ---------------------------------------------------------------------------
// tsunami.gov
// ---------------------------------------------------------------------------

test('PAAQ sample: the Information bulletin becomes a point with its facts', () => {
  const result = normalizeTsunamiFeed(tsunamiPaaq, {
    center: 'PAAQ',
    nowMs: NOW,
  });
  assert.deepEqual(result.features, [
    {
      type: 'Feature',
      id: 'PAAQ-890504a1-0c59-4a3d-b6be-7bee3e3bebc3',
      geometry: { type: 'Point', coordinates: [139.9, 28] },
      properties: {
        title: 'in the Bonin Islands, Japan region',
        level: 'information',
        center: 'PAAQ',
        magnitude: 7,
        magnitudeType: 'Mwp',
        url: 'https://www.tsunami.gov/events/PAAQ/2026/10/25/tnfxzn/1/WEAK53/WEAK53.txt',
        timestamp: '2026-10-25T02:26:53.000Z',
      },
    },
  ]);
  assertValidFeatureCollection(result, { requireIds: true });
});

test('PHEB sample: "28." degrees parse, padded text collapses, link whitespace trims', () => {
  const [feature] = normalizeTsunamiFeed(tsunamiPheb, {
    center: 'PHEB',
    nowMs: NOW,
  }).features;
  assert.deepEqual(feature.geometry.coordinates, [139.9, 28]);
  assert.equal(feature.id, 'PHEB-ba64bc82-07f7-45fb-ab6c-25420fca6851');
  assert.equal(feature.properties.title, 'BONIN ISLANDS JAPAN REGION');
  assert.equal(
    feature.properties.url,
    'https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt',
  );
});

test('levels come from the Category text', () => {
  assert.equal(tsunamiLevel('Warning'), 'warning');
  assert.equal(tsunamiLevel('Tsunami Advisory'), 'advisory');
  assert.equal(tsunamiLevel('WATCH'), 'watch');
  assert.equal(tsunamiLevel('Threat'), 'watch');
  assert.equal(tsunamiLevel('Information'), 'information');
  assert.equal(tsunamiLevel('Final'), 'information');
  assert.equal(tsunamiLevel(undefined), 'information');
  const xml = tsunamiFeedOf(
    tsunamiEntry({ category: 'Warning', id: 'urn:uuid:w' }),
    tsunamiEntry({ category: 'Advisory', id: 'urn:uuid:a' }),
  );
  assert.deepEqual(
    normalizeTsunamiFeed(xml, { center: 'PAAQ', nowMs: NOW }).features.map(
      (f) => [f.id, f.properties.level, f.properties.magnitude],
    ),
    [
      ['PAAQ-w', 'warning', 8.1],
      ['PAAQ-a', 'advisory', 8.1],
    ],
  );
});

test('tsunami entries: bad coordinates, old updates and duplicates are skipped', () => {
  const xml = tsunamiFeedOf(
    tsunamiEntry({ id: 'urn:uuid:good' }),
    tsunamiEntry({ id: 'urn:uuid:good' }),
    tsunamiEntry({ id: 'urn:uuid:nan', lat: 'abc' }),
    tsunamiEntry({ id: 'urn:uuid:range', lat: '95.0' }),
    tsunamiEntry({ id: 'urn:uuid:lon', lon: '-200' }),
    tsunamiEntry({ id: 'urn:uuid:missing', geo: '' }),
    tsunamiEntry({ id: 'urn:uuid:old', updated: '2026-10-20T06:00:00Z' }),
    tsunamiEntry({ id: 'urn:uuid:no-time', updated: 'yesterday' }),
  );
  assert.deepEqual(
    normalizeTsunamiFeed(xml, { center: 'PAAQ', nowMs: NOW }).features.map(
      (f) => f.id,
    ),
    ['PAAQ-good'],
  );
});

test('tsunami entries: georss:point fallback, entities, unsafe links', () => {
  const xml = tsunamiFeedOf(
    tsunamiEntry({
      id: 'urn:uuid:geo',
      title: 'Strait of Juan de Fuca &amp; Puget Sound',
      geo: '<georss:point>48.25 -123.5</georss:point>',
      href: 'http://www.tsunami.gov/plain-http.txt',
    }),
    tsunamiEntry({
      id: 'urn:uuid:other-host',
      href: 'https://evil.example/WEAK51.txt',
    }),
    tsunamiEntry({ id: 'urn:uuid:no-magnitude', magnitude: 'n/a' }),
  );
  const [geo, host, none] = normalizeTsunamiFeed(xml, {
    center: 'PAAQ',
    nowMs: NOW,
  }).features;
  assert.deepEqual(geo.geometry.coordinates, [-123.5, 48.25]);
  assert.equal(geo.properties.title, 'Strait of Juan de Fuca & Puget Sound');
  assert.equal(geo.properties.url, null);
  assert.equal(host.properties.url, null);
  assert.equal(none.properties.magnitude, null);
  assert.equal(none.properties.magnitudeType, null);
});

test('a feed with no entries is empty; a non-Atom body throws invalid_payload', () => {
  assert.deepEqual(
    normalizeTsunamiFeed(tsunamiFeedOf(), { center: 'PAAQ', nowMs: NOW })
      .features,
    [],
  );
  for (const body of [
    '<html><body>Service unavailable</body></html>',
    '',
    null,
    { feed: true },
  ])
    assert.throws(
      () => normalizeTsunamiFeed(body, { center: 'PAAQ', nowMs: NOW }),
      { code: 'invalid_payload' },
    );
});

test('feeds merge with the most severe level first', () => {
  const warning = normalizeTsunamiFeed(
    tsunamiFeedOf(tsunamiEntry({ id: 'urn:uuid:w', category: 'Warning' })),
    { center: 'PHEB', nowMs: NOW },
  );
  const info = normalizeTsunamiFeed(tsunamiPaaq, {
    center: 'PAAQ',
    nowMs: NOW,
  });
  const merged = mergeTsunamiFeeds([info, warning]);
  assert.deepEqual(
    merged.features.map((f) => f.properties.level),
    ['warning', 'information'],
  );
  assertValidFeatureCollection(merged, { requireIds: true });
});
