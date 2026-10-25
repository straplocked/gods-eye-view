import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AURORA_BAND_STYLES,
  AURORA_PAGE_URL,
  auroraLegend,
  auroraStyle,
  buildAuroraCard,
  formatKp,
  kpSummaryText,
  spaceWeatherRowInfo,
} from './cards.js';
import { AURORA_BANDS } from './records.js';

const feature = (band, probability, extra = {}) => ({
  id: `aurora:north-${band}-1`,
  properties: {
    source: 'aurora',
    hemisphere: 'north',
    band,
    bandMax: AURORA_BANDS.find(({ min }) => min === band)?.max ?? null,
    probability,
    cells: 2,
    observationTime: '2026-10-25T08:38:00.000Z',
    forecastTime: '2026-10-25T09:55:00.000Z',
    timestamp: '2026-10-25T08:38:00.000Z',
    ...extra,
  },
});
const faint = feature(10, 14);
const medium = feature(20, 27);
const strong = feature(60, 70);
const now = Date.parse('2026-10-25T09:00:00.000Z');
const metadata = (kp = {}) => ({
  layer: 'space-weather',
  stale: false,
  partial: false,
  sources: [
    { id: 'aurora', ok: true, stale: false, count: 3 },
    {
      id: 'kp',
      ok: true,
      stale: false,
      count: 0,
      kp: 7.33,
      kpTime: '2026-10-25T06:00:00.000Z',
      gScale: 3,
      kpMax24h: 7.33,
      ...kp,
    },
  ],
});

test('style: a fill color and alpha per band, no outline', () => {
  assert.deepEqual(auroraStyle(faint), {
    color: '#00e676',
    fillAlpha: 0.22,
    outline: false,
  });
  assert.deepEqual(auroraStyle(medium), {
    color: '#76ff03',
    fillAlpha: 0.32,
    outline: false,
  });
  assert.deepEqual(auroraStyle(strong), {
    color: '#ff1744',
    fillAlpha: 0.48,
    outline: false,
  });
  // An unknown band reads as the faintest rather than failing.
  assert.equal(auroraStyle({ properties: { band: 33 } }).color, '#00e676');
  assert.equal(auroraStyle({}).color, '#00e676');
  assert.equal(AURORA_BAND_STYLES.length, AURORA_BANDS.length);
});

test('Kp is shown bare when whole and in thirds otherwise', () => {
  assert.equal(formatKp(2), '2');
  assert.equal(formatKp(0.33), '0.33');
  assert.equal(formatKp(7.33), '7.33');
  assert.equal(
    kpSummaryText({ kp: 7.33, gScale: 3 }),
    'Kp 7.33 · G3 strong geomagnetic storm',
  );
  assert.equal(
    kpSummaryText({ kp: 5, gScale: 1 }),
    'Kp 5 · G1 minor geomagnetic storm',
  );
  assert.equal(
    kpSummaryText({ kp: 9, gScale: 5 }),
    'Kp 9 · G5 extreme geomagnetic storm',
  );
  assert.equal(
    kpSummaryText({ kp: 2.33, gScale: 0 }),
    'Kp 2.33 · no geomagnetic storm',
  );
});

test('row readout: latest Kp and G-scale, interval and 24 hour peak in the tooltip', () => {
  assert.deepEqual(spaceWeatherRowInfo(metadata()), {
    text: 'Kp 7.33 · G3 strong geomagnetic storm',
    title:
      'Planetary K-index for the 3-hour interval starting 06:00 UTC; highest of the last 24 hours: 7.33',
  });
  assert.deepEqual(
    spaceWeatherRowInfo(metadata({ kp: 0.33, gScale: 0, kpMax24h: 2 })),
    {
      text: 'Kp 0.33 · no geomagnetic storm',
      title:
        'Planetary K-index for the 3-hour interval starting 06:00 UTC; highest of the last 24 hours: 2',
    },
  );
  // Without the interval time the tooltip falls back to a plain name.
  assert.equal(
    spaceWeatherRowInfo(metadata({ kpTime: undefined })).title,
    'Planetary K-index (NOAA SWPC)',
  );
  // No Kp reading, no readout.
  assert.equal(spaceWeatherRowInfo(null), null);
  assert.equal(
    spaceWeatherRowInfo({
      sources: [{ id: 'kp', ok: false, error: 'timeout' }],
    }),
    null,
  );
});

test('card: band title, peak, nowcast timing, Kp line and the SWPC link', () => {
  assert.deepEqual(buildAuroraCard(medium, now, metadata()), {
    title: 'Aurora chance 20–40%',
    details: [
      'Peak 27% in this area',
      'nowcast for 09:55 UTC · updated 22m ago',
      'Kp 7.33 · G3 strong geomagnetic storm',
      'NOAA SWPC ↗ · click card to open',
    ],
    accent: '#76ff03',
    link: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
  });
  assert.equal(AURORA_PAGE_URL, buildAuroraCard(medium, now, null).link);
});

test('card: the top band is open-ended; a card without Kp or times omits those lines', () => {
  const card = buildAuroraCard(strong, now, {
    sources: [{ id: 'kp', ok: false, error: 'timeout' }],
  });
  assert.equal(card.title, 'Aurora chance 60% or more');
  assert.equal(card.accent, '#ff1744');
  assert.deepEqual(card.details, [
    'Peak 70% in this area',
    'nowcast for 09:55 UTC · updated 22m ago',
    'NOAA SWPC ↗ · click card to open',
  ]);
  const bare = buildAuroraCard(
    { id: 'x', properties: { band: 40 } },
    now,
    null,
  );
  assert.equal(bare.title, 'Aurora chance 40–60%');
  assert.deepEqual(bare.details, ['NOAA SWPC ↗ · click card to open']);
});

test('legend lists the bands drawn, faintest first, with one blurb and no counts', () => {
  const legend = auroraLegend([strong, faint, medium, faint]);
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Aurora chance 10–20%', '#00e676', null],
      ['Aurora chance 20–40%', '#76ff03', null],
      ['Aurora chance 60% or more', '#ff1744', null],
    ],
  );
  assert.ok(legend[0].blurb);
  assert.equal(legend[1].blurb, undefined);
  assert.deepEqual(auroraLegend([]), []);
});

test('card, readout and feed status follow the UI language', () => {
  setLocale('es');
  try {
    assert.equal(
      spaceWeatherRowInfo(metadata()).text,
      'Kp 7,33 · G3: tormenta geomagnética fuerte',
    );
    const card = buildAuroraCard(medium, now, metadata());
    assert.equal(card.title, 'Probabilidad de aurora 20–40 %');
    assert.equal(card.details[0], 'Máximo de 27 % en esta zona');
    assert.equal(
      card.details.at(-1),
      'NOAA SWPC ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(
      translateFeedError('NOAA Kp index feed unavailable'),
      'Fuente Índice Kp de NOAA no disponible',
    );
  } finally {
    setLocale('en');
  }
});
