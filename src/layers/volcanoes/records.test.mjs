import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GVP_URL,
  USGS_URL,
  gvpVolcanoUrl,
  mergeVolcanoFeatures,
  normalizeGvpEruptions,
  normalizeUsgsStatus,
} from './records.js';
import {
  gvpEruptions,
  usgsStatus,
} from '../../testSupport/volcanoesFixtures.mjs';
import {
  assertValidFeatureCollection,
  assertValidKeylessLayerCollection,
} from '../../testSupport/geojson.mjs';

/** What the keyless kit does to a subsource's output before `combine`. */
function stamp(collection, source) {
  return collection.features.map((feature) => ({
    ...feature,
    id: `${source}:${feature.id}`,
    properties: {
      ...feature.properties,
      layer: 'volcanoes',
      source,
      timestamp: feature.properties.timestamp ?? null,
    },
  }));
}

const gvpFeatures = () => stamp(normalizeGvpEruptions(gvpEruptions), 'gvp');
const usgsFeatures = () => stamp(normalizeUsgsStatus(usgsStatus), 'usgs');
const byId = (features) => new Map(features.map((f) => [f.id, f]));
const rawGvp = (properties, coordinates = [10, 20]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: {
    VolcanoNumber: 100001,
    VolcanoName: 'Test',
    ContinuingEruption: 'True',
    ...properties,
  },
});

test('upstream URLs are the fixed GVP WFS query and the USGS status list', () => {
  assert.equal(
    GVP_URL,
    'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:E3WebApp_Eruptions1960&outputFormat=application/json&CQL_FILTER=ContinuingEruption=%27True%27',
  );
  assert.equal(
    USGS_URL,
    'https://volcanoes.usgs.gov/vsc/api/volcanoApi/vhpstatus',
  );
  assert.equal(
    gvpVolcanoUrl(332010),
    'https://volcano.si.edu/volcano.cfm?vn=332010',
  );
});

test('GVP: one point per volcano with VEI, start and page link', () => {
  const collection = normalizeGvpEruptions(gvpEruptions);
  assertValidFeatureCollection(collection, { requireIds: true });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['332010', '311120', '223020', '252010', '257100'],
  );
  assert.deepEqual(byId(collection.features).get('332010'), {
    type: 'Feature',
    id: '332010',
    geometry: { type: 'Point', coordinates: [-155.287, 19.421] },
    properties: {
      name: 'Kilauea',
      vnum: 332010,
      eruption: true,
      vei: 1,
      eruptionStart: '2024-12-23T00:00:00.000Z',
      eruptionStartYear: 2024,
      url: 'https://volcano.si.edu/volcano.cfm?vn=332010',
      timestamp: '2024-12-23T00:00:00.000Z',
    },
  });
});

test('GVP: a volcano with two open records keeps the one that started last', () => {
  const nyamulagira = byId(normalizeGvpEruptions(gvpEruptions).features).get(
    '223020',
  ).properties;
  // The 2018 record (VEI 0) beats the 2010 one (VEI 2) listed after it.
  assert.equal(nyamulagira.vei, 0);
  assert.equal(nyamulagira.eruptionStart, '2018-04-14T00:00:00.000Z');
  const tied = normalizeGvpEruptions({
    features: [
      rawGvp({
        StartDateYear: 2020,
        StartDateMonth: 5,
        Activity_ID: 7,
        ExplosivityIndexMax: 1,
      }),
      rawGvp({
        StartDateYear: 2020,
        StartDateMonth: 5,
        Activity_ID: 9,
        ExplosivityIndexMax: 3,
      }),
      rawGvp({
        StartDateYear: 2020,
        StartDateMonth: 5,
        Activity_ID: 8,
        ExplosivityIndexMax: 2,
      }),
    ],
  });
  assert.equal(tied.features.length, 1);
  assert.equal(tied.features[0].properties.vei, 3);
  // A dated record beats a year-only one from the same year.
  const partial = normalizeGvpEruptions({
    features: [
      rawGvp({ StartDateYear: 2020, Activity_ID: 1, ExplosivityIndexMax: 1 }),
      rawGvp({
        StartDateYear: 2020,
        StartDateMonth: 2,
        StartDateDay: 3,
        Activity_ID: 0,
        ExplosivityIndexMax: 2,
      }),
    ],
  });
  assert.equal(partial.features[0].properties.vei, 2);
});

