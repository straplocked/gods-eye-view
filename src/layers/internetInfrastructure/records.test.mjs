import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IODA_ALERT_LIMIT,
  MIN_FACILITIES_LISTED,
  iodaAlertsUrl,
  normalizeFacilities,
  normalizeOutages,
} from './records.js';
import { COUNTRY_CENTROIDS, countryCentroid } from './countryCentroids.js';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';
import {
  BAD_COUNTRY_ALERTS,
  BAD_FACILITIES,
  COUNTRY_ALERTS,
  GOOD_FACILITIES,
  NOW_MS,
  T,
  alertsPayload,
  countryAlert,
  countryPayload,
  facilityPayload,
  facilityRow,
  regionAlert,
  regionPayload,
  unplacedFacilities,
} from '../../testSupport/internetInfrastructureFixtures.mjs';

const options = { nowMs: NOW_MS };
const invalid = { code: 'invalid_payload' };
const byId = (collection, id) =>
  collection.features.find((feature) => feature.id === id);
const ids = (collection) => collection.features.map((feature) => feature.id);

/** Every country code in IODA's own country list (253), copied by hand. */
const IODA_COUNTRY_CODES =
  `AW AF AO AI AX AL AD AN AE AR AM AP AS AQ TF AG AU AT AZ BI BE BJ BQ BF BD BG BH BS BA BL
BY BZ BM BO BR BB BN BT BV BW CF CA CC CH CL CN CI CM CD CG CK CO KM CV CR CU CW CX KY CY CZ DE DJ DM DK DO DZ EC EG
ER EH ES EE ET EU FI FJ FK FR FO FM GA GB GE GG GH GI GN GP GM GW GQ GR GD GL GT GF GU GY HK HM HN HR HT HU ID IM IN
IO IE IR IQ IS IL IT JM JE JO JP KZ KE KG KH KI KN KR KW LA LB LR LY LC LI LK LS LT LU LV MO MF MA MC MD MG MV MX MH
MK ML MT MM ME MN MP MZ MR MS MQ MU MW MY YT NA NC NE NF NG NI NU NL NO NP NR NZ OM PK PA PN PE PH PW PG PL PR KP PT
PY PS PF QA RE RO RU RW SA SD SN SG GS SH SJ SB SL SV SM SO PM RS SS ST SR SK SI SE SZ SX SC SY TC TD TG TH TJ TK TM
TL TO TT TN TR TV TW TZ UG UA UM UY US UZ VA VC VE VG VI VN VU WF WS YE ZA ZM ZW XK`
    .trim()
    .split(/\s+/);

test('guard: a country alert lands at the hand-written centroid of its ISO code', () => {
  const collection = normalizeOutages(
    {
      country: alertsPayload([
        countryAlert('TL', 'Timor-Leste', 'bgp', 'critical', T.h5),
        countryAlert('BB', 'Barbados', 'bgp', 'critical', T.h2),
        countryAlert('NF', 'Norfolk Island', 'gtr', 'critical', T.h1),
      ]),
    },
    options,
  );
  // Longitude first (GeoJSON), east and west, north and south: a swapped pair
  // or a wrong table row cannot match all three.
  assert.deepEqual(byId(collection, 'TL').geometry, {
    type: 'Point',
    coordinates: [125.7, -8.8],
  });
  assert.deepEqual(byId(collection, 'BB').geometry, {
    type: 'Point',
    coordinates: [-59.55, 13.17],
  });
  assert.deepEqual(byId(collection, 'NF').geometry, {
    type: 'Point',
    coordinates: [167.95, -29.03],
  });
});

