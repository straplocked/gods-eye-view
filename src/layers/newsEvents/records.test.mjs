import assert from 'node:assert/strict';
import test from 'node:test';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  BALLIA,
  BATCH,
  BRAZIL,
  CHICAGO,
  INDIA,
  KYIV,
  LUCKNOW,
  NOW_MS,
  batchCsv,
  gkgLine,
  pointerText,
} from '../../testSupport/newsEventsFixtures.mjs';
import {
  earlierBatchStamp,
  parseGdeltPointer,
  parseGdeltTime,
  parseLocationBlock,
  normalizeGkg,
  themeLabel,
} from './records.js';

const normalize = (text, extra = {}) =>
  normalizeGkg(text, { nowMs: NOW_MS, batch: BATCH, ...extra });
const byId = (collection, id) => collection.features.find((f) => f.id === id);

test('the pointer: the GKG line gives the batch, size and md5; the URL is rebuilt on the fixed host', () => {
  const pointer = parseGdeltPointer(
    pointerText({ size: 1953389, md5: '1cc1842015c0e4f7ef78a78847507b73' }),
  );
  assert.deepEqual(pointer, {
    stamp: '20261025084500',
    size: 1953389,
    md5: '1cc1842015c0e4f7ef78a78847507b73',
    url: 'https://data.gdeltproject.org/gdeltv2/20261025084500.gkg.csv.zip',
  });
  // The :443 form GDELT's redirect uses, and https, read the same.
  const form = (url) => `100 ${'a'.repeat(32)} ${url}`;
  for (const url of [
    'https://data.gdeltproject.org:443/gdeltv2/20261025084500.gkg.csv.zip',
    'https://data.gdeltproject.org/gdeltv2/20261025084500.gkg.csv.zip',
  ])
    assert.equal(parseGdeltPointer(form(url)).url, pointer.url);
});

test('a pointer naming another host, path, checksum or an impossible time is refused', () => {
  const md5 = 'b'.repeat(32);
  for (const line of [
    `100 ${md5} http://evil.example/gdeltv2/20261025084500.gkg.csv.zip`,
    `100 ${md5} http://data.gdeltproject.org.evil.example/gdeltv2/20261025084500.gkg.csv.zip`,
    `100 ${md5} http://data.gdeltproject.org/other/20261025084500.gkg.csv.zip`,
    `100 ${md5} http://data.gdeltproject.org/gdeltv2/../20261025084500.gkg.csv.zip`,
    `100 ${md5.slice(1)} http://data.gdeltproject.org/gdeltv2/20261025084500.gkg.csv.zip`,
    `100 ${md5.toUpperCase()} http://data.gdeltproject.org/gdeltv2/20261025084500.gkg.csv.zip`,
    `100 ${md5} http://data.gdeltproject.org/gdeltv2/20261025084500.export.CSV.zip`,
    `100 ${md5} http://data.gdeltproject.org/gdeltv2/20261325084500.gkg.csv.zip`,
    '',
    '<html>error</html>',
  ])
    assert.throws(() => parseGdeltPointer(line), { code: 'invalid_payload' });
  assert.throws(() => parseGdeltPointer(null), { code: 'invalid_payload' });
});

test('earlier batch stamps step back by quarter hours across hours, days and months', () => {
  assert.equal(earlierBatchStamp('20261025130000', 0), '20261025130000');
  assert.equal(earlierBatchStamp('20261025130000', 1), '20261025124500');
  assert.equal(earlierBatchStamp('20261025130000', 5), '20261025114500');
  assert.equal(earlierBatchStamp('20261101001500', 2), '20261031234500');
  assert.equal(earlierBatchStamp('20260301000000', 1), '20260228234500');
  assert.equal(earlierBatchStamp('nonsense', 1), null);
});

test('GDELT times are real UTC dates or null', () => {
  assert.equal(parseGdeltTime('20261025084500'), Date.UTC(2026, 9, 25, 8, 45));
  for (const value of [
    '20261325084500',
    '20260230000000',
    '2026102508450',
    'abc',
    '',
    null,
  ])
    assert.equal(parseGdeltTime(value), null);
});