test('GVP: an eruption with only a start year has no start date', () => {
  const yasur = byId(normalizeGvpEruptions(gvpEruptions).features).get(
    '257100',
  );
  assert.deepEqual(yasur.properties, {
    name: 'Yasur',
    vnum: 257100,
    eruption: true,
    vei: 3,
    eruptionStart: null,
    eruptionStartYear: 1270,
    url: 'https://volcano.si.edu/volcano.cfm?vn=257100',
    timestamp: null,
  });
});

test('GVP: partial and impossible dates never invent a start', () => {
  const read = (properties) =>
    normalizeGvpEruptions({ features: [rawGvp(properties)] }).features[0]
      .properties;
  // Zeroes in the YYYYMMDD string mean "unknown".
  assert.deepEqual(
    [
      read({ StartDate: '20250000' }).eruptionStart,
      read({ StartDate: '20250000' }).eruptionStartYear,
    ],
    [null, 2025],
  );
  assert.equal(read({ StartDate: '20250300' }).eruptionStart, null);
  // 31 February is not a date.
  assert.equal(read({ StartDate: '20250231' }).eruptionStart, null);
  assert.equal(read({ StartDate: '20250231' }).eruptionStartYear, 2025);
  // The string alone is enough when the numeric parts are absent.
  assert.equal(
    read({ StartDate: '20180414' }).eruptionStart,
    '2018-04-14T00:00:00.000Z',
  );
  // No start at all.
  assert.deepEqual(
    [read({}).eruptionStart, read({}).eruptionStartYear, read({}).timestamp],
    [null, null, null],
  );
  // VEI outside 0-8 is unknown, not clamped.
  assert.equal(read({ ExplosivityIndexMax: 9 }).vei, null);
  assert.equal(read({ ExplosivityIndexMax: null }).vei, null);
});

test('GVP: bad records are skipped, not fatal', () => {
  const collection = normalizeGvpEruptions({
    features: [
      rawGvp({ VolcanoNumber: 100001, VolcanoName: 'Good' }),
      // Not continuing (a server that ignored the CQL filter).
      rawGvp({ VolcanoNumber: 100002, ContinuingEruption: 'False' }),
      rawGvp({ VolcanoNumber: 100003, ContinuingEruption: null }),
      // Bad volcano numbers.
      rawGvp({ VolcanoNumber: null }),
      rawGvp({ VolcanoNumber: 'x1' }),
      rawGvp({ VolcanoNumber: -5 }),
      rawGvp({ VolcanoNumber: 12 }),
      rawGvp({ VolcanoNumber: 1.5 }),
      // Bad positions and no decimal fallback.
      rawGvp({ VolcanoNumber: 100004 }, [NaN, 10]),
      rawGvp({ VolcanoNumber: 100005 }, [10, 91]),
      rawGvp({ VolcanoNumber: 100006 }, [181, 10]),
      rawGvp({ VolcanoNumber: 100007 }, null),
      {
        type: 'Feature',
        geometry: null,
        properties: { VolcanoNumber: 100008, ContinuingEruption: 'True' },
      },
      // No properties at all.
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: null,
      },
      null,
      'nope',
    ],
  });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['100001'],
  );
  assertValidFeatureCollection(collection, { requireIds: true });
});

test('GVP: the decimal fields stand in for a missing geometry', () => {
  const collection = normalizeGvpEruptions({
    features: [
      {
        type: 'Feature',
        geometry: null,
        properties: {
          VolcanoNumber: 100010,
          VolcanoName: 'Decimal',
          ContinuingEruption: 'True',
          LatitudeDecimal: 12.5,
          LongitudeDecimal: -60.25,
        },
      },
    ],
  });
  assert.deepEqual(collection.features[0].geometry, {
    type: 'Point',
    coordinates: [-60.25, 12.5],
  });
  assert.equal(collection.features[0].properties.name, 'Decimal');
});

