import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AIRSPACE_SUBSOURCES,
  airspaceLegend,
  airspaceStyle,
  altitudeText,
  buildAirspaceCard,
  delayTypeLabel,
  formatDuration,
  tfrStatus,
  tfrTypeLabel,
} from './cards.js';

const now = Date.parse('2026-10-25T11:00:00.000Z');

const tfr = (extra = {}) => ({
  id: 'tfr:6/2117#1',
  properties: {
    layer: 'airspace',
    source: 'tfr',
    notam: '6/2117',
    type: 'HAZARDS',
    category: 'hazards',
    location: 'PAGOSA SPRINGS, COLORADO',
    regulation: '91.137(a)(2)',
    area: 'Hazard Area1',
    areaIndex: 1,
    areaCount: 1,
    lowerFt: 0,
    lowerRef: 'AGL',
    upperFt: 1000,
    upperRef: 'AGL',
    scheduled: false,
    effective: '2026-10-25T09:00:00.000Z',
    expire: '2026-11-01T01:00:00.000Z',
    text: '!FDC 6/2117 ZDV CO..AIRSPACE PAGOSA SPRINGS',
    link: 'https://tfr.faa.gov/tfr3/?page=detail_6_2117',
    timestamp: '2026-10-25T02:46:47.000Z',
    ...extra,
  },
});
const delay = (extra = {}, programs) => ({
  id: 'delays:JFK',
  properties: {
    layer: 'airspace',
    source: 'delays',
    airport: 'JFK',
    icao: 'KJFK',
    name: 'NEW YORK/JOHN F KENNEDY INTL',
    delayType: 'ground-stop',
    programCount: 2,
    programs: programs ?? [
      { type: 'ground-stop', reason: 'fog', endTime: '3:15 pm EDT' },
      {
        type: 'arrival-delay',
        reason: 'WEATHER',
        min: 31,
        max: 45,
        trend: 'increasing',
      },
    ],
    link: 'https://nasstatus.faa.gov/',
    timestamp: '2026-10-25T10:55:03.000Z',
    ...extra,
  },
});

test('TFR style: type color, fainter while only scheduled', () => {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.deepEqual(airspaceStyle(tfr()), {
      color: '#ffd600',
      fillAlpha: 0.22,
      lineWidth: 2,
    });
    assert.deepEqual(
      airspaceStyle(
        tfr({ category: 'vip', effective: '2026-10-26T00:00:00.000Z' }),
      ),
      { color: '#ff1744', fillAlpha: 0.08, lineWidth: 1 },
    );
    assert.equal(airspaceStyle(tfr({ category: 'security' })).color, '#ff9100');
    assert.equal(airspaceStyle(tfr({ category: 'airshow' })).color, '#40c4ff');
    assert.equal(airspaceStyle(tfr({ category: 'uas' })).color, '#b388ff');
    assert.equal(airspaceStyle(tfr({ category: 'space' })).color, '#00e5ff');
    assert.equal(airspaceStyle(tfr({ category: 'special' })).color, '#9e9e9e');
    for (const unknown of ['other', 'zzz', undefined, null, '__proto__'])
      assert.equal(airspaceStyle(tfr({ category: unknown })).color, '#cfd8dc');
    // An area style never asks for point-only options.
    assert.equal('clampToGround' in airspaceStyle(tfr()), false);
  } finally {
    Date.now = realNow;
  }
});

test('delay style: color and size by the most severe program, never clamped', () => {
  assert.deepEqual(airspaceStyle(delay()), {
    color: '#ff1744',
    outlineColor: '#000000',
    outlineWidth: 2,
    pixelSize: 13,
    clampToGround: false,
  });
  const style = (delayType) => airspaceStyle(delay({ delayType }));
  assert.deepEqual(
    [style('ground-delay').color, style('ground-delay').pixelSize],
    ['#ff9100', 12],
  );
  assert.deepEqual(
    [style('arrival-delay').color, style('arrival-delay').pixelSize],
    ['#ffd600', 11],
  );
  assert.equal(style('departure-delay').color, '#ffd600');
  assert.deepEqual(
    [style('closure').color, style('closure').pixelSize],
    ['#b388ff', 10],
  );
  assert.deepEqual(
    [style('mystery').color, style('mystery').pixelSize],
    ['#ffffff', 10],
  );
  assert.equal(airspaceStyle({}).color, '#cfd8dc');
});

