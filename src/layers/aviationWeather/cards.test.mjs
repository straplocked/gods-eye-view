import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AVIATION_SUBSOURCES,
  FLIGHT_CATEGORY_COLORS,
  UNKNOWN_CATEGORY_COLOR,
  advisoryBody,
  aviationLegend,
  aviationStyle,
  buildAviationCard,
  hazardLabel,
} from './cards.js';

const now = Date.parse('2026-10-25T11:00:00.000Z');
const metar = (category, extra = {}) => ({
  id: 'metar:KCAG',
  properties: {
    layer: 'aviation-weather',
    source: 'metar',
    station: 'KCAG',
    category,
    wdir: 210,
    wspd: 5,
    wgst: 15,
    vis: 2,
    ceiling: 600,
    temp: 1.7,
    dew: 1.7,
    altim: 30.21,
    wx: 'BR',
    raw: 'SPECI KCAG 251050Z AUTO 21005G15KT 2SM BR SCT002 BKN006 OVC100 02/02 A3021',
    timestamp: '2026-10-25T10:50:00.000Z',
    ...extra,
  },
});
const advisory = (extra = {}) => ({
  id: 'isigmet:sigmet-MMMD-1-TURB-202610251000',
  properties: {
    layer: 'aviation-weather',
    source: 'isigmet',
    advisory: 'sigmet',
    hazard: 'TURB',
    qualifier: 'SEV',
    fir: 'MMFR',
    firName: 'MMFO MAZATLAN OCEANICA',
    base: 25000,
    top: 38000,
    change: 'WKN',
    issuer: 'MMMD',
    series: '1',
    validFrom: '2026-10-25T10:00:00.000Z',
    validTo: '2026-10-25T14:00:00.000Z',
    raw: 'WSMX31 MMMD 251000\nMMID SIGMET 1 VALID 251000/251400 MMMX-\nMMFO MAZATLAN OCEANICA FIR SEV TURB FL250/380\nMOV NNW 04KT WKN.',
    timestamp: '2026-10-25T10:00:00.000Z',
    ...extra,
  },
});

test('METAR style: category colors, bigger dots for worse weather, grey when unknown, never clamped', () => {
  assert.deepEqual(aviationStyle(metar('VFR')), {
    color: '#2fbf5b',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 5,
    clampToGround: false,
  });
  assert.equal(aviationStyle(metar('MVFR')).color, '#3b8bff');
  assert.equal(aviationStyle(metar('IFR')).color, '#ff3b30');
  assert.equal(aviationStyle(metar('IFR')).pixelSize, 8);
  assert.equal(aviationStyle(metar('LIFR')).color, '#e040fb');
  assert.equal(aviationStyle(metar('LIFR')).pixelSize, 9);
  for (const unknown of [null, undefined, 'WINDY'])
    assert.equal(aviationStyle(metar(unknown)).color, '#9e9e9e');
  assert.equal(aviationStyle({}).color, UNKNOWN_CATEGORY_COLOR);
  assert.deepEqual(Object.keys(FLIGHT_CATEGORY_COLORS), [
    'VFR',
    'MVFR',
    'IFR',
    'LIFR',
  ]);
});

test('advisory style: hazard color, AIRMETs lighter than SIGMETs, unknown hazards white', () => {
  assert.deepEqual(aviationStyle(advisory()), {
    color: '#ffd600',
    fillAlpha: 0.22,
    lineWidth: 2,
  });
  assert.equal(aviationStyle(advisory({ hazard: 'ICE' })).color, '#40c4ff');
  assert.equal(
    aviationStyle(advisory({ hazard: 'CONVECTIVE' })).color,
    '#ff9100',
  );
  assert.equal(aviationStyle(advisory({ hazard: 'VA' })).color, '#a1887f');
  assert.equal(aviationStyle(advisory({ advisory: 'airmet' })).fillAlpha, 0.12);
  assert.equal(aviationStyle(advisory({ hazard: 'ZZ' })).color, '#ffffff');
  // An advisory style never asks for point-only options.
  assert.equal('clampToGround' in aviationStyle(advisory()), false);
});

