import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  FACILITY_COLOR,
  INTERNET_SUBSOURCES,
  OUTAGE_COLORS,
  buildInternetCard,
  countryName,
  datasourceLabel,
  internetLegend,
  internetStyle,
  isFacility,
  outageLevel,
} from './cards.js';

const now = Date.parse('2026-10-25T12:00:00.000Z');
const outage = (extra = {}) => ({
  id: 'outages:TL',
  properties: {
    layer: 'internet-infrastructure',
    source: 'outages',
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
    ...extra,
  },
});
const facility = (extra = {}) => ({
  id: 'datacenters:1',
  properties: {
    layer: 'internet-infrastructure',
    source: 'datacenters',
    facility: 1,
    name: 'Example Interconnect DC1 - Ashburn',
    org: 'Example Colo Inc.',
    city: 'Ashburn',
    country: 'US',
    netCount: 523,
    ixCount: 9,
    website: 'https://www.colo.example/',
    url: 'https://www.peeringdb.com/fac/1',
    timestamp: null,
    ...extra,
  },
});

test('outage style: color by level, big for a country-wide signal, white ring only while going, never clamped', () => {
  assert.deepEqual(internetStyle(outage()), {
    color: '#f44336',
    outlineColor: '#ffffff',
    outlineWidth: 2,
    pixelSize: 14,
    clampToGround: false,
  });
  assert.deepEqual(internetStyle(outage({ level: 'warning' })), {
    color: '#ff9800',
    outlineColor: '#ffffff',
    outlineWidth: 2,
    pixelSize: 13,
    clampToGround: false,
  });
  // Only regions are down: a little smaller.
  assert.equal(internetStyle(outage({ scope: 'region' })).pixelSize, 11);
  assert.equal(
    internetStyle(outage({ scope: 'region', level: 'warning' })).pixelSize,
    10,
  );
  // Recovered: green, small, dark ring.
  assert.deepEqual(internetStyle(outage({ level: 'normal', ongoing: false })), {
    color: '#66bb6a',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 9,
    clampToGround: false,
  });
  assert.deepEqual(Object.keys(OUTAGE_COLORS), [
    'critical',
    'warning',
    'normal',
  ]);
  // An unknown level reads as recovered rather than as an alarm.
  assert.equal(outageLevel({ level: 'severe' }), 'normal');
  assert.equal(outageLevel(undefined), 'normal');
});

test('facility style: cyan dots sized by the networks present, never clamped', () => {
  assert.deepEqual(internetStyle(facility()), {
    color: FACILITY_COLOR,
    outlineColor: '#00363d',
    outlineWidth: 1,
    pixelSize: 8,
    clampToGround: false,
  });
  const size = (netCount) => internetStyle(facility({ netCount })).pixelSize;
  assert.deepEqual(
    [null, 0, 9, 10, 49, 50, 149, 150, 4000].map(size),
    [4, 4, 4, 5, 5, 6, 6, 8, 8],
  );
  assert.equal(FACILITY_COLOR, '#26c6da');
  assert.equal(isFacility(facility().properties), true);
  assert.equal(isFacility(outage().properties), false);
  assert.equal(isFacility(undefined), false);
  assert.equal(internetStyle({}).color, '#66bb6a');
});

test('country card: status, regions, signals, ages, the placement note and the IODA link', () => {
  assert.deepEqual(buildInternetCard(outage(), now), {
    title: 'Timor-Leste',
    details: [
      'Critical drop in connectivity',
      'Regions: Baucau, Dili',
      'Detected by BGP routing · Active probing',
      'started 5h ago',
      'Marker at the country centre: IODA reports countries, not places',
      'Georgia Tech IODA ↗ · click card to open',
    ],
    accent: '#f44336',
    link: 'https://ioda.inetintel.cc.gatech.edu/country/TL',
  });
  const warning = buildInternetCard(
    outage({
      level: 'warning',
      regions: [],
      regionCount: 0,
      datasources: ['gtr'],
    }),
    now,
  );
  assert.deepEqual(warning.details.slice(0, 3), [
    'Warning-level drop in connectivity',
    'Detected by Google traffic',
    'started 5h ago',
  ]);
  assert.equal(warning.accent, '#ff9800');
});

