import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  FLOOD_CATEGORY_COLORS,
  NO_WIND_COLOR,
  WATER_SUBSOURCES,
  buildWaterCard,
  floodLabel,
  gaugeLevel,
  isGauge,
  waterLegend,
  waterStyle,
} from './cards.js';

const now = Date.parse('2026-10-25T11:00:00.000Z');
const buoy = (extra = {}) => ({
  id: 'buoys:41008',
  properties: {
    layer: 'water-observations',
    source: 'buoys',
    station: '41008',
    windDir: 30,
    windMs: 13,
    windKt: 25.3,
    gustMs: 16,
    gustKt: 31.1,
    waveM: 2.4,
    wavePeriodS: 7,
    avgPeriodS: 5.4,
    waveDir: 76,
    pressureHpa: 1023.2,
    pressureTrendHpa: -1.8,
    airC: 21,
    waterC: 22.4,
    dewC: 19.4,
    visNmi: 1.6,
    tideFt: 0.57,
    timestamp: '2026-10-25T10:50:00.000Z',
    ...extra,
  },
});
const gauge = (extra = {}) => ({
  id: 'rivers:ASTF1',
  properties: {
    layer: 'water-observations',
    source: 'rivers',
    gauge: 'ASTF1',
    name: 'St. Johns River at Astor',
    state: 'FL',
    category: 'moderate',
    forecastCategory: 'moderate',
    stageFt: 3.34,
    flowKcfs: null,
    forecastStageFt: 3.6,
    timestamp: '2026-10-25T10:30:00.000Z',
    ...extra,
  },
});

test('buoy style: wind classes at their thresholds, grey without wind, never clamped', () => {
  assert.deepEqual(waterStyle(buoy()), {
    color: '#1e88e5',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 6,
    clampToGround: false,
  });
  const color = (windKt) => waterStyle(buoy({ windKt })).color;
  assert.equal(color(0), '#b3e5fc');
  assert.equal(color(10.9), '#b3e5fc');
  assert.equal(color(11), '#4fc3f7');
  assert.equal(color(21.9), '#4fc3f7');
  assert.equal(color(22), '#1e88e5');
  assert.equal(color(33.9), '#1e88e5');
  assert.equal(color(34), '#5e35b1');
  assert.equal(color(47.9), '#5e35b1');
  assert.equal(color(48), '#ab47bc');
  assert.equal(color(80), '#ab47bc');
  for (const missing of [null, undefined, NaN])
    assert.equal(color(missing), NO_WIND_COLOR);
  assert.equal(waterStyle({}).color, '#9e9e9e');
});

test('buoy dots are bigger in higher seas', () => {
  const size = (waveM) => waterStyle(buoy({ waveM })).pixelSize;
  assert.deepEqual(
    [null, 0, 1.9, 2, 3.9, 4, 5.9, 6, 12].map(size),
    [5, 5, 5, 6, 6, 7, 7, 9, 9],
  );
});

test('gauge style: worse of observed and forecast, white ring only while flooding now', () => {
  assert.deepEqual(waterStyle(gauge()), {
    color: '#f44336',
    outlineColor: '#ffffff',
    outlineWidth: 2,
    pixelSize: 11,
    clampToGround: false,
  });
  // Forecast-only flooding: dark ring, colored by the forecast.
  assert.deepEqual(
    waterStyle(gauge({ category: null, forecastCategory: 'minor' })),
    {
      color: '#ff9800',
      outlineColor: '#000000',
      outlineWidth: 1,
      pixelSize: 10,
      clampToGround: false,
    },
  );
  // Action now but a major flood forecast: the forecast sets the color.
  const worse = waterStyle(
    gauge({ category: 'action', forecastCategory: 'major' }),
  );
  assert.deepEqual(
    [worse.color, worse.pixelSize, worse.outlineColor],
    ['#d500f9', 12, '#ffffff'],
  );
  assert.equal(
    waterStyle(gauge({ category: 'action', forecastCategory: null })).color,
    '#ffee58',
  );
  assert.deepEqual(Object.keys(FLOOD_CATEGORY_COLORS), [
    'action',
    'minor',
    'moderate',
    'major',
  ]);
});