test('location blocks: coordinates must be plain numbers inside WGS84 and not 0,0', () => {
  assert.deepEqual(parseLocationBlock(LUCKNOW), {
    type: 4,
    name: 'Lucknow, Uttar Pradesh, India',
    countryCode: 'IN',
    lat: 26.85,
    lon: 80.9167,
    featureId: '-2102835',
  });
  assert.equal(parseLocationBlock(INDIA).featureId, 'IN');
  assert.equal(parseLocationBlock(BRAZIL).lat, -10);
  const withCoords = (lat, lon) => `4#Place, X#XX#XX00#0#${lat}#${lon}#77#1`;
  assert.equal(parseLocationBlock(withCoords('12.5', '-70.25')).lat, 12.5);
  assert.equal(parseLocationBlock(withCoords('12.5', '-70.25')).lon, -70.25);
  for (const bad of [
    withCoords('', '10'),
    withCoords('10', ''),
    withCoords('abc', '10'),
    withCoords('NaN', '10'),
    withCoords('1e2', '10'),
    withCoords('91', '10'),
    withCoords('-90.5', '10'),
    withCoords('10', '180.5'),
    withCoords('0', '0'),
    withCoords('0.0', '0.0'),
    '4#Short#XX#XX00#0#1#2',
    '4#Long#XX#XX00#0#1#2#3#4#5',
    '9#Place, X#XX#XX00#0#1#2#3#4',
    '4##XX#XX00#0#1#2#3#4',
    '',
  ])
    assert.equal(parseLocationBlock(bad), null, bad);
  // A FeatureID that is not a short plain token is dropped, not trusted.
  assert.equal(
    parseLocationBlock('4#Place, X#XX#XX00#0#1#2#<script>#1').featureId,
    null,
  );
});

test('guard: a line with two locations yields two features at their own coordinates with the line tone, and a malformed block skips only that block', () => {
  const line = gkgLine({
    id: 'g-1',
    url: 'https://example-daily.com/two-places',
    themes: 'ELECTION;',
    locations: [LUCKNOW, 'garbage#block', BALLIA].join(';'),
    tone: '-2.5,1,3.5,4.5,20,0,300',
  });
  const out = normalize(line);
  assert.deepEqual(
    out.features.map((f) => [
      f.id,
      f.geometry.coordinates,
      f.properties.tone,
      f.properties.articleCount,
    ]),
    [
      ['-2089956', [84.1667, 25.75], -2.5, 1],
      ['-2102835', [80.9167, 26.85], -2.5, 1],
    ],
  );
  assert.equal(out.details.skippedBlocks, 1);
  assert.equal(out.details.records, 1);
  assertValidFeatureCollection(out);
});