test('region-scope card says the outage is inside the country; extra regions are counted', () => {
  const card = buildInternetCard(
    outage({
      code: 'NG',
      name: 'Nigeria',
      scope: 'region',
      datasources: ['bgp'],
      regions: ['Abia', 'Bauchi', 'Kano'],
      regionCount: 7,
      start: '2026-10-25T10:00:00.000Z',
    }),
    now,
  );
  assert.equal(card.title, 'Nigeria');
  assert.deepEqual(card.details.slice(0, 4), [
    'Connectivity dropped inside the country, not country-wide',
    'Regions: Abia, Bauchi, Kano +4',
    'Detected by BGP routing',
    'started 2h ago',
  ]);
});

test('recovered card shows when it started and ended', () => {
  const card = buildInternetCard(
    outage({
      code: 'DK',
      name: 'Denmark',
      level: 'normal',
      ongoing: false,
      datasources: ['ping-slash24'],
      regions: [],
      regionCount: 0,
      start: '2026-10-25T08:30:00.000Z',
      end: '2026-10-25T09:00:00.000Z',
    }),
    now,
  );
  assert.equal(card.title, 'Denmark');
  assert.deepEqual(card.details.slice(0, 4), [
    'Recovered: connectivity is back to normal',
    'Detected by Active probing',
    'started 3h ago',
    'ended 3h ago',
  ]);
  assert.equal(card.accent, '#66bb6a');
});

test('card ages: minutes, days, and none for a time that cannot be read', () => {
  const details = (extra) => buildInternetCard(outage(extra), now).details;
  assert.ok(
    details({ start: '2026-10-25T11:40:00.000Z' }).includes('started 20m ago'),
  );
  assert.ok(
    details({ start: '2026-10-17T04:00:00.000Z' }).includes('started 8d ago'),
  );
  assert.ok(
    details({ start: '2026-10-25T11:59:50.000Z' }).includes('started 1m ago'),
  );
  const unreadable = details({ start: 'soon', datasources: [], regions: [] });
  assert.equal(
    unreadable.some((line) => line.startsWith('started')),
    false,
  );
  assert.equal(
    unreadable.some((line) => line.startsWith('Detected')),
    false,
  );
  // A start in the future (clock skew) shows no age.
  assert.equal(
    details({ start: '2026-10-25T13:00:00.000Z' }).some((line) =>
      line.startsWith('started'),
    ),
    false,
  );
});

test('country names come from the UI language, then IODA, then the code', () => {
  assert.equal(countryName({ code: 'DK', name: 'Denmark' }), 'Denmark');
  assert.equal(countryName({ code: 'VN', name: 'Viet Nam' }), 'Vietnam');
  assert.equal(countryName({ code: 'XK', name: 'Kosovo' }), 'Kosovo');
  // A code the runtime cannot name falls back to what IODA sent.
  assert.equal(countryName({ code: 'Q1', name: 'Odd Place' }), 'Odd Place');
  assert.equal(countryName({ code: 'Q1' }), 'Q1');
  assert.equal(countryName(undefined), '');
});

test('signal names: known ones are named, an unknown one is shown as sent', () => {
  assert.deepEqual(
    ['bgp', 'ping-slash24', 'gtr', 'merit-nt', 'ucsd-nt', 'mozilla'].map(
      datasourceLabel,
    ),
    [
      'BGP routing',
      'Active probing',
      'Google traffic',
      'Network telescope',
      'Network telescope',
      'mozilla',
    ],
  );
  assert.equal(datasourceLabel('constructor'), 'constructor');
});

