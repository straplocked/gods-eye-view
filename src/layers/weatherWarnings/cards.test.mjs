import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  SEVERITY_COLORS,
  TSUNAMI_COLORS,
  buildWarningCard,
  warningAnalystRecord,
  warningLegend,
  warningStyle,
} from './cards.js';
import { NWS_SEVERITIES, TSUNAMI_LEVELS } from './records.js';

const flood = {
  id: 'nws:urn:oid:flood',
  properties: {
    source: 'nws',
    event: 'Flash Flood Warning',
    severity: 'Severe',
    urgency: 'Immediate',
    areaDesc: 'Eddy, NM',
    senderName: 'NWS Midland/Odessa TX',
    onset: '2026-10-25T08:01:00.000Z',
    expires: '2026-10-25T09:30:00.000Z',
    url: 'https://www.weather.gov/',
    timestamp: '2026-10-25T08:01:00.000Z',
  },
};
const rip = {
  id: 'nws:urn:oid:rip',
  properties: {
    source: 'nws',
    event: 'Rip Current Statement',
    severity: 'Minor',
    urgency: 'Unknown',
    areaDesc: 'x'.repeat(200),
    onset: '2026-10-25T10:00:00.000Z',
    expires: '2026-10-25T08:00:00.000Z',
    url: null,
    timestamp: '2026-10-25T04:36:00.000Z',
  },
};
const tsunami = {
  id: 'tsunami:PAAQ-890504a1',
  properties: {
    source: 'tsunami',
    title: 'in the Bonin Islands, Japan region',
    level: 'information',
    center: 'PAAQ',
    magnitude: 7,
    magnitudeType: 'Mwp',
    url: 'https://www.tsunami.gov/events/PAAQ/WEAK53.txt',
    timestamp: '2026-10-25T02:26:53.000Z',
  },
};
const now = Date.parse('2026-10-25T09:00:00.000Z');

test('style: areas by severity, tsunami points by level', () => {
  assert.deepEqual(warningStyle(flood), {
    color: '#ff1744',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 9,
    fillAlpha: 0.4,
    lineWidth: 3,
  });
  assert.equal(warningStyle(rip).fillAlpha, 0.25);
  assert.equal(warningStyle(rip).lineWidth, 2);
  assert.equal(
    warningStyle({ properties: { source: 'nws' } }).color,
    '#90a4ae',
  );
  assert.deepEqual(warningStyle(tsunami), {
    color: '#4fc3f7',
    outlineColor: '#ffffff',
    outlineWidth: 2,
    pixelSize: 10,
    fillAlpha: 0.3,
  });
  assert.equal(
    warningStyle({ properties: { source: 'tsunami', level: 'warning' } })
      .pixelSize,
    18,
  );
  assert.deepEqual(Object.keys(SEVERITY_COLORS), [...NWS_SEVERITIES]);
  assert.deepEqual(Object.keys(TSUNAMI_COLORS), [...TSUNAMI_LEVELS]);
});

test('NWS card: severity, area, timing, sender and source link', () => {
  assert.deepEqual(buildWarningCard(flood, now), {
    title: 'Flash Flood Warning',
    details: [
      'Severe · Immediate',
      'Eddy, NM',
      'began 59m ago · expires in 30m',
      'NWS Midland/Odessa TX',
      'NWS ↗ · click card to open',
    ],
    accent: '#ff1744',
    link: 'https://www.weather.gov/',
  });
});

test('NWS card without a link: long areas truncate, future onset and past expiry read right', () => {
  const card = buildWarningCard(rip, now);
  assert.equal(card.details[0], 'Minor');
  assert.equal(card.details[1].length, 118);
  assert.ok(card.details[1].endsWith('…'));
  assert.equal(card.details[2], 'starts in 1h · expired');
  assert.equal(card.details.at(-1), 'via NWS');
  assert.equal(card.link, null);
});

test('tsunami card: level, magnitude, age, warning center and bulletin link', () => {
  assert.deepEqual(buildWarningCard(tsunami, now), {
    title: 'in the Bonin Islands, Japan region',
    details: [
      'Tsunami information · M 7.0 Mwp',
      'updated 6h ago',
      'National Tsunami Warning Center',
      'NOAA tsunami ↗ · click card to open',
    ],
    accent: '#4fc3f7',
    link: 'https://www.tsunami.gov/events/PAAQ/WEAK53.txt',
  });
});

test('card and legend text follow the UI language', () => {
  setLocale('es');
  try {
    const card = buildWarningCard(flood, now);
    assert.equal(card.details[0], 'Grave · Immediate');
    assert.equal(
      card.details.at(-1),
      'NWS ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(warningLegend([flood])[0].label, 'Grave');
    assert.equal(
      buildWarningCard(tsunami, now).details[0],
      'Información de tsunami · M 7,0 Mwp',
    );
    assert.equal(
      translateFeedError('NWS alerts feed unavailable'),
      'Fuente Alertas del NWS no disponible',
    );
  } finally {
    setLocale('en');
  }
});

test('legend lists severities most severe first, then tsunami levels, with one blurb', () => {
  const legend = warningLegend([
    rip,
    tsunami,
    flood,
    flood,
    { properties: { source: 'tsunami', level: 'warning' } },
  ]);
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Severe', '#ff1744', 2],
      ['Minor', '#ffd740', 1],
      ['Tsunami warning', '#ff1744', 1],
      ['Tsunami information', '#4fc3f7', 1],
    ],
  );
  assert.ok(legend[0].blurb);
  assert.equal(legend[1].blurb, undefined);
  assert.deepEqual(warningLegend([]), []);
});

test('analyst records carry the warning facts', () => {
  const anchor = { lat: 32.2, lon: -104.6 };
  assert.deepEqual(warningAnalystRecord(flood, anchor), {
    id: 'nws:urn:oid:flood',
    lat: 32.2,
    lon: -104.6,
    kind: 'weather',
    event: 'Flash Flood Warning',
    severity: 'Severe',
    area: 'Eddy, NM',
    timeMs: Date.parse('2026-10-25T08:01:00.000Z'),
  });
  assert.deepEqual(warningAnalystRecord(tsunami, anchor), {
    id: 'tsunami:PAAQ-890504a1',
    lat: 32.2,
    lon: -104.6,
    kind: 'tsunami',
    event: 'in the Bonin Islands, Japan region',
    severity: 'information',
    area: null,
    timeMs: Date.parse('2026-10-25T02:26:53.000Z'),
  });
});