test('the fixture outages become one marker per country with hand-written values, worst and newest first', () => {
  const collection = normalizeOutages(
    { country: countryPayload(), regions: regionPayload() },
    options,
  );
  assertValidFeatureCollection(collection);
  assert.deepEqual(ids(collection), ['LV', 'NF', 'NG', 'TL', 'BB', 'CM', 'DK']);
  assert.deepEqual(collection.details, { unplaced: 2, regionsIncluded: true });
  // Opened 8 days ago and never closed: still going, started at the opening alert.
  assert.deepEqual(byId(collection, 'BB'), {
    type: 'Feature',
    id: 'BB',
    geometry: { type: 'Point', coordinates: [-59.55, 13.17] },
    properties: {
      code: 'BB',
      name: 'Barbados',
      scope: 'country',
      level: 'critical',
      ongoing: true,
      datasources: ['bgp'],
      regions: [],
      regionCount: 0,
      start: '2026-10-17T04:00:00.000Z',
      end: null,
      url: 'https://ioda.inetintel.cc.gatech.edu/country/BB',
      timestamp: '2026-10-17T04:00:00.000Z',
    },
  });
  // Out, back, out again: it started at the last run (07:00Z), not the first
  // alert. Two signals; the worse level wins; the earliest start wins; the
  // newest alert (10:00Z) is the timestamp. Two regions are listed by name.
  assert.deepEqual(byId(collection, 'TL').properties, {
    code: 'TL',
    name: 'Timor-Leste',
    scope: 'country',
    level: 'critical',
    ongoing: true,
    datasources: ['bgp', 'ping-slash24'],
    regions: ['Baucau', 'Dili'],
    regionCount: 2,
    start: '2026-10-25T07:00:00.000Z',
    end: null,
    url: 'https://ioda.inetintel.cc.gatech.edu/country/TL',
    timestamp: '2026-10-25T10:00:00.000Z',
  });
  // Critical, normal, critical again: the new run starts at 11:00Z.
  assert.deepEqual(
    [
      byId(collection, 'NF').properties.start,
      byId(collection, 'NF').properties.datasources,
    ],
    ['2026-10-25T11:00:00.000Z', ['gtr']],
  );
  // A warning-level drop is a warning.
  assert.deepEqual(
    [byId(collection, 'CM').properties.level, byId(collection, 'CM').geometry],
    ['warning', { type: 'Point', coordinates: [12.5, 6] }],
  );
  // Recovered inside the window: level normal, ended, from the run's first alert.
  assert.deepEqual(byId(collection, 'DK').properties, {
    code: 'DK',
    name: 'Denmark',
    scope: 'country',
    level: 'normal',
    ongoing: false,
    datasources: ['ping-slash24'],
    regions: [],
    regionCount: 0,
    start: '2026-10-25T08:30:00.000Z',
    end: '2026-10-25T09:00:00.000Z',
    url: 'https://ioda.inetintel.cc.gatech.edu/country/DK',
    timestamp: '2026-10-25T09:00:00.000Z',
  });
});

test('regions with no country-wide signal mark their country, named by the region', () => {
  const collection = normalizeOutages(
    { country: countryPayload(), regions: regionPayload() },
    options,
  );
  // Nigeria recovered as a whole, but Kano is down: the marker is a region
  // outage, going, from Kano's alert.
  assert.deepEqual(byId(collection, 'NG').properties, {
    code: 'NG',
    name: 'Nigeria',
    scope: 'region',
    level: 'critical',
    ongoing: true,
    datasources: ['bgp'],
    regions: ['Kano'],
    regionCount: 1,
    start: '2026-10-25T10:00:00.000Z',
    end: null,
    url: 'https://ioda.inetintel.cc.gatech.edu/country/NG',
    timestamp: '2026-10-25T10:00:00.000Z',
  });
  // Latvia has no country alert; its name comes from the region's country_name,
  // and the region that came back (Riga) is not listed.
  const latvia = byId(collection, 'LV');
  assert.deepEqual(
    [
      latvia.properties.name,
      latvia.properties.scope,
      latvia.properties.regions,
      latvia.properties.regionCount,
      latvia.geometry.coordinates,
    ],
    ['Latvia', 'region', ['Liepāja'], 1, [24.9, 56.9]],
  );
});