test('facility card: organization and place, counts, website host, PeeringDB link', () => {
  assert.deepEqual(buildInternetCard(facility(), now), {
    title: 'Example Interconnect DC1 - Ashburn',
    details: [
      'Example Colo Inc. · Ashburn, US',
      '523 networks · 9 exchanges',
      'colo.example',
      'PeeringDB ↗ · click card to open',
    ],
    accent: '#26c6da',
    link: 'https://www.peeringdb.com/fac/1',
  });
  // Singulars, missing pieces, and a website that is not a URL.
  const sparse = buildInternetCard(
    facility({
      org: null,
      city: null,
      country: 'AU',
      netCount: 1,
      ixCount: 1,
      website: 'not a url',
    }),
    now,
  );
  assert.deepEqual(sparse.details, [
    'AU',
    '1 network · 1 exchange',
    'PeeringDB ↗ · click card to open',
  ]);
  const bare = buildInternetCard(
    facility({
      org: null,
      city: null,
      country: null,
      netCount: null,
      ixCount: null,
      website: null,
    }),
    now,
  );
  assert.deepEqual(bare.details, ['PeeringDB ↗ · click card to open']);
  const zero = buildInternetCard(facility({ netCount: 0, ixCount: 0 }), now);
  assert.equal(zero.details[1], '0 networks · 0 exchanges');
});

test('legend: outage levels worst first, then data centers, one blurb on the first row', () => {
  const rows = internetLegend([
    outage(),
    outage({ level: 'warning' }),
    outage({ level: 'critical', scope: 'region' }),
    outage({ level: 'normal', ongoing: false }),
    facility(),
    facility({ netCount: 3 }),
  ]);
  assert.deepEqual(
    rows.map(({ label, color, count }) => [label, color, count]),
    [
      ['Critical outage', '#f44336', 2],
      ['Outage warning', '#ff9800', 1],
      ['Recovered in the last 24 h', '#66bb6a', 1],
      ['Data center or network facility', '#26c6da', 2],
    ],
  );
  assert.match(rows[0].blurb, /IODA signals can raise false alarms/);
  assert.equal(
    rows.slice(1).every((row) => !('blurb' in row)),
    true,
  );
  assert.deepEqual(internetLegend([]), []);
  const centers = internetLegend([facility()]);
  assert.deepEqual(
    centers.map(({ label }) => label),
    ['Data center or network facility'],
  );
  assert.ok(centers[0].blurb);
});

test('chips name the two feeds', () => {
  assert.deepEqual(
    INTERNET_SUBSOURCES.map(({ id, label }) => [id, label]),
    [
      ['outages', 'Outages'],
      ['datacenters', 'Data centers'],
    ],
  );
});

test('cards, signal names and feed status follow the UI language', () => {
  setLocale('es');
  try {
    const card = buildInternetCard(
      outage({
        code: 'DK',
        name: 'Denmark',
        level: 'normal',
        ongoing: false,
        datasources: ['bgp'],
        regions: [],
        regionCount: 0,
        start: '2026-10-25T08:30:00.000Z',
        end: '2026-10-25T09:00:00.000Z',
      }),
      now,
    );
    assert.equal(card.title, 'Dinamarca');
    assert.deepEqual(card.details, [
      'Recuperado: la conectividad volvió a la normalidad',
      'Detectado por Enrutamiento BGP',
      'comenzó hace 3 h',
      'terminó hace 3 h',
      'Marcador en el centro del país: IODA informa de países, no de lugares',
      'Georgia Tech IODA ↗ · haz clic en la tarjeta para abrir',
    ]);
    const center = buildInternetCard(facility(), now);
    assert.equal(center.details[1], '523 redes · 9 puntos de intercambio');
    assert.equal(
      translateFeedError('Outages feed unavailable'),
      'Fuente Cortes no disponible',
    );
  } finally {
    setLocale('en');
  }
});