test('gaugeLevel and isGauge tell the features apart', () => {
  assert.equal(gaugeLevel(gauge().properties), 'moderate');
  assert.equal(
    gaugeLevel({ category: 'minor', forecastCategory: 'action' }),
    'minor',
  );
  assert.equal(gaugeLevel({ category: null, forecastCategory: null }), null);
  assert.equal(gaugeLevel({ category: 'unknown' }), null);
  assert.equal(gaugeLevel(undefined), null);
  assert.equal(isGauge(gauge().properties), true);
  assert.equal(isGauge(buoy().properties), false);
  assert.equal(isGauge(undefined), false);
});

test('buoy card: wind, waves, pressure, temperatures, sea, age and the NDBC link', () => {
  assert.deepEqual(buildWaterCard(buoy(), now), {
    title: 'NDBC station 41008',
    details: [
      'Wind 030° at 25 kt, gusting 31 kt',
      'Waves 2.4 m · Wave period 7 s',
      'Pressure 1,023.2 hPa · Change -1.8 hPa in 3 h',
      'Temp 21°C · Water 22.4°C · Dew point 19.4°C',
      'Visibility 1.6 nmi · Tide 0.57 ft',
      'observed 10m ago',
      'NOAA NDBC ↗ · click card to open',
    ],
    accent: '#1e88e5',
    link: 'https://www.ndbc.noaa.gov/station_page.php?station=41008',
  });
});

test('buoy card: calm wind, no direction, no gust, steady pressure and missing fields', () => {
  const only = (extra) =>
    buildWaterCard(
      buoy({
        windDir: null,
        windMs: null,
        windKt: null,
        gustMs: null,
        gustKt: null,
        waveM: null,
        wavePeriodS: null,
        pressureHpa: null,
        pressureTrendHpa: null,
        airC: null,
        waterC: null,
        dewC: null,
        visNmi: null,
        tideFt: null,
        ...extra,
      }),
      now,
    );
  assert.deepEqual(only({}).details, [
    'observed 10m ago',
    'NOAA NDBC ↗ · click card to open',
  ]);
  assert.equal(only({}).accent, NO_WIND_COLOR);
  assert.equal(only({ windDir: 20, windKt: 0 }).details[0], 'Wind calm');
  assert.equal(
    only({ windKt: 12.4, gustKt: 18.6 }).details[0],
    'Wind 12 kt, gusting 19 kt',
  );
  assert.equal(only({ windKt: 12.4 }).details[0], 'Wind 12 kt');
  assert.equal(
    only({ windDir: 360, windKt: 12.4, gustKt: 12.4 }).details[0],
    'Wind 000° at 12 kt',
  );
  assert.equal(
    only({ pressureHpa: 1000, pressureTrendHpa: 0 }).details[0],
    'Pressure 1,000 hPa · Change 0 hPa in 3 h',
  );
  assert.equal(
    only({ pressureHpa: 998.4, pressureTrendHpa: 2.1 }).details[0],
    'Pressure 998.4 hPa · Change +2.1 hPa in 3 h',
  );
  assert.equal(only({ waterC: 4 }).details[0], 'Water 4°C');
  assert.equal(only({ waveM: 0.5 }).details[0], 'Waves 0.5 m');
  // An observation with no usable time shows no age.
  assert.equal(
    only({ timestamp: null }).details.includes('observed 10m ago'),
    false,
  );
  // Hours and days.
  assert.equal(
    only({ timestamp: '2026-10-25T08:00:00.000Z' }).details.at(-2),
    'observed 3h ago',
  );
});