test('without a region response the country markers stand and the collection says so', () => {
  const collection = normalizeOutages(
    { country: countryPayload(), regions: null },
    options,
  );
  assertValidFeatureCollection(collection);
  assert.deepEqual(ids(collection), ['NF', 'TL', 'BB', 'CM', 'DK', 'NG']);
  assert.deepEqual(collection.details, { unplaced: 1, regionsIncluded: false });
  assert.deepEqual(byId(collection, 'TL').properties.regions, []);
  // Nigeria is just the recovered country again.
  assert.deepEqual(
    [
      byId(collection, 'NG').properties.level,
      byId(collection, 'NG').properties.ongoing,
      byId(collection, 'NG').properties.end,
    ],
    ['normal', false, '2026-10-24T16:15:00.000Z'],
  );
});

test('outages that ended before the 24-hour window and quiet countries are not drawn', () => {
  const collection = normalizeOutages({ country: countryPayload() }, options);
  // Ethiopia recovered 29 h ago; Venezuela only ever reported normal.
  assert.equal(byId(collection, 'ET'), undefined);
  assert.equal(byId(collection, 'VE'), undefined);
  // Recovered 23 h 59 min ago (epoch 1792843260, one minute inside the window) still counts;
  // one minute outside (1792843140) does not.
  for (const [recovered, expected] of [
    [1792843260, ['KW']],
    [1792843140, []],
  ]) {
    const edge = normalizeOutages(
      {
        country: alertsPayload([
          countryAlert('KW', 'Kuwait', 'bgp', 'critical', T.h30),
          countryAlert('KW', 'Kuwait', 'bgp', 'normal', recovered),
        ]),
      },
      options,
    );
    assert.deepEqual(ids(edge), expected);
  }
});

test('placeholder entities with no position are counted, not drawn', () => {
  const collection = normalizeOutages(
    { country: countryPayload(), regions: regionPayload() },
    options,
  );
  assert.equal(byId(collection, 'AP'), undefined);
  assert.equal(byId(collection, 'EU'), undefined);
  assert.equal(collection.details.unplaced, 2);
});

test('bad alerts are skipped and never hide the good ones', () => {
  const collection = normalizeOutages(
    {
      country: alertsPayload([
        ...BAD_COUNTRY_ALERTS,
        countryAlert('BB', 'Barbados', 'bgp', 'critical', T.h2),
      ]),
    },
    options,
  );
  assert.deepEqual(ids(collection), ['BB']);
  assertValidFeatureCollection(collection);
  // An alert whose time is 30 minutes ahead of the clock is tolerated.
  const skew = normalizeOutages(
    {
      country: alertsPayload([
        countryAlert('BB', 'Barbados', 'bgp', 'critical', NOW_MS / 1000 + 1800),
      ]),
    },
    options,
  );
  assert.equal(skew.features[0].properties.start, '2026-10-25T12:30:00.000Z');
});

test('alerts listed out of order are read oldest first', () => {
  const collection = normalizeOutages(
    {
      country: alertsPayload([
        countryAlert('BB', 'Barbados', 'bgp', 'normal', T.h2),
        countryAlert('BB', 'Barbados', 'bgp', 'critical', T.h5),
      ]),
    },
    options,
  );
  assert.deepEqual(
    [
      collection.features[0].properties.ongoing,
      collection.features[0].properties.start,
      collection.features[0].properties.end,
    ],
    [false, '2026-10-25T07:00:00.000Z', '2026-10-25T10:00:00.000Z'],
  );
});

test('a legitimately quiet world is an empty collection; broken answers throw', () => {
  const quiet = normalizeOutages(
    {
      country: alertsPayload([
        countryAlert('VE', 'Venezuela', 'bgp', 'normal', T.h10),
      ]),
    },
    options,
  );
  assert.deepEqual(quiet.features, []);
  assert.equal(quiet.type, 'FeatureCollection');
  for (const country of [
    null,
    'text',
    [],
    {},
    { data: {} },
    // Not one alert in 14 days: IODA is broken, not quiet.
    alertsPayload([]),
    // Only unusable rows.
    alertsPayload([...BAD_COUNTRY_ALERTS.slice(0, 5)]),
    { ...alertsPayload(COUNTRY_ALERTS), error: 'internal error' },
    alertsPayload(
      Array.from({ length: IODA_ALERT_LIMIT }, () =>
        countryAlert('BB', 'Barbados', 'bgp', 'critical', T.h2),
      ),
    ),
  ])
    assert.throws(
      () => normalizeOutages({ country }, options),
      invalid,
      JSON.stringify(country)?.slice(0, 60),
    );
  assert.throws(
    () =>
      normalizeOutages(
        { country: countryPayload(), regions: { data: 5 } },
        options,
      ),
    invalid,
  );
  assert.throws(() => normalizeOutages(undefined, options), invalid);
});

