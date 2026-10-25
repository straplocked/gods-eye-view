import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AQI_COLORS,
  CITIZEN_SENSOR_SUBSOURCES,
  UNKNOWN_COLOR,
  aqiLabel,
  buildCitizenCard,
  citizenLegend,
  citizenStyle,
  isRadiation,
} from './cards.js';
import { AQI_CATEGORIES } from './records.js';

const now = Date.parse('2026-10-25T09:00:00.000Z');
const cell = (extra = {}) => ({
  id: 'airpm:1891_1385',
  properties: {
    layer: 'citizen-sensors',
    source: 'airpm',
    pm25: 28,
    pm10: 47.5,
    sensors: 4,
    aqi: 86,
    category: 'moderate',
    timestamp: '2026-10-25T08:55:00.000Z',
    ...extra,
  },
});
const reading = (extra = {}) => ({
  id: 'radiation:d65002',
  properties: {
    layer: 'citizen-sensors',
    source: 'radiation',
    device: 65002,
    unit: 'cpm',
    cpm: 50,
    usv: 0.15,
    usvEstimated: true,
    timestamp: '2026-10-25T08:58:00.000Z',
    ...extra,
  },
});

test('PM cell style: the EPA color of its category, bigger where more sensors agree', () => {
  assert.deepEqual(citizenStyle(cell()), {
    color: '#ffff00',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 7,
    clampToGround: false,
  });
  const colorOf = (category) => citizenStyle(cell({ category })).color;
  assert.equal(colorOf('good'), '#00e400');
  assert.equal(colorOf('moderate'), '#ffff00');
  assert.equal(colorOf('usg'), '#ff7e00');
  assert.equal(colorOf('unhealthy'), '#ff0000');
  assert.equal(colorOf('very-unhealthy'), '#8f3f97');
  assert.equal(colorOf('hazardous'), '#7e0023');
  assert.equal(colorOf('nonsense'), UNKNOWN_COLOR);
  assert.equal(colorOf(undefined), UNKNOWN_COLOR);
  assert.deepEqual(
    Object.keys(AQI_COLORS).sort(),
    [...AQI_CATEGORIES].sort(),
    'a color for every category the normalizer can serve',
  );
  const sizeOf = (sensors) => citizenStyle(cell({ sensors })).pixelSize;
  assert.deepEqual(
    [1, 2, 4, 5, 19, 20, 400].map(sizeOf),
    [6, 7, 7, 8, 8, 10, 10],
  );
  assert.equal(sizeOf(undefined), 6);
});

test('radiation style: dose-rate classes at their thresholds, a white ring, never clamped', () => {
  assert.deepEqual(citizenStyle(reading()), {
    color: '#26c6da',
    outlineColor: '#ffffff',
    outlineWidth: 2,
    pixelSize: 9,
    clampToGround: false,
  });
  const colorOf = (usv) => citizenStyle(reading({ usv })).color;
  assert.equal(colorOf(0.099), '#b2ebf2');
  assert.equal(colorOf(0.1), '#26c6da');
  assert.equal(colorOf(0.299), '#26c6da');
  assert.equal(colorOf(0.3), '#ffd54f');
  assert.equal(colorOf(0.999), '#ffd54f');
  assert.equal(colorOf(1), '#ff7043');
  assert.equal(colorOf(9.99), '#ff7043');
  assert.equal(colorOf(10), '#d500f9');
  assert.equal(colorOf(500), '#d500f9');
  assert.equal(colorOf(null), UNKNOWN_COLOR);
  assert.equal(isRadiation(reading().properties), true);
  assert.equal(isRadiation(cell().properties), false);
  assert.equal(isRadiation(undefined), false);
});

test('air card: category, PM2.5 and AQI, PM10, sensors, age and the Sensor.Community map', () => {
  const card = buildCitizenCard(cell(), now);
  assert.deepEqual(card, {
    title: 'Air quality: Moderate',
    details: [
      'PM2.5 28 µg/m³ · AQI 86',
      'PM10 47.5 µg/m³',
      '4 outdoor sensors in this 0.1° cell (median shown)',
      'observed 5m ago',
      'Community-built sensors: indicative, not calibrated.',
      'Sensor.Community ↗ · click card to open',
    ],
    accent: '#ffff00',
    link: 'https://maps.sensor.community/',
  });
});