test('GVP: an empty list of eruptions is legitimate; a corrupt payload throws', () => {
  assert.deepEqual(normalizeGvpEruptions({ features: [] }), {
    type: 'FeatureCollection',
    features: [],
  });
  for (const bad of [
    null,
    undefined,
    'x',
    3,
    [],
    {},
    { features: 'x' },
    { features: {} },
  ])
    assert.throws(() => normalizeGvpEruptions(bad), {
      code: 'invalid_payload',
    });
});

test('USGS: elevated volcanoes only, with level, color, observatory and link', () => {
  const collection = normalizeUsgsStatus(usgsStatus);
  assertValidFeatureCollection(collection, { requireIds: true });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['332010', '311120', '311360', '284141'],
  );
  assert.deepEqual(byId(collection.features).get('332010'), {
    type: 'Feature',
    id: '332010',
    geometry: { type: 'Point', coordinates: [-155.287, 19.421] },
    properties: {
      name: 'Kilauea',
      vnum: 332010,
      alertLevel: 'ADVISORY',
      colorCode: 'YELLOW',
      observatory: 'HVO',
      region: 'Hawaii',
      // The "HVO Kilauea YELLOW/ADVISORY - " prefix is dropped.
      synopsis:
        "The Halema'uma'u eruption of Kīlauea is currently paused after episode 55 fountaining ended on October 17. Summit reinflation continues today.",
      alertDate: '2026-10-24T18:37:53.000Z',
      url: 'https://www.usgs.gov/volcanoes/kilauea',
      timestamp: '2026-10-24T18:15:36.000Z',
    },
  });
  const sitkin = byId(collection.features).get('311120').properties;
  assert.equal(sitkin.alertLevel, 'WATCH');
  assert.equal(sitkin.colorCode, 'ORANGE');
  assert.equal(
    sitkin.synopsis,
    'Slow eruption of lava within the summit crater continues.',
  );
  assert.equal(
    sitkin.url,
    'https://www.avo.alaska.edu/activity/GreatSitkin.php',
  );
  assert.equal(
    byId(collection.features).get('284141').properties.observatory,
    'NMI',
  );
});

test('USGS: NORMAL and UNASSIGNED volcanoes are excluded by default', () => {
  const ids = normalizeUsgsStatus(usgsStatus).features.map((f) => f.id);
  assert.ok(!ids.includes('311320'), 'NORMAL Akutan must be excluded');
  assert.ok(!ids.includes('311800'), 'UNASSIGNED Adagdak must be excluded');
});

test('USGS: includeNormal keeps NORMAL volcanoes (never UNASSIGNED)', () => {
  const collection = normalizeUsgsStatus(usgsStatus, { includeNormal: true });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['332010', '311120', '311360', '284141', '311320'],
  );
  const akutan = collection.features.at(-1).properties;
  assert.equal(akutan.alertLevel, 'NORMAL');
  assert.equal(akutan.colorCode, 'GREEN');
  // An old notice id carries its own UTC offset: 15:47:55-08:00 is 23:47:55Z.
  assert.equal(akutan.timestamp, '2019-09-04T23:47:55.000Z');
});