test('a TFR is scheduled before its effective time and active after', () => {
  assert.equal(
    tfrStatus({ effective: '2026-10-25T11:00:00.001Z' }, now),
    'scheduled',
  );
  assert.equal(
    tfrStatus({ effective: '2026-10-25T11:00:00.000Z' }, now),
    'active',
  );
  assert.equal(tfrStatus({ effective: null }, now), 'active');
  assert.equal(tfrStatus(undefined, now), 'active');
});

test('TFR card: place, altitudes, validity, rule, notice text and the FAA link', () => {
  assert.deepEqual(buildAirspaceCard(tfr(), now), {
    title: 'TFR 6/2117 · Hazards',
    details: [
      'PAGOSA SPRINGS, COLORADO',
      'surface to 1,000 ft AGL',
      'In effect until Nov 1, 01:00 UTC',
      '14 CFR 91.137(a)(2)',
      '!FDC 6/2117 ZDV CO..AIRSPACE PAGOSA SPRINGS',
      'FAA TFR ↗ · click card to open',
    ],
    accent: '#ffd600',
    link: 'https://tfr.faa.gov/tfr3/?page=detail_6_2117',
  });
});

test('TFR card: several areas, scheduled start, daily schedule, flight levels, until further notice', () => {
  const scheduled = buildAirspaceCard(
    tfr({
      category: 'security',
      area: 'Area B',
      areaIndex: 2,
      areaCount: 3,
      lowerFt: 3500,
      lowerRef: 'FL',
      upperFt: 18000,
      upperRef: 'FL',
      effective: '2026-10-26T13:00:00.000Z',
      scheduled: true,
      regulation: '99.7',
      text: null,
    }),
    now,
  );
  assert.equal(scheduled.title, 'TFR 6/2117 · Security');
  assert.deepEqual(scheduled.details, [
    'PAGOSA SPRINGS, COLORADO',
    'Area B · 2 of 3',
    'FL035 to FL180',
    'Starts Oct 26, 13:00 UTC · ends Nov 1, 01:00 UTC',
    'Daily schedule applies: see the FAA notice',
    '14 CFR 99.7',
    'FAA TFR ↗ · click card to open',
  ]);
  const ufn = buildAirspaceCard(tfr({ expire: null }), now);
  assert.ok(ufn.details.includes('In effect until further notice'));
  const startsUfn = buildAirspaceCard(
    tfr({ expire: null, effective: '2026-10-27T00:00:00.000Z' }),
    now,
  );
  assert.ok(startsUfn.details.includes('Starts Oct 27, 00:00 UTC'));
  // Unknown times say nothing rather than guess.
  const unknown = buildAirspaceCard(
    tfr({ effective: null, expire: null }),
    now,
  );
  assert.equal(
    unknown.details.some((line) => /effect|Starts/.test(line)),
    false,
  );
});

test('TFR card: regulation line only for a CFR section; long text and missing fields are handled', () => {
  const uas = buildAirspaceCard(
    tfr({ category: 'uas', regulation: '44812', text: 'X'.repeat(500) }),
    now,
  );
  assert.equal(uas.title, 'TFR 6/2117 · UAS public gathering');
  assert.equal(
    uas.details.some((line) => line.startsWith('14 CFR')),
    false,
  );
  const clipped = uas.details.find((line) => line.startsWith('XXX'));
  assert.equal(clipped.length, 220);
  assert.ok(clipped.endsWith('…'));
  const bare = buildAirspaceCard(
    {
      id: 'tfr:6/1#1',
      properties: {
        notam: '6/1',
        category: 'zzz',
        link: 'javascript:alert(1)',
      },
    },
    now,
  );
  assert.equal(bare.title, 'TFR 6/1 · Other TFR');
  assert.deepEqual(bare.details, ['FAA TFR ↗ · click card to open']);
});