test('a hand-written batch aggregates by place with exact values', () => {
  const out = normalize(batchCsv());
  assertValidFeatureCollection(out);
  assert.deepEqual(out.details, {
    batch: '2026-10-25T08:45:00.000Z',
    records: 6,
    geolocated: 5,
    locations: 5,
    corruptLines: 3,
    skippedBlocks: 3,
  });
  // Busiest first; ties go to conflict places, then the newest, then the id.
  assert.deepEqual(
    out.features.map((f) => f.id),
    ['-2102835', '-1044367', '423587', 'BR', '-2089956'],
  );

  const lucknow = byId(out, '-2102835');
  assert.deepEqual(lucknow.geometry, {
    type: 'Point',
    coordinates: [80.9167, 26.85],
  });
  assert.deepEqual(lucknow.properties, {
    name: 'Lucknow, Uttar Pradesh, India',
    country: 'India',
    countryCode: 'IN',
    precision: 'city',
    articleCount: 2,
    // (-0.32 + -6.5) / 2
    tone: -3.41,
    conflict: true,
    conflictCount: 1,
    themes: ['Armed conflict', 'Election', 'Killings', 'Protest'],
    articles: [
      {
        // http only: counted and shown, but no link.
        url: null,
        source: 'city-news.example',
        title: null,
        tone: -6.5,
        date: '2026-10-25T08:30:00.000Z',
      },
      {
        url: 'https://example-daily.com/politics/poster-war',
        source: 'example-daily.com',
        title: 'Poster War & More: UP Heads to the Polls',
        tone: -0.32,
        // The publisher's own time wins over the batch time.
        date: '2026-10-25T07:29:00.000Z',
      },
    ],
    timestamp: '2026-10-25T08:30:00.000Z',
  });

  const kyiv = byId(out, '-1044367');
  assert.equal(kyiv.properties.name, "Kyiv, Kyyivs'ka Oblast', Ukraine");
  assert.equal(kyiv.properties.country, 'Ukraine');
  assert.equal(kyiv.properties.countryCode, 'UP');
  assert.equal(kyiv.properties.conflict, true);
  assert.deepEqual(kyiv.properties.themes, [
    'Armed conflict',
    'Military',
    'Natural disaster',
  ]);
  assert.equal(kyiv.properties.timestamp, '2026-10-25T08:15:00.000Z');

  // The country mention of the first record was dropped for its two cities.
  assert.equal(byId(out, 'IN'), undefined);
  const ballia = byId(out, '-2089956');
  assert.equal(ballia.properties.conflict, false);
  assert.equal(ballia.properties.conflictCount, 0);
  assert.deepEqual(ballia.properties.themes, ['Election']);
  assert.equal(ballia.properties.tone, -0.32);

  // A country-only mention stays a country point.
  const brazil = byId(out, 'BR');
  assert.equal(brazil.properties.precision, 'country');
  assert.equal(brazil.properties.country, 'Brazil');
  assert.deepEqual(brazil.geometry.coordinates, [-55, -10]);
  assert.equal(brazil.properties.articles[0].date, '2026-10-25T08:45:00.000Z');

  // Chicago: its record had three bad blocks and an unreadable tone.
  const chicago = byId(out, '423587');
  assert.equal(chicago.properties.tone, null);
  assert.equal(chicago.properties.country, 'United States');
  assert.equal(chicago.properties.precision, 'city');
  assert.deepEqual(chicago.properties.articles[0].title, 'Council votes');
  // Nothing was placed at 0,0.
  assert.equal(
    out.features.some(
      ({ geometry }) =>
        geometry.coordinates[0] === 0 && geometry.coordinates[1] === 0,
    ),
    false,
  );
});

test('the five most recent articles are kept, the count covers all, and a repeated URL counts once', () => {
  const lines = [];
  for (let minute = 0; minute < 8; minute++)
    lines.push(
      gkgLine({
        id: `a-${minute}`,
        url: `https://news.example/story-${minute}`,
        source: `source-${minute}`,
        locations: KYIV,
        tone: `${minute},0,0,0,0,0,1`,
        extras: `<PAGE_PRECISEPUBTIMESTAMP>20261025080${minute}00</PAGE_PRECISEPUBTIMESTAMP><PAGE_TITLE>Story ${minute}</PAGE_TITLE>`,
      }),
    );
  // The same document again, and a record naming Kyiv twice.
  lines.push(
    gkgLine({
      id: 'dup',
      url: 'https://news.example/story-0',
      locations: KYIV,
    }),
    gkgLine({
      id: 'twice',
      url: 'https://news.example/story-twice',
      locations: [KYIV, KYIV].join(';'),
      extras:
        '<PAGE_PRECISEPUBTIMESTAMP>20261025083000</PAGE_PRECISEPUBTIMESTAMP>',
    }),
  );
  const [kyiv] = normalize(lines.join('\n')).features;
  // 8 distinct stories + story-twice (the duplicate story-0 does not count).
  assert.equal(kyiv.properties.articleCount, 9);
  assert.deepEqual(
    kyiv.properties.articles.map((a) => a.title ?? a.source),
    ['example-daily.com', 'Story 7', 'Story 6', 'Story 5', 'Story 4'],
  );
  assert.equal(kyiv.properties.articles.length, 5);
  assert.equal(kyiv.properties.timestamp, '2026-10-25T08:30:00.000Z');
});