test('USGS: bad volcanoes are skipped, odd fields are cleaned', () => {
  const base = {
    vName: 'Test',
    lat: 40,
    long: -120,
    vnum: '100001',
    volcanoCd: 'ca1',
    alertLevel: 'WATCH',
    colorCode: 'ORANGE',
    obs: 'cvo',
  };
  const read = (volcano) => normalizeUsgsStatus([volcano]).features;
  assert.equal(read(base).length, 1);
  assert.equal(read({ ...base, lat: 91 }).length, 0);
  assert.equal(read({ ...base, long: -181 }).length, 0);
  assert.equal(read({ ...base, lat: 'x' }).length, 0);
  assert.equal(read({ ...base, long: null }).length, 0);
  assert.equal(read({ ...base, alertLevel: null }).length, 0);
  assert.equal(read({ ...base, alertLevel: 'W4TCH!' }).length, 0);
  // No volcano number and no code: nothing to identify it by.
  assert.equal(read({ ...base, vnum: null, volcanoCd: null }).length, 0);
  assert.equal(read({ ...base, vnum: 'abc', volcanoCd: '' }).length, 0);
  // A volcano without a GVP number is identified by its USGS code.
  const coded = read({ ...base, vnum: null });
  assert.equal(coded[0].id, 'cd-ca1');
  assert.equal(coded[0].properties.vnum, null);
  // Unknown colors and unsafe links are dropped, not trusted.
  const odd = read({
    ...base,
    colorCode: 'PURPLE',
    vUrl: 'http://www.usgs.gov/volcanoes/test',
  })[0].properties;
  assert.equal(odd.colorCode, null);
  assert.equal(odd.url, null);
  for (const vUrl of [
    'https://evil.example/usgs.gov',
    'https://usgs.gov.evil.example/x',
    'https://user:pw@www.usgs.gov/x',
    'javascript:alert(1)',
    'not a url',
    'https://www.usgs.gov/' + 'a'.repeat(3000),
  ])
    assert.equal(read({ ...base, vUrl })[0].properties.url, null, vUrl);
  for (const vUrl of [
    'https://volcano.si.edu/volcano.cfm?vn=100001',
    'https://avo.alaska.edu/activity/Test.php',
    'https://volcanoes.usgs.gov/volcano/x',
  ])
    assert.equal(read({ ...base, vUrl })[0].properties.url, vUrl);
  // A repeated volcano number keeps the first record; junk entries are ignored.
  const repeated = normalizeUsgsStatus([
    { ...base, vName: 'First' },
    { ...base, vName: 'Second' },
    null,
    'x',
    [],
  ]);
  assert.deepEqual(
    repeated.features.map((f) => f.properties.name),
    ['First'],
  );
  // Long synopses are capped.
  const long = read({
    ...base,
    noticeSynopsis: `CVO Test ORANGE/WATCH - ${'x'.repeat(900)}`,
  });
  assert.equal(long[0].properties.synopsis.length, 400);
});

test('USGS: a payload that is not a non-empty list throws', () => {
  for (const bad of [null, undefined, 'x', 3, {}, { features: [] }, []])
    assert.throws(() => normalizeUsgsStatus(bad), { code: 'invalid_payload' });
});

test("merge: a volcano in both feeds becomes one feature with both feeds' fields", () => {
  const merged = mergeVolcanoFeatures([...gvpFeatures(), ...usgsFeatures()]);
  const kilauea = merged.filter((f) => f.properties.vnum === 332010);
  assert.equal(kilauea.length, 1, 'one feature per volcano');
  assert.deepEqual(kilauea[0], {
    type: 'Feature',
    id: 'volcano:332010',
    // The point is GVP's.
    geometry: { type: 'Point', coordinates: [-155.287, 19.421] },
    properties: {
      layer: 'volcanoes',
      source: 'gvp+usgs',
      name: 'Kilauea',
      vnum: 332010,
      eruption: true,
      vei: 1,
      eruptionStart: '2024-12-23T00:00:00.000Z',
      eruptionStartYear: 2024,
      alertLevel: 'ADVISORY',
      colorCode: 'YELLOW',
      observatory: 'HVO',
      region: 'Hawaii',
      synopsis:
        "The Halema'uma'u eruption of Kīlauea is currently paused after episode 55 fountaining ended on October 17. Summit reinflation continues today.",
      alertDate: '2026-10-24T18:37:53.000Z',
      url: 'https://www.usgs.gov/volcanoes/kilauea',
      gvpUrl: 'https://volcano.si.edu/volcano.cfm?vn=332010',
      usgsUrl: 'https://www.usgs.gov/volcanoes/kilauea',
      timestamp: '2026-10-24T18:15:36.000Z',
    },
  });
});