test('the IODA request URLs are fixed: country looks 14 days back, region does not', () => {
  assert.equal(
    iodaAlertsUrl('country', NOW_MS),
    'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=1792843200&until=1792929600&entityType=country&limit=5000&extendWindow=1209600',
  );
  assert.equal(
    iodaAlertsUrl('region', NOW_MS),
    'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=1792843200&until=1792929600&entityType=region&limit=5000',
  );
});

test('the centroid table covers every IODA country except its two placeholders', () => {
  assert.equal(IODA_COUNTRY_CODES.length, 253);
  const missing = IODA_COUNTRY_CODES.filter(
    (code) => !['AP', 'EU'].includes(code) && countryCentroid(code) === null,
  );
  assert.deepEqual(missing, []);
  assert.equal(countryCentroid('AP'), null);
  assert.equal(countryCentroid('EU'), null);
  assert.equal(Object.keys(COUNTRY_CENTROIDS).length, 251);
  // Nothing in the table that IODA does not list.
  assert.deepEqual(
    Object.keys(COUNTRY_CENTROIDS).filter(
      (code) => !IODA_COUNTRY_CODES.includes(code),
    ),
    [],
  );
});

test('every centroid is a real position, never 0,0, and spot checks hold', () => {
  for (const [code, [lon, lat]] of Object.entries(COUNTRY_CENTROIDS)) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180, code);
    assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90, code);
    assert.ok(lon !== 0 || lat !== 0, `${code} sits at 0,0`);
  }
  // Hand-checked against a map: hemisphere and rough place.
  const hemispheres = {
    US: [-1, 1],
    BR: [-1, -1],
    CN: [1, 1],
    AU: [1, -1],
    ZA: [1, -1],
    AR: [-1, -1],
    IN: [1, 1],
    GB: [-1, 1],
    NZ: [1, -1],
    RU: [1, 1],
  };
  for (const [code, [lonSign, latSign]] of Object.entries(hemispheres)) {
    const [lon, lat] = countryCentroid(code);
    assert.equal(Math.sign(lon), lonSign, `${code} longitude`);
    assert.equal(Math.sign(lat), latSign, `${code} latitude`);
  }
  assert.deepEqual(countryCentroid('de'), [10.4, 51.1]);
  assert.deepEqual(countryCentroid(' fr '), [2.5, 46.6]);
  assert.equal(countryCentroid('ZZ'), null);
  assert.equal(countryCentroid(''), null);
  assert.equal(countryCentroid(null), null);
  assert.equal(countryCentroid('__proto__'), null);
  assert.equal(countryCentroid('constructor'), null);
});

test('guard: facilities with a null latitude are skipped, never placed at 0,0', () => {
  const collection = normalizeFacilities(facilityPayload());
  // Facility 3 has latitude and longitude null, 5 only latitude null.
  assert.equal(byId(collection, '3'), undefined);
  assert.equal(byId(collection, '5'), undefined);
  assert.deepEqual(
    collection.features.filter(
      ({ geometry }) =>
        geometry.coordinates[0] === 0 && geometry.coordinates[1] === 0,
    ),
    [],
  );
  assert.deepEqual(ids(collection), ['1', '2', '4', '7', '9']);
});