test('altitude text covers both limits, one, and none', () => {
  assert.equal(
    altitudeText({
      lowerFt: 1000,
      lowerRef: 'MSL',
      upperFt: 3500,
      upperRef: 'MSL',
    }),
    '1,000 ft MSL to 3,500 ft MSL',
  );
  assert.equal(
    altitudeText({
      lowerFt: 0,
      lowerRef: 'MSL',
      upperFt: 17999,
      upperRef: 'MSL',
    }),
    'surface to 17,999 ft MSL',
  );
  assert.equal(altitudeText({ upperFt: 18000, upperRef: 'FL' }), 'Up to FL180');
  assert.equal(
    altitudeText({ lowerFt: 5000, lowerRef: 'AGL' }),
    'Above 5,000 ft AGL',
  );
  assert.equal(altitudeText({ lowerFt: 0 }), null);
  assert.equal(altitudeText({}), null);
  assert.equal(altitudeText(undefined), null);
  assert.equal(
    altitudeText({ lowerFt: 100, upperFt: 200 }),
    '100 ft to 200 ft',
  );
});

test('durations are compact: minutes, whole hours, hours and minutes', () => {
  assert.equal(formatDuration(46), '46 min');
  assert.equal(formatDuration(60), '1 h');
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(184), '3 h 4 min');
  assert.equal(formatDuration(0), '0 min');
  for (const bad of [null, undefined, NaN, -5, 'x'])
    assert.equal(formatDuration(bad), null);
});

test('delay card: every program of the airport, most severe first, with age and link', () => {
  assert.deepEqual(buildAirspaceCard(delay(), now), {
    title: 'JFK · Ground stop',
    details: [
      'NEW YORK/JOHN F KENNEDY INTL',
      'Ground stop until 3:15 pm EDT · fog',
      'Arrival delay · 31 min to 45 min · Trend: increasing · WEATHER',
      'updated 4m ago',
      'FAA NAS Status ↗ · click card to open',
    ],
    accent: '#ff1744',
    link: 'https://nasstatus.faa.gov/',
  });
});

test('delay card: ground delay averages, departure delay, closures, long reasons and overflow', () => {
  const ground = buildAirspaceCard(
    delay({ delayType: 'ground-delay', name: undefined }, [
      { type: 'ground-delay', reason: 'thunderstorms', avg: 90, max: 184 },
    ]),
    now,
  );
  assert.equal(ground.title, 'JFK · Ground delay program');
  assert.deepEqual(ground.details.slice(0, 1), [
    'Ground delay program · average 1 h 30 min · maximum 3 h 4 min · thunderstorms',
  ]);
  const departure = buildAirspaceCard(
    delay({ delayType: 'departure-delay' }, [
      { type: 'departure-delay', min: 46, max: 60, trend: 'weird' },
      { type: 'arrival-delay', max: 20 },
    ]),
    now,
  );
  assert.equal(departure.title, 'JFK · Departure delay');
  // An unknown trend is left out; a lone maximum reads "Up to".
  assert.deepEqual(departure.details.slice(1, 3), [
    'Departure delay · 46 min to 1 h',
    'Arrival delay · Up to 20 min',
  ]);
  const closures = buildAirspaceCard(
    delay({ delayType: 'closure' }, [
      {
        type: 'closure',
        reason: 'R'.repeat(300),
        start: '2026-10-25T05:00:00.000Z',
        reopen: '2026-10-25T13:00:00.000Z',
      },
      { type: 'closure', reopen: '2026-10-26T13:00:00.000Z' },
      { type: 'closure' },
      { type: 'mystery' },
      { type: 'closure', reason: 'fifth' },
      { type: 'closure', reason: 'sixth' },
    ]),
    now,
  );
  const lines = closures.details;
  assert.ok(
    lines[1].startsWith('Closed Oct 25, 05:00 to Oct 25, 13:00 UTC · RRR'),
  );
  assert.equal(lines[1].split(' · ')[1].length, 140);
  assert.equal(lines[2], 'Closed until Oct 26, 13:00 UTC');
  assert.equal(lines[3], 'Airport closure');
  assert.equal(lines[4], 'mystery');
  // Four program lines, then a count of the rest.
  assert.equal(lines[5], '+2 more');
});