test('METAR card: wind, sky, conditions, weather, age, raw text and the AWC link', () => {
  assert.deepEqual(buildAviationCard(metar('IFR'), now), {
    title: 'KCAG · IFR',
    details: [
      'Wind 210° at 5 kt, gusting 15 kt',
      'Visibility 2 mi · Ceiling 600 ft',
      'Temp 1.7°C · Dew point 1.7°C · Altimeter 30.21 inHg',
      'Weather: BR',
      'observed 10m ago',
      'SPECI KCAG 251050Z AUTO 21005G15KT 2SM BR SCT002 BKN006 OVC100 02/02 A3021',
      'NOAA AWC ↗ · click card to open',
    ],
    accent: '#ff3b30',
    link: 'https://aviationweather.gov/data/metar/?ids=KCAG',
  });
});

test('METAR card: calm wind, 10+ miles, no ceiling, unknown category, missing fields', () => {
  const calm = buildAviationCard(
    metar('VFR', {
      wdir: 0,
      wspd: 0,
      wgst: undefined,
      vis: 10,
      visPlus: true,
      ceiling: undefined,
      wx: undefined,
      temp: -4.4,
      dew: undefined,
      altim: undefined,
      raw: undefined,
    }),
    now,
  );
  assert.deepEqual(calm.details, [
    'Wind calm',
    'Visibility 10+ mi · No ceiling',
    'Temp -4.4°C',
    'observed 10m ago',
    'NOAA AWC ↗ · click card to open',
  ]);
  const bare = buildAviationCard(
    {
      id: 'metar:KJDN',
      properties: { station: 'KJDN', category: null, timestamp: null },
    },
    now,
  );
  assert.equal(bare.title, 'KJDN');
  assert.equal(bare.accent, '#9e9e9e');
  assert.deepEqual(bare.details, ['NOAA AWC ↗ · click card to open']);
  const variable = buildAviationCard(
    metar('VFR', { wdir: undefined, wspd: 7, wgst: undefined }),
    now,
  );
  assert.equal(variable.details[0], 'Wind variable at 7 kt');
  assert.match(
    buildAviationCard(metar('VFR', { wdir: 80, wgst: undefined }), now)
      .details[0],
    /^Wind 080° at 5 kt$/,
  );
  // A raw report is clipped on the card, not in the data.
  const long = buildAviationCard(metar('VFR', { raw: 'X'.repeat(500) }), now);
  const raw = long.details.find((line) => line.startsWith('XXX'));
  assert.equal(raw.length, 200);
  assert.ok(raw.endsWith('…'));
});

test('advisory card: hazard, qualifier, issuer, FIR, altitudes, validity, trend, body and link', () => {
  assert.deepEqual(buildAviationCard(advisory(), now), {
    title: 'Turbulence',
    details: [
      'Severe · SIGMET 1 MMMD',
      'MMFO MAZATLAN OCEANICA',
      'FL250 to FL380',
      'valid 10:00–14:00 UTC',
      'Trend: weakening',
      'MMID SIGMET 1 VALID 251000/251400 MMMX- MMFO MAZATLAN OCEANICA FIR SEV TURB FL250/380 MOV NNW 04KT WKN.',
      'NOAA AWC ↗ · click card to open',
    ],
    accent: '#ffd600',
    link: 'https://aviationweather.gov/sigmet/',
  });
});