test('country mentions are dropped only where the same record names a place inside that country', () => {
  const out = normalize(
    [
      gkgLine({
        id: '1',
        url: 'https://a.example/1',
        locations: [INDIA, LUCKNOW].join(';'),
      }),
      gkgLine({
        id: '2',
        url: 'https://a.example/2',
        locations: [INDIA, KYIV].join(';'),
      }),
      gkgLine({ id: '3', url: 'https://a.example/3', locations: INDIA }),
    ].join('\n'),
  );
  // India is kept only for the record that names nothing more specific in it.
  assert.equal(byId(out, 'IN').properties.articleCount, 2);
  assert.equal(byId(out, '-2102835').properties.articleCount, 1);
  assert.equal(byId(out, '-1044367').properties.articleCount, 1);
});

test('a record contributes to at most 20 distinct places', () => {
  const blocks = Array.from(
    { length: 30 },
    (_, index) =>
      `4#Town ${index}, Land#XX#XX00#0#${index + 1}#${index + 2}#${1000 + index}#1`,
  );
  const out = normalize(gkgLine({ locations: blocks.join(';') }));
  assert.equal(out.features.length, 20);
  assert.ok(byId(out, '1019'));
  assert.equal(byId(out, '1020'), undefined);
});

test('a place without a FeatureID is keyed by its rounded coordinates', () => {
  const out = normalize(
    [
      gkgLine({
        id: '1',
        url: 'https://a.example/1',
        locations: '4#Nameless, Z#ZZ#ZZ00#0#10.12345#20.54321##1',
      }),
      gkgLine({
        id: '2',
        url: 'https://a.example/2',
        locations: '4#Nameless, Z#ZZ#ZZ00#0#10.12349#20.54324##9',
      }),
    ].join('\n'),
  );
  assert.deepEqual(
    out.features.map((f) => [f.id, f.properties.articleCount]),
    [['ll_10.1235_20.5432', 2]],
  );
});

test('titles are decoded, cleaned and clipped; links must be credential-free http(s)', () => {
  const out = normalize(
    [
      gkgLine({
        id: '1',
        url: 'https://a.example/1',
        locations: KYIV,
        extras: `<PAGE_TITLE>  Tom &amp; Jerry &#8212; &lt;b&gt;bold&lt;/b&gt;\u0007&#x1F600;\u2028 now  </PAGE_TITLE>`,
      }),
      gkgLine({
        id: '2',
        url: 'https://user:secret@a.example/2',
        locations: KYIV,
      }),
      gkgLine({ id: '3', url: 'javascript:alert(1)', locations: KYIV }),
      gkgLine({
        id: '4',
        url: `https://a.example/${'x'.repeat(2100)}`,
        locations: KYIV,
      }),
      gkgLine({
        id: '5',
        url: 'https://a.example/5',
        locations: KYIV,
        extras: `<PAGE_TITLE>${'é'.repeat(300)}</PAGE_TITLE>`,
      }),
    ].join('\n'),
  );
  const kyiv = byId(out, '-1044367');
  assert.equal(kyiv.properties.articleCount, 2);
  const titles = kyiv.properties.articles.map((a) => a.title);
  assert.ok(
    titles.includes('Tom & Jerry — <b>bold</b> 😀 now'),
    titles.join('|'),
  );
  assert.ok(titles.includes('é'.repeat(200)));
  assert.equal(out.details.corruptLines, 3);
});

test('a publisher time after the batch is ignored; a batch time in the future drops the record', () => {
  const out = normalize(
    [
      gkgLine({
        id: '1',
        url: 'https://a.example/1',
        locations: KYIV,
        extras:
          '<PAGE_PRECISEPUBTIMESTAMP>20261026000000</PAGE_PRECISEPUBTIMESTAMP>',
      }),
      gkgLine({
        id: '2',
        date: '20261025120000',
        url: 'https://a.example/2',
        locations: BALLIA,
      }),
    ].join('\n'),
  );
  assert.equal(out.features.length, 1);
  assert.equal(
    out.features[0].properties.timestamp,
    '2026-10-25T08:45:00.000Z',
  );
  assert.equal(out.details.corruptLines, 1);
});