test('delay card: no name, no timestamp, no programs', () => {
  const bare = buildAirspaceCard(
    {
      id: 'delays:XYZ',
      properties: { airport: 'XYZ', delayType: 'mystery', timestamp: null },
    },
    now,
  );
  assert.equal(bare.title, 'XYZ · mystery');
  assert.equal(bare.accent, '#ffffff');
  assert.deepEqual(bare.details, ['FAA NAS Status ↗ · click card to open']);
});

test('legend: TFR types then delay programs present, each with a count, worst delay first', () => {
  const features = [
    tfr(),
    tfr({ category: 'security' }),
    tfr({ category: 'security' }),
    tfr({ category: 'vip' }),
    delay({ delayType: 'closure' }),
    delay({ delayType: 'ground-stop' }),
    delay({ delayType: 'ground-stop' }),
    delay({ delayType: 'arrival-delay' }),
  ];
  const rows = airspaceLegend(features);
  assert.deepEqual(
    rows.map(({ label, color, count }) => [label, color, count]),
    [
      ['VIP movement', '#ff1744', 1],
      ['Security', '#ff9100', 2],
      ['Hazards', '#ffd600', 1],
      ['Ground stop', '#ff1744', 2],
      ['Arrival delay', '#ffd600', 1],
      ['Airport closure', '#b388ff', 1],
    ],
  );
  assert.match(rows[0].blurb, /Informational only: not for flight planning/);
  assert.equal(
    rows.slice(1).every((row) => row.blurb === undefined),
    true,
  );
  assert.deepEqual(airspaceLegend([]), []);
  assert.deepEqual(
    airspaceLegend([tfr({ category: 'zzz' })]).map(({ label }) => label),
    ['Other TFR'],
  );
});

test('subsource chips name the two feeds; labels and type names are English data translated at display', () => {
  assert.deepEqual(
    AIRSPACE_SUBSOURCES.map(({ id, label }) => [id, label]),
    [
      ['tfr', 'TFRs'],
      ['delays', 'Airport delays'],
    ],
  );
  assert.equal(tfrTypeLabel('airshow'), 'Air show or sports');
  assert.equal(tfrTypeLabel('nonsense'), 'Other TFR');
  assert.equal(delayTypeLabel('ground-delay'), 'Ground delay program');
  assert.equal(delayTypeLabel('mystery'), 'mystery');
});

test('cards, labels and the feed error read in Spanish, Russian and Chinese', () => {
  try {
    setLocale('es');
    assert.equal(buildAirspaceCard(tfr(), now).title, 'TFR 6/2117 · Peligros');
    assert.equal(
      buildAirspaceCard(tfr(), now).details[1],
      'de superficie a 1000 ft AGL',
    );
    assert.equal(
      buildAirspaceCard(delay(), now).details[1],
      'Parada en tierra hasta 3:15 pm EDT · fog',
    );
    assert.equal(delayTypeLabel('closure'), 'Cierre de aeropuerto');
    assert.equal(
      translateFeedError('Airspace HTTP 502'),
      'Espacio aéreo: HTTP 502',
    );
    setLocale('ru');
    assert.equal(tfrTypeLabel('vip'), 'Перемещение VIP');
    assert.equal(delayTypeLabel('ground-stop'), 'Остановка вылетов');
    setLocale('zh-CN');
    assert.equal(tfrTypeLabel('hazards'), '危险区');
    assert.equal(formatDuration(90), '1 小时 30 分钟');
  } finally {
    setLocale('en');
  }
});