test('advisory card: named hazards put the volcano or cyclone in the title; altitude variants', () => {
  const ash = buildAviationCard(
    advisory({
      hazard: 'VA',
      qualifier: 'FUEGO',
      base: 0,
      top: undefined,
      change: undefined,
      firName: undefined,
      raw: undefined,
    }),
    now,
  );
  assert.equal(ash.title, 'Volcanic ash · FUEGO');
  assert.deepEqual(ash.details, [
    'SIGMET 1 MMMD',
    'valid 10:00–14:00 UTC',
    'NOAA AWC ↗ · click card to open',
  ]);
  const text = (extra) =>
    buildAviationCard(advisory({ firName: undefined, ...extra }), now)
      .details[1];
  assert.equal(text({ base: 0, top: 25000 }), 'surface to FL250');
  assert.equal(text({ base: 5000, top: 12000 }), '5,000 ft to 12,000 ft');
  assert.equal(text({ base: undefined, top: 25000 }), 'Up to FL250');
  assert.equal(text({ base: 10000, top: undefined }), 'Above 10,000 ft');
  // A US AIRMET without a qualifier or FIR.
  const airmet = buildAviationCard(
    advisory({
      advisory: 'airmet',
      hazard: 'ICE',
      qualifier: undefined,
      firName: undefined,
      series: 'SFOZ',
      issuer: 'KKCI',
      validTo: '2026-10-25T15:00:00.000Z',
      validFrom: undefined,
      change: undefined,
      raw: 'WAUS46 KKCI 251045\nSFOZ WA 251045\nAIRMET ICE...CA\nMOD ICE BTN FRZLVL AND FL200.',
    }),
    now,
  );
  assert.equal(airmet.title, 'Icing');
  assert.equal(airmet.details[0], 'AIRMET SFOZ KKCI');
  assert.ok(airmet.details.includes('valid until 15:00 UTC'));
  assert.ok(
    airmet.details.includes(
      'SFOZ WA 251045 AIRMET ICE...CA MOD ICE BTN FRZLVL AND FL200.',
    ),
  );
  // An unknown hazard shows its code.
  assert.equal(buildAviationCard(advisory({ hazard: 'ZZ' }), now).title, 'ZZ');
});

test('advisoryBody drops the WMO header line only', () => {
  assert.equal(
    advisoryBody('WSUS33 KKCI 251055\nMKCW WST 251055\nCONVECTIVE SIGMET 15W'),
    'MKCW WST 251055 CONVECTIVE SIGMET 15W',
  );
  assert.equal(advisoryBody('SIGMET A1 VALID 1\nTS'), 'SIGMET A1 VALID 1 TS');
  assert.equal(advisoryBody(''), null);
  assert.equal(advisoryBody(undefined), null);
});

test('legend: categories worst first with counts, then hazards by count, one blurb', () => {
  const legend = aviationLegend([
    metar('VFR'),
    metar('VFR'),
    metar('VFR'),
    metar('LIFR'),
    metar('IFR'),
    metar('IFR'),
    metar(null),
    advisory(),
    advisory({ hazard: 'ICE' }),
    advisory({ hazard: 'ICE' }),
  ]);
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['LIFR: ceiling under 500 ft or visibility under 1 mi', '#e040fb', 1],
      ['IFR: ceiling 500–1,000 ft or visibility 1–3 mi', '#ff3b30', 2],
      ['VFR: ceiling over 3,000 ft and visibility over 5 mi', '#2fbf5b', 3],
      ['Flight category unknown (no visibility reported)', '#9e9e9e', 1],
      ['Icing', '#40c4ff', 2],
      ['Turbulence', '#ffd600', 1],
    ],
  );
  assert.ok(legend[0].blurb);
  assert.equal(legend.slice(1).filter((row) => row.blurb).length, 0);
  assert.deepEqual(aviationLegend([]), []);
});

test('chips name the three feeds', () => {
  assert.deepEqual(
    AVIATION_SUBSOURCES.map(({ id, label }) => [id, label]),
    [
      ['metar', 'METAR'],
      ['sigmet', 'US SIGMET'],
      ['isigmet', 'Intl SIGMET'],
    ],
  );
});

test('card, hazard names and feed status follow the UI language', () => {
  setLocale('es');
  try {
    assert.equal(hazardLabel('TURB'), 'Turbulencia');
    assert.equal(hazardLabel('ZZ'), 'ZZ');
    // Own keys only: prototype names are not hazards.
    assert.equal(hazardLabel('constructor'), 'constructor');
    const card = buildAviationCard(metar('IFR'), now);
    assert.equal(card.details[0], 'Viento 210° a 5 kt, ráfagas de 15 kt');
    assert.equal(
      card.details.at(-1),
      'NOAA AWC ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(
      buildAviationCard(advisory(), now).details[0],
      'Severa · SIGMET 1 MMMD',
    );
    assert.equal(
      translateFeedError('Intl SIGMET feed unavailable'),
      'Fuente SIGMET internacional no disponible',
    );
  } finally {
    setLocale('en');
  }
});