test('gauge card: category, stage and flow, forecast, age and the NWPS link', () => {
  assert.deepEqual(buildWaterCard(gauge(), now), {
    title: 'St. Johns River at Astor',
    details: [
      'ASTF1 · FL',
      'Now: Moderate flooding',
      'Stage 3.34 ft',
      'Forecast: Moderate flooding · Stage 3.6 ft',
      'observed 30m ago',
      'NOAA NWPS ↗ · click card to open',
    ],
    accent: '#f44336',
    link: 'https://water.noaa.gov/gauges/astf1',
  });
  const action = buildWaterCard(
    gauge({
      gauge: 'ATKG1',
      name: 'Satilla River at Atkinson',
      state: 'GA',
      category: 'action',
      forecastCategory: null,
      stageFt: 12.89,
      flowKcfs: 5.24,
      forecastStageFt: null,
    }),
    now,
  );
  assert.deepEqual(action.details.slice(0, 3), [
    'ATKG1 · GA',
    'Now: Action stage',
    'Stage 12.89 ft · Flow 5.24 kcfs',
  ]);
  assert.equal(action.accent, '#ffee58');
});

test('gauge card: forecast-only flooding says the gauge is below action stage now', () => {
  const card = buildWaterCard(
    gauge({
      category: null,
      forecastCategory: 'minor',
      stageFt: 8.1,
      forecastStageFt: null,
      state: null,
    }),
    now,
  );
  assert.deepEqual(card.details.slice(0, 4), [
    'ASTF1',
    'Now: below action stage',
    'Stage 8.1 ft',
    'Forecast: Minor flooding',
  ]);
  assert.equal(card.accent, '#ff9800');
  assert.equal(floodLabel('major'), 'Major flooding');
  assert.equal(floodLabel('weird'), 'weird');
});

test('legend: gauges worst first, then wind classes strongest first, one blurb on the first row', () => {
  const rows = waterLegend([
    buoy(),
    buoy({ windKt: 2 }),
    buoy({ windKt: null }),
    gauge(),
    gauge({ category: null, forecastCategory: 'minor' }),
    gauge({ category: 'major', forecastCategory: null }),
    // A gauge with no flood level at all is not listed.
    gauge({ category: null, forecastCategory: null }),
  ]);
  assert.deepEqual(
    rows.map(({ label, color, count }) => [label, color, count]),
    [
      ['Major flooding', '#d500f9', 1],
      ['Moderate flooding', '#f44336', 1],
      ['Minor flooding', '#ff9800', 1],
      ['Wind 22–33 kt', '#1e88e5', 1],
      ['Wind under 11 kt', '#b3e5fc', 1],
      ['No wind reported', '#9e9e9e', 1],
    ],
  );
  assert.match(rows[0].blurb, /Informational only: not for navigation/);
  assert.equal(
    rows.slice(1).every((row) => !('blurb' in row)),
    true,
  );
  assert.deepEqual(waterLegend([]), []);
  const buoysOnly = waterLegend([buoy(), buoy({ windKt: 36 })]);
  assert.deepEqual(
    buoysOnly.map(({ label }) => label),
    ['Wind 34–47 kt (gale)', 'Wind 22–33 kt'],
  );
  assert.ok(buoysOnly[0].blurb);
});

test('chips name the two feeds', () => {
  assert.deepEqual(
    WATER_SUBSOURCES.map(({ id, label }) => [id, label]),
    [
      ['buoys', 'Buoys'],
      ['rivers', 'River gauges'],
    ],
  );
});

test('cards, flood names and feed status follow the UI language', () => {
  setLocale('es');
  try {
    assert.equal(floodLabel('moderate'), 'Inundación moderada');
    const card = buildWaterCard(buoy(), now);
    assert.equal(card.title, 'Estación NDBC 41008');
    assert.equal(card.details[0], 'Viento 030° a 25 kt, ráfagas de 31 kt');
    assert.equal(
      card.details.at(-1),
      'NOAA NDBC ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(
      buildWaterCard(gauge(), now).details[1],
      'Ahora: Inundación moderada',
    );
    assert.equal(
      translateFeedError('River gauges feed unavailable'),
      'Fuente Estaciones fluviales no disponible',
    );
  } finally {
    setLocale('en');
  }
});
