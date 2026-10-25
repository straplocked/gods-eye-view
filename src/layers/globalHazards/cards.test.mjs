import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ALERT_COLORS,
  HAZARD_COLORS,
  buildHazardCard,
  hazardLegend,
  hazardStyle,
} from './cards.js';
import { HAZARD_KINDS } from './records.js';

const flood = {
  id: 'gdacs:FL-1104243',
  properties: {
    source: 'gdacs',
    hazard: 'flood',
    alertlevel: 'green',
    name: 'Flood in France',
    country: 'France',
    fromdate: '2026-10-19T01:00:00.000Z',
    severity: 'Magnitude 0',
    url: 'https://www.gdacs.org/report.aspx?eventid=1104243&episodeid=2&eventtype=FL',
    timestamp: '2026-10-22T01:00:00.000Z',
  },
};
const fire = {
  id: 'eonet:EONET_25590',
  properties: {
    source: 'eonet',
    hazard: 'wildfire',
    alertlevel: null,
    name: 'Wildfire BEE HAVEN',
    magnitudeValue: 2060,
    magnitudeUnit: 'acres',
    url: null,
    timestamp: '2026-10-22T21:45:00.000Z',
  },
};
const now = Date.parse('2026-10-25T01:00:00.000Z');

test('style: hazard fill, alert ring and size', () => {
  assert.deepEqual(hazardStyle(flood), {
    color: '#1e88e5',
    outlineColor: '#43a047',
    outlineWidth: 3,
    pixelSize: 10,
    fillAlpha: 0.3,
  });
  assert.equal(
    hazardStyle({ properties: { alertlevel: 'red' } }).pixelSize,
    16,
  );
  assert.equal(hazardStyle(fire).outlineWidth, 1);
  assert.equal(hazardStyle({}).color, '#bdbdbd');
  for (const kind of HAZARD_KINDS)
    assert.match(HAZARD_COLORS[kind], /^#[0-9a-f]{6}$/, kind);
  assert.deepEqual(Object.keys(ALERT_COLORS), ['green', 'orange', 'red']);
});

test('GDACS card: type, level, place, severity, times and report link', () => {
  assert.deepEqual(buildHazardCard(flood, now), {
    title: 'Flood in France',
    details: [
      'Flood · Green alert',
      'France',
      'Magnitude 0',
      'began 6d ago · updated 3d ago',
      'GDACS ↗ · click card to open',
    ],
    accent: '#43a047',
    link: flood.properties.url,
  });
});

test('EONET card without a link names its source', () => {
  assert.deepEqual(buildHazardCard(fire, now), {
    title: 'Wildfire BEE HAVEN',
    details: ['Wildfire', '2,060 acres', 'updated 2d ago', 'via NASA EONET'],
    accent: '#ff6d00',
    link: null,
  });
});

test('card and legend text follow the UI language', () => {
  setLocale('es');
  try {
    const card = buildHazardCard(flood, now);
    assert.equal(card.details[0], 'Inundación · Alerta verde');
    assert.equal(
      card.details.at(-1),
      'GDACS ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(hazardLegend([flood])[0].label, 'Inundación');
    assert.equal(
      translateFeedError('GDACS feed unavailable'),
      'Fuente GDACS no disponible',
    );
  } finally {
    setLocale('en');
  }
});

test('legend lists the hazards shown, most frequent first, with one blurb', () => {
  const legend = hazardLegend([fire, flood, fire]);
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Wildfire', '#ff6d00', 2],
      ['Flood', '#1e88e5', 1],
    ],
  );
  assert.ok(legend[0].blurb);
  assert.equal(legend[1].blurb, undefined);
});
