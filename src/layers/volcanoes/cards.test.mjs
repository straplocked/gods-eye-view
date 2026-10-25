import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AVIATION_COLORS,
  ERUPTION_COLOR,
  buildVolcanoCard,
  volcanoAnalystRecord,
  volcanoLegend,
  volcanoStyle,
} from './cards.js';

const kilauea = {
  id: 'volcano:332010',
  properties: {
    source: 'gvp+usgs',
    name: 'Kilauea',
    vnum: 332010,
    eruption: true,
    vei: 1,
    eruptionStart: '2024-12-23T00:00:00.000Z',
    eruptionStartYear: 2024,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    observatory: 'HVO',
    region: 'Hawaii',
    synopsis: 'The eruption is paused; reinflation continues.',
    url: 'https://www.usgs.gov/volcanoes/kilauea',
    timestamp: '2026-10-24T18:15:36.000Z',
  },
};
const yasur = {
  id: 'volcano:257100',
  properties: {
    source: 'gvp',
    name: 'Yasur',
    vnum: 257100,
    eruption: true,
    vei: 3,
    eruptionStart: null,
    eruptionStartYear: 1270,
    alertLevel: null,
    colorCode: null,
    url: 'https://volcano.si.edu/volcano.cfm?vn=257100',
    timestamp: null,
  },
};
const shishaldin = {
  id: 'volcano:311360',
  properties: {
    source: 'usgs',
    name: 'Shishaldin',
    eruption: false,
    vei: null,
    alertLevel: 'WATCH',
    colorCode: 'ORANGE',
    observatory: 'AVO',
    region: 'Aleutians',
    url: null,
    timestamp: '2026-10-24T17:32:14.000Z',
  },
};
const now = Date.parse('2026-10-25T01:00:00.000Z');

test('style: aviation color when present, else eruption purple; ring and size', () => {
  assert.deepEqual(volcanoStyle(kilauea), {
    color: '#fdd835',
    outlineColor: '#ffffff',
    outlineWidth: 3,
    // VEI 1 -> round(9 + 1.4) = 10; ADVISORY is also 10.
    pixelSize: 10,
    fillAlpha: 0.3,
  });
  assert.deepEqual(volcanoStyle(yasur), {
    color: '#8e24aa',
    outlineColor: '#ffffff',
    outlineWidth: 3,
    // VEI 3 -> round(9 + 4.2) = 13.
    pixelSize: 13,
    fillAlpha: 0.3,
  });
  assert.deepEqual(volcanoStyle(shishaldin), {
    color: '#fb8c00',
    outlineColor: '#212121',
    outlineWidth: 1,
    pixelSize: 13,
    fillAlpha: 0.3,
  });
  // Unknown VEI reads as a small eruption; VEI past 5 is capped.
  assert.equal(
    volcanoStyle({ properties: { eruption: true, vei: null } }).pixelSize,
    10,
  );
  assert.equal(
    volcanoStyle({ properties: { eruption: true, vei: 7 } }).pixelSize,
    16,
  );
  assert.equal(volcanoStyle({}).color, ERUPTION_COLOR);
  assert.equal(volcanoStyle({}).pixelSize, 9);
  assert.deepEqual(Object.keys(AVIATION_COLORS), [
    'GREEN',
    'YELLOW',
    'ORANGE',
    'RED',
  ]);
});

test('merged card: eruption, alert, observatory, synopsis, start, age and link', () => {
  assert.deepEqual(buildVolcanoCard(kilauea, now), {
    title: 'Kilauea',
    details: [
      'Eruption ongoing · VEI 1',
      'Alert level: Advisory · Aviation code: Yellow',
      'HVO · Hawaii',
      'The eruption is paused; reinflation continues.',
      'erupting since Dec 23, 2024',
      'updated 6h ago',
      'Smithsonian GVP · USGS ↗ · click card to open',
    ],
    accent: '#fdd835',
    link: 'https://www.usgs.gov/volcanoes/kilauea',
  });
});

test('GVP-only card with a year-only start has no alert lines or age', () => {
  assert.deepEqual(buildVolcanoCard(yasur, now), {
    title: 'Yasur',
    details: [
      'Eruption ongoing · VEI 3',
      'erupting since 1270',
      'Smithsonian GVP ↗ · click card to open',
    ],
    accent: '#8e24aa',
    link: 'https://volcano.si.edu/volcano.cfm?vn=257100',
  });
});

test('USGS-only card without a link names its source and omits eruption lines', () => {
  const card = buildVolcanoCard(shishaldin, now);
  assert.deepEqual(card.details, [
    'Alert level: Watch · Aviation code: Orange',
    'AVO · Aleutians',
    'updated 7h ago',
    'via USGS',
  ]);
  assert.equal(card.link, null);
  assert.equal(card.accent, '#fb8c00');
});

test('card edge cases: unnamed volcano, unknown VEI, long synopsis', () => {
  const card = buildVolcanoCard(
    {
      id: 'volcano:1',
      properties: {
        source: 'gvp+usgs',
        eruption: true,
        vei: null,
        alertLevel: 'WARNING',
        colorCode: 'RED',
        synopsis: 'x'.repeat(400),
        timestamp: '2026-10-25T00:59:00.000Z',
      },
    },
    now,
  );
  assert.equal(card.title, 'Volcano');
  assert.equal(card.details[0], 'Eruption ongoing');
  assert.equal(card.details[1], 'Alert level: Warning · Aviation code: Red');
  const synopsis = card.details[2];
  assert.equal(synopsis.length, 220);
  assert.ok(synopsis.endsWith('…'));
  assert.ok(card.details.includes('updated 1m ago'));
  assert.equal(card.accent, '#e53935');
});

test('card and legend text follow the UI language', () => {
  setLocale('es');
  try {
    const card = buildVolcanoCard(kilauea, now);
    assert.equal(card.details[0], 'Erupción en curso · VEI 1');
    assert.equal(
      card.details[1],
      'Nivel de alerta: Aviso · Código de aviación: Amarillo',
    );
    assert.equal(
      card.details.at(-1),
      'GVP del Smithsonian · USGS ↗ · haz clic en la tarjeta para abrir',
    );
    assert.equal(
      volcanoLegend([kilauea])[0].label,
      'Código de aviación: Amarillo',
    );
    assert.equal(
      translateFeedError('USGS feed unavailable'),
      'Fuente USGS no disponible',
    );
  } finally {
    setLocale('en');
  }
});

test('legend lists the codes shown, severe first, then eruptions, with one blurb', () => {
  const legend = volcanoLegend([yasur, shishaldin, kilauea, yasur]);
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Aviation code: Orange', '#fb8c00', 1],
      ['Aviation code: Yellow', '#fdd835', 1],
      ['Continuing eruption, no US alert level', '#8e24aa', 2],
    ],
  );
  assert.ok(legend[0].blurb);
  assert.equal(legend[1].blurb, undefined);
  assert.deepEqual(volcanoLegend([]), []);
});

test('analyst records carry volcano facts at the card anchor', () => {
  assert.deepEqual(volcanoAnalystRecord(kilauea, { lat: 19.4, lon: -155.3 }), {
    id: 'volcano:332010',
    lat: 19.4,
    lon: -155.3,
    name: 'Kilauea',
    vnum: 332010,
    erupting: true,
    vei: 1,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    source: 'gvp+usgs',
    timeMs: Date.parse('2026-10-24T18:15:36.000Z'),
  });
  assert.equal(volcanoAnalystRecord(yasur, { lat: 0, lon: 0 }).timeMs, null);
});