test('every good facility becomes one point with hand-written values, in list order', () => {
  const collection = normalizeFacilities(facilityPayload());
  assertValidFeatureCollection(collection);
  assert.deepEqual(byId(collection, '1'), {
    type: 'Feature',
    id: '1',
    geometry: { type: 'Point', coordinates: [-77.459, 39.0164] },
    properties: {
      facility: 1,
      name: 'Example Interconnect DC1 - Ashburn',
      org: 'Example Colo Inc.',
      city: 'Ashburn',
      country: 'US',
      netCount: 523,
      ixCount: 9,
      // http upgraded to https.
      website: 'https://colo.example/',
      url: 'https://www.peeringdb.com/fac/1',
      timestamp: null,
    },
  });
  assert.deepEqual(byId(collection, '2').properties, {
    facility: 2,
    name: 'Sample Hosting SYD1',
    org: 'Sample Hosting Ltd',
    city: 'Sydney',
    country: 'AU',
    netCount: 44,
    ixCount: 2,
    website: 'https://hosting.example/path?x=1',
    url: 'https://www.peeringdb.com/fac/2',
    timestamp: null,
  });
  // Latitude 0 and longitude 0 are real coordinates when the other is not 0.
  assert.deepEqual(byId(collection, '4').geometry.coordinates, [25.5, 0]);
  assert.deepEqual(byId(collection, '7').geometry.coordinates, [0, 51.4779]);
  // An empty org or website is null; an ftp link is not passed on.
  assert.deepEqual(
    [
      byId(collection, '4').properties.org,
      byId(collection, '4').properties.website,
    ],
    [null, null],
  );
  assert.equal(byId(collection, '7').properties.website, null);
  // A country that is not two letters, a missing city, unusable counts and a
  // script URL all become null rather than being passed on.
  assert.deepEqual(
    [
      byId(collection, '9').properties.country,
      byId(collection, '9').properties.city,
      byId(collection, '9').properties.netCount,
      byId(collection, '9').properties.ixCount,
      byId(collection, '9').properties.website,
    ],
    [null, null, null, null, null],
  );
});

test('bad facility rows are each skipped for their own reason', () => {
  // Every bad row alone, with enough good rows around to pass the size floor.
  const filler = unplacedFacilities(MIN_FACILITIES_LISTED);
  for (const row of BAD_FACILITIES) {
    if (row?.name === 'Impostor') continue;
    const collection = normalizeFacilities({
      data: [GOOD_FACILITIES[0], row, ...filler],
    });
    assert.deepEqual(ids(collection), ['1'], JSON.stringify(row));
  }
  // The first row of a repeated id wins.
  const repeated = normalizeFacilities(facilityPayload());
  assert.equal(
    byId(repeated, '1').properties.name,
    'Example Interconnect DC1 - Ashburn',
  );
  assert.deepEqual(
    byId(repeated, '1').geometry.coordinates,
    [-77.459, 39.0164],
  );
  // A status field that is missing altogether is accepted.
  const noStatus = facilityRow(40);
  delete noStatus.status;
  assert.deepEqual(ids(normalizeFacilities({ data: [noStatus, ...filler] })), [
    '40',
  ]);
});

test('a PeeringDB answer that is short, empty of positions or not a list throws instead of becoming an empty map', () => {
  for (const payload of [
    null,
    'text',
    [],
    {},
    { data: 'rows' },
    { meta: { error: 'rate limited' }, data: [] },
    // Fewer rows than the floor.
    { data: GOOD_FACILITIES },
    // Enough rows, none with a position.
    { data: unplacedFacilities(MIN_FACILITIES_LISTED) },
  ])
    assert.throws(
      () => normalizeFacilities(payload),
      invalid,
      JSON.stringify(payload)?.slice(0, 60),
    );
  // The floor is an option for tests of a small list.
  assert.deepEqual(
    ids(normalizeFacilities({ data: GOOD_FACILITIES }, { minFacilities: 1 })),
    ['1', '2', '4', '7', '9'],
  );
});

test('region alert helper rows keep the IODA shape the normalizer reads', () => {
  const row = regionAlert(1, 'X', 'NG', 'Nigeria', 'bgp', 'critical', T.h1);
  assert.equal(row.entity.type, 'region');
  assert.equal(row.entity.attrs.country_code, 'NG');
});