test('air card: one sensor is singular, a missing PM10 and an old reading are handled', () => {
  const card = buildCitizenCard(
    cell({
      sensors: 1,
      pm10: null,
      category: 'usg',
      pm25: 40.2,
      aqi: 112,
      timestamp: '2026-10-24T05:00:00.000Z',
    }),
    now,
  );
  assert.equal(card.title, 'Air quality: Unhealthy for sensitive groups');
  assert.equal(card.accent, '#ff7e00');
  assert.deepEqual(card.details.slice(0, 3), [
    'PM2.5 40.2 µg/m³ · AQI 112',
    '1 outdoor sensor in this 0.1° cell (median shown)',
    'observed 1d ago',
  ]);
  assert.equal(
    card.details.some((line) => line.startsWith('PM10')),
    false,
  );
});

test('radiation card: an estimate says how it was estimated; a measured dose says so', () => {
  const estimated = buildCitizenCard(reading(), now);
  assert.deepEqual(estimated, {
    title: 'Radiation ≈ 0.15 µSv/h',
    details: [
      '50 counts per minute',
      'Dose rate estimated at 334 counts per minute per µSv/h; the real factor depends on the detector',
      'Safecast device 65002',
      'observed 2m ago',
      'Safecast ↗ · click card to open',
    ],
    accent: '#26c6da',
    link: 'https://map.safecast.org/',
  });
  const measured = buildCitizenCard(
    reading({
      device: null,
      unit: 'usv',
      cpm: null,
      usv: 0.095,
      usvEstimated: false,
    }),
    now,
  );
  assert.equal(measured.title, 'Radiation 0.095 µSv/h');
  assert.deepEqual(measured.details.slice(0, 2), [
    'Dose rate as reported by the device',
    'observed 2m ago',
  ]);
  assert.equal(measured.accent, '#b2ebf2');
});

test('every card link is a credential-free https URL', () => {
  for (const feature of [cell(), reading()]) {
    const url = new URL(buildCitizenCard(feature, now).link);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password, '');
  }
});

test('legend: air categories worst first, then radiation classes highest first, one blurb on the first row', () => {
  const rows = citizenLegend([
    cell(),
    cell({ category: 'good' }),
    cell({ category: 'good' }),
    cell({ category: 'hazardous' }),
    reading(),
    reading({ usv: 12 }),
    reading({ usv: 0.05 }),
    // A feature with no usable class is not listed.
    cell({ category: undefined }),
    reading({ usv: null }),
  ]);
  assert.deepEqual(
    rows.map(({ label, color, count }) => [label, color, count]),
    [
      ['Air quality: Hazardous', '#7e0023', 1],
      ['Air quality: Moderate', '#ffff00', 1],
      ['Air quality: Good', '#00e400', 2],
      ['Radiation 10 µSv/h or more', '#d500f9', 1],
      ['Radiation 0.10–0.29 µSv/h', '#26c6da', 1],
      ['Radiation under 0.10 µSv/h', '#b2ebf2', 1],
    ],
  );
  assert.match(rows[0].blurb, /Citizen-built sensors: informational only/);
  assert.equal(
    rows.slice(1).every((row) => !('blurb' in row)),
    true,
  );
  assert.deepEqual(citizenLegend([]), []);
  const radiationOnly = citizenLegend([reading()]);
  assert.equal(radiationOnly.length, 1);
  assert.ok(radiationOnly[0].blurb);
});

test('chips name the two feeds', () => {
  assert.deepEqual(
    CITIZEN_SENSOR_SUBSOURCES.map(({ id, label }) => [id, label]),
    [
      ['airpm', 'Particulate sensors'],
      ['radiation', 'Radiation sensors'],
    ],
  );
});

test('cards, category names and feed status follow the UI language', () => {
  setLocale('es');
  try {
    assert.equal(aqiLabel('usg'), 'No saludable para grupos sensibles');
    assert.equal(
      buildCitizenCard(cell(), now).title,
      'Calidad del aire: Moderada',
    );
    assert.equal(
      buildCitizenCard(reading(), now).details.at(-1),
      'Safecast ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(
      translateFeedError('Radiation sensors feed unavailable'),
      'Fuente Sensores de radiación no disponible',
    );
  } finally {
    setLocale('en');
  }
});
