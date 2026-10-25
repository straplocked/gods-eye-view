import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  NEWS_COLORS,
  NEWS_SUBSOURCES,
  buildNewsCard,
  formatTone,
  isConflict,
  newsLegend,
  newsRowInfo,
  newsStyle,
} from './cards.js';

const now = Date.parse('2026-10-25T09:00:00.000Z');
const place = (extra = {}) => ({
  id: 'gdelt:-1044367',
  properties: {
    layer: 'news-events',
    source: 'gdelt',
    name: "Kyiv, Kyyivs'ka Oblast', Ukraine",
    country: 'Ukraine',
    countryCode: 'UP',
    precision: 'city',
    articleCount: 4,
    tone: -8.1,
    conflict: true,
    conflictCount: 3,
    themes: ['Armed conflict', 'Military'],
    articles: [
      {
        url: null,
        source: 'city-news.example',
        title: null,
        tone: -7,
        date: '2026-10-25T08:30:00.000Z',
      },
      {
        url: 'https://wire.example/world/kyiv-strikes',
        source: 'wire.example',
        title: 'Overnight strikes hit Kyiv',
        tone: -8.1,
        date: '2026-10-25T08:15:00.000Z',
      },
      {
        url: 'https://other.example/a',
        source: 'other.example',
        title: 'T'.repeat(200),
        tone: 1,
        date: '2026-10-25T08:00:00.000Z',
      },
      {
        url: 'https://fourth.example/a',
        source: 'fourth.example',
        title: 'Fourth headline is not on the card',
        tone: 0,
        date: '2026-10-25T07:00:00.000Z',
      },
    ],
    timestamp: '2026-10-25T08:30:00.000Z',
    ...extra,
  },
});

test('style: red for conflict, blue otherwise, growing with the article count, white ring for a country mention', () => {
  const style = (extra) => newsStyle(place(extra));
  assert.deepEqual(style({ articleCount: 1 }), {
    color: '#ff5252',
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 5,
    clampToGround: false,
  });
  assert.equal(style({ conflict: false }).color, '#4fc3f7');
  assert.deepEqual(
    [1, 2, 4, 8, 16, 32, 64, 5000].map(
      (n) => style({ articleCount: n }).pixelSize,
    ),
    [5, 7, 8, 10, 11, 13, 14, 14],
  );
  assert.equal(style({ precision: 'country' }).outlineColor, '#ffffff');
  assert.equal(NEWS_COLORS.conflict, '#ff5252');
  // Missing data still draws something sensible.
  assert.equal(newsStyle({}).pixelSize, 5);
  assert.equal(isConflict({ conflict: 'yes' }), false);
});

test('the card: counts, tone, themes, three headlines, age, and the newest https article as the link', () => {
  const card = buildNewsCard(place(), now);
  assert.equal(card.title, "Kyiv, Kyyivs'ka Oblast', Ukraine");
  assert.equal(card.accent, '#ff5252');
  assert.equal(card.link, 'https://wire.example/world/kyiv-strikes');
  assert.deepEqual(card.details, [
    '4 articles · Average tone -8.1',
    '3 articles on conflict or unrest',
    'Themes: Armed conflict, Military',
    // No title: just the source. An over-long title is clipped.
    'city-news.example',
    'wire.example · Overnight strikes hit Kyiv',
    `other.example · ${'T'.repeat(89)}…`,
    'latest report 30m ago',
    'wire.example ↗ · click card to open',
  ]);
});

test('a quiet place: singular, positive tone, no conflict line, country note, no link when no article is https', () => {
  const card = buildNewsCard(
    place({
      articleCount: 1,
      conflict: false,
      conflictCount: 0,
      precision: 'country',
      tone: 3.4,
      themes: [],
      articles: [
        {
          url: null,
          source: 'a.example',
          title: 'Squad named',
          tone: 3.4,
          date: '2026-10-25T07:00:00.000Z',
        },
      ],
      timestamp: '2026-10-25T07:00:00.000Z',
    }),
    now,
  );
  assert.equal(card.accent, '#4fc3f7');
  assert.equal('link' in card, false);
  assert.deepEqual(card.details, [
    '1 article · Average tone +3.4',
    'a.example · Squad named',
    'Country mention: marker at the country centre',
    'latest report 2h ago',
  ]);
  assert.equal(formatTone(0), '0.0');
  assert.equal(formatTone(-2.34), '-2.3');
  // Missing fields do not throw.
  assert.equal(buildNewsCard({ properties: { name: 'X' } }, now).title, 'X');
});

test('legend: conflict places first, then other news, with the truncation note', () => {
  const features = [
    place(),
    place({ conflict: true }),
    place({ conflict: false }),
  ];
  const rows = newsLegend(features, {
    sources: [{ id: 'gdelt', count: 2000, truncated: true }],
  });
  assert.deepEqual(
    rows.map(({ label, color, count }) => [label, color, count]),
    [
      ['Conflict, unrest or terror reports', '#ff5252', 2],
      ['Other news', '#4fc3f7', 1],
    ],
  );
  assert.match(rows[0].blurb, /^Places named in the news articles GDELT read/);
  assert.match(
    rows[0].blurb,
    /Showing the 2,000 places with the most articles\.$/,
  );
  assert.equal(rows[1].blurb, undefined);
  assert.doesNotMatch(newsLegend(features, null)[0].blurb, /Showing/);
  assert.deepEqual(newsLegend([], null), []);
});

test('row readout: the age of the GDELT batch', () => {
  const metadata = {
    sources: [
      {
        id: 'gdelt',
        batch: '2026-10-25T08:45:00.000Z',
        records: 1234,
        locations: 321,
      },
    ],
  };
  assert.deepEqual(newsRowInfo(metadata, now), {
    text: 'GDELT batch from 15m ago',
    title: '1,234 articles read, 321 places found',
  });
  assert.equal(newsRowInfo({ sources: [{ id: 'gdelt' }] }, now), null);
  assert.equal(newsRowInfo(null, now), null);
  assert.equal(newsRowInfo(metadata, Date.parse('2026-10-25T08:00:00Z')), null);
});

test('the one feed has a name for the status but no toggle chip', () => {
  assert.deepEqual(
    NEWS_SUBSOURCES.map(({ id, label, chip }) => [id, label, chip]),
    [['gdelt', 'GDELT', false]],
  );
});

test('translated card and status text; the data (headlines, themes) stays as sent', () => {
  try {
    setLocale('es');
    const card = buildNewsCard(place(), now);
    assert.equal(card.details[0], '4 artículos · Tono medio -8,1');
    assert.equal(card.details[1], '3 artículos sobre conflicto o disturbios');
    assert.equal(card.details[2], 'Temas: Armed conflict, Military');
    assert.equal(card.details[4], 'wire.example · Overnight strikes hit Kyiv');
    assert.equal(card.details[6], 'último informe hace 30 min');
    assert.equal(
      translateFeedError('GDELT feed unavailable'),
      'Fuente GDELT no disponible',
    );
    setLocale('ru');
    assert.equal(
      buildNewsCard(place(), now).details[0],
      '4 статьи · Средняя тональность -8,1',
    );
    setLocale('zh-CN');
    assert.equal(
      buildNewsCard(place(), now).details[0],
      '4 篇文章 · 平均情感倾向 -8.1',
    );
  } finally {
    setLocale('en');
  }
});