test('themes: conflict flags, taxonomy codes filtered, top five by article count', () => {
  const lines = [];
  const themeSets = [
    'ELECTION;EDUCATION;MEDICAL;LEGISLATION;JUSTICE;TRIAL;',
    'ELECTION;EDUCATION;MEDICAL;LEGISLATION;JUSTICE;',
    'ELECTION;EDUCATION;MEDICAL;LEGISLATION;',
    'ELECTION;EDUCATION;MEDICAL;',
    'ELECTION;EDUCATION;TAX_ECON_PRICE;WB_2432_FRAGILITY_CONFLICT_AND_VIOLENCE;lowercase;',
    'ELECTION;',
  ];
  themeSets.forEach((themes, index) =>
    lines.push(
      gkgLine({
        id: `t-${index}`,
        url: `https://a.example/${index}`,
        themes,
        locations: BALLIA,
      }),
    ),
  );
  const [ballia] = normalize(lines.join('\n')).features;
  assert.deepEqual(ballia.properties.themes, [
    'Election',
    'Education',
    'Medical',
    'Legislation',
    'Justice',
  ]);
  assert.equal(ballia.properties.conflict, false);
  assert.equal(themeLabel('NATURAL_DISASTER'), 'Natural disaster');
  assert.equal(themeLabel('ARMEDCONFLICT'), 'Armed conflict');
  // A taxonomy-only conflict code still sets the flag, and is not shown.
  const [terror] = normalize(
    gkgLine({ themes: 'TAX_TERROR_GROUP_X;', locations: KYIV }),
  ).features;
  assert.equal(terror.properties.conflict, true);
  assert.deepEqual(terror.properties.themes, []);
});

test('a place is a conflict place when a quarter of its articles have conflict themes', () => {
  const place = (conflicting, total) =>
    normalize(
      Array.from({ length: total }, (_, index) =>
        gkgLine({
          id: `c-${index}`,
          url: `https://news.example/c-${index}`,
          themes: index < conflicting ? 'ARMEDCONFLICT;' : 'EDUCATION;',
          locations: KYIV,
        }),
      ).join('\n'),
    ).features[0].properties;
  // 1 of 5 is 20%: counted, but the place is not flagged.
  assert.deepEqual(
    [place(1, 5).conflictCount, place(1, 5).conflict],
    [1, false],
  );
  // 2 of 8 is exactly a quarter.
  assert.deepEqual(
    [place(2, 8).conflictCount, place(2, 8).conflict],
    [2, true],
  );
  assert.equal(place(1, 1).conflict, true);
  assert.equal(place(0, 3).conflict, false);
});

test('corrupt or non-GKG payloads throw and are never an empty collection', () => {
  for (const bad of [
    '',
    '\n\n',
    'not a gkg file',
    '<html>503</html>',
    'a\tb\tc',
    gkgLine({ url: 'nope', locations: KYIV }),
  ])
    assert.throws(() => normalize(bad), { code: 'invalid_payload' }, bad);
  for (const bad of [null, undefined, 42, {}])
    assert.throws(() => normalize(bad), { code: 'invalid_payload' });
  // Records with no places are a valid (if quiet) batch.
  const quiet = normalize(gkgLine({ locations: '' }));
  assert.deepEqual(quiet.features, []);
  assert.equal(quiet.details.records, 1);
});

test('CRLF line endings and a missing final newline are read', () => {
  const lines = [
    gkgLine({ id: '1', url: 'https://a.example/1', locations: KYIV }),
    gkgLine({ id: '2', url: 'https://a.example/2', locations: KYIV }),
  ];
  assert.equal(
    normalize(lines.join('\r\n')).features[0].properties.articleCount,
    2,
  );
  assert.equal(
    normalize(`${lines.join('\n')}\n`).features[0].properties.articleCount,
    2,
  );
});

test('the batch time rides in the details only when valid', () => {
  assert.equal(
    normalize(gkgLine({ locations: KYIV }), { batch: 'zzz' }).details.batch,
    undefined,
  );
  assert.equal(
    normalize(gkgLine({ locations: KYIV }), { batch: null }).details.batch,
    undefined,
  );
  assert.throws(() => normalizeGkg(gkgLine(), {}), TypeError);
});