test("merge: GVP-only and USGS-only volcanoes keep one feed's fields", () => {
  const merged = byId(
    mergeVolcanoFeatures([...gvpFeatures(), ...usgsFeatures()]),
  );
  assert.deepEqual(
    [...merged.keys()],
    [
      'volcano:332010',
      'volcano:311120',
      'volcano:223020',
      'volcano:252010',
      'volcano:257100',
      'volcano:311360',
      'volcano:284141',
    ],
  );
  assert.deepEqual(merged.get('volcano:223020').properties, {
    layer: 'volcanoes',
    source: 'gvp',
    name: 'Nyamulagira',
    vnum: 223020,
    eruption: true,
    vei: 0,
    eruptionStart: '2018-04-14T00:00:00.000Z',
    eruptionStartYear: 2018,
    alertLevel: null,
    colorCode: null,
    observatory: null,
    region: null,
    synopsis: null,
    alertDate: null,
    url: 'https://volcano.si.edu/volcano.cfm?vn=223020',
    gvpUrl: 'https://volcano.si.edu/volcano.cfm?vn=223020',
    usgsUrl: null,
    timestamp: '2018-04-14T00:00:00.000Z',
  });
  assert.deepEqual(merged.get('volcano:311360').properties, {
    layer: 'volcanoes',
    source: 'usgs',
    name: 'Shishaldin',
    vnum: 311360,
    eruption: false,
    vei: null,
    eruptionStart: null,
    eruptionStartYear: null,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    observatory: 'AVO',
    region: 'Aleutians',
    synopsis: 'Low-level unrest continues.',
    alertDate: '2026-10-24T18:28:00.000Z',
    url: 'https://avo.alaska.edu/activity/Shishaldin.php',
    gvpUrl: null,
    usgsUrl: 'https://avo.alaska.edu/activity/Shishaldin.php',
    timestamp: '2026-10-24T17:32:14.000Z',
  });
  // Great Sitkin is in both; Akutan (NORMAL) never made it in.
  assert.equal(merged.get('volcano:311120').properties.source, 'gvp+usgs');
  assert.equal(merged.get('volcano:311120').properties.colorCode, 'ORANGE');
  assert.equal(merged.has('volcano:311320'), false);
  assert.equal(merged.get('volcano:257100').properties.timestamp, null);
});

test('merge: the id does not change when one feed drops out', () => {
  const both = byId(
    mergeVolcanoFeatures([...gvpFeatures(), ...usgsFeatures()]),
  );
  const gvpOnly = byId(mergeVolcanoFeatures(gvpFeatures()));
  const usgsOnly = byId(mergeVolcanoFeatures(usgsFeatures()));
  assert.equal(gvpOnly.get('volcano:332010').properties.source, 'gvp');
  assert.equal(gvpOnly.get('volcano:332010').properties.colorCode, null);
  assert.equal(usgsOnly.get('volcano:332010').properties.source, 'usgs');
  assert.equal(usgsOnly.get('volcano:332010').properties.eruptionStart, null);
  assert.equal(usgsOnly.get('volcano:332010').properties.eruption, false);
  for (const id of ['volcano:332010', 'volcano:311120'])
    assert.ok(both.has(id) && gvpOnly.has(id) && usgsOnly.has(id), id);
});

test('merge: output satisfies the keyless layer contract and inputs are untouched', () => {
  const input = [...gvpFeatures(), ...usgsFeatures()];
  const snapshot = JSON.stringify(input);
  const merged = mergeVolcanoFeatures(input);
  assert.equal(JSON.stringify(input), snapshot, 'input features were changed');
  assertValidKeylessLayerCollection(
    {
      type: 'FeatureCollection',
      features: merged,
      metadata: { layer: 'volcanoes', stale: false, sources: [] },
    },
    'volcanoes',
  );
  assert.deepEqual(mergeVolcanoFeatures([]), []);
});

test('merge: features from an unknown source or without an id are ignored', () => {
  const [kilauea] = gvpFeatures();
  const merged = mergeVolcanoFeatures([
    kilauea,
    {
      ...kilauea,
      id: 'other:1',
      properties: { ...kilauea.properties, source: 'other' },
    },
    { ...kilauea, id: 'gvp:', properties: { ...kilauea.properties } },
    { ...kilauea, id: 5 },
    null,
  ]);
  assert.deepEqual(
    merged.map((f) => f.id),
    ['volcano:332010'],
  );
});
