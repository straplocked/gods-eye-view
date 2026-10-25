/**
 * Style, legend, row readout and click-card model for Geolocated News
 * (GDELT). Pure — no Cesium types; the shared feature layer
 * (layers/common/featureLayer.js) turns the CSS colors into graphics and the
 * card into a world-overlay entry. Headlines and theme names are GDELT data
 * and are shown as sent; only the surrounding text is translated.
 * @module layers/newsEvents/cards
 */
import { formatNumber, msg, t, tn } from '../../i18n/index.js';

/** Marker colors: places with conflict, unrest or terror themes, and everything else. */
export const NEWS_COLORS = Object.freeze({
  conflict: '#ff5252',
  news: '#4fc3f7',
});

/** The one feed, named in the "feed unavailable" status (no toggle chip). */
export const NEWS_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'gdelt', label: msg('GDELT'), chip: false }),
]);

/** Headlines shown on a card (the data keeps up to five). */
const CARD_HEADLINES = 3;
const HEADLINE_LENGTH = 90;

/** Whether a feature's place has conflict, unrest or terror reports. */
export const isConflict = (properties) => properties?.conflict === true;

/**
 * Point style: red for conflict, blue otherwise; the size grows with the
 * number of articles (5 px for one, 13 px for 32, at most 14 px); a white
 * ring marks a country-level mention drawn at the country centre.
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function newsStyle(feature) {
  const p = feature?.properties || {};
  const count = Number.isFinite(p.articleCount)
    ? Math.max(1, p.articleCount)
    : 1;
  return {
    color: isConflict(p) ? NEWS_COLORS.conflict : NEWS_COLORS.news,
    outlineColor: p.precision === 'country' ? '#ffffff' : '#000000',
    outlineWidth: 1,
    pixelSize: Math.min(14, 5 + Math.round(Math.log2(count) * 1.5)),
    clampToGround: false,
  };
}

/** Compact age, "5m" / "3h" / "2d", in the UI language. */
function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

/** A tone as "-2.3" / "+1.4" / "0.0" in the UI language. */
export function formatTone(tone) {
  return formatNumber(tone, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
}

const clip = (text, limit) =>
  [...text].length > limit
    ? `${[...text].slice(0, limit - 1).join('')}…`
    : text;

/** "Source · Headline" for one article, or just the source without a title. */
function headline(article) {
  const title = article?.title ? clip(article.title, HEADLINE_LENGTH) : null;
  return title ? `${article.source} · ${title}` : String(article?.source ?? '');
}

/**
 * Click card for one place. The click-through opens the most recent article
 * with an https link; a place whose articles have none is not clickable.
 * @param {Object} feature - A Geolocated News feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link?: string}}
 */
export function buildNewsCard(feature, nowMs) {
  const p = feature?.properties || {};
  const articles = Array.isArray(p.articles) ? p.articles : [];
  const count = Number.isFinite(p.articleCount)
    ? p.articleCount
    : articles.length;
  const counts = [
    tn(count, '{count} article', '{count} articles'),
    Number.isFinite(p.tone) &&
      t('Average tone {tone}', { tone: formatTone(p.tone) }),
  ].filter(Boolean);
  const details = [counts.join(' · ')];
  if (isConflict(p) && Number.isFinite(p.conflictCount))
    details.push(
      tn(
        p.conflictCount,
        '{count} article on conflict or unrest',
        '{count} articles on conflict or unrest',
      ),
    );
  if (Array.isArray(p.themes) && p.themes.length)
    details.push(t('Themes: {themes}', { themes: p.themes.join(', ') }));
  for (const article of articles.slice(0, CARD_HEADLINES))
    details.push(headline(article));
  if (p.precision === 'country')
    details.push(t('Country mention: marker at the country centre'));
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('latest report {age} ago', { age }));
  const linked = articles.find((article) => typeof article?.url === 'string');
  if (linked)
    details.push(
      t('{source} ↗ · click card to open', { source: linked.source }),
    );
  return {
    title: p.name,
    details,
    accent: isConflict(p) ? NEWS_COLORS.conflict : NEWS_COLORS.news,
    ...(linked ? { link: linked.url } : {}),
  };
}

/**
 * Legend rows for what is drawn: conflict places first, then other news,
 * each with its place count.
 * @param {Array<Object>} features
 * @param {?Object} metadata - Response `metadata` (for the truncation note).
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function newsLegend(features, metadata) {
  let conflict = 0;
  for (const feature of features)
    if (isConflict(feature?.properties)) conflict++;
  const other = features.length - conflict;
  const rows = [];
  if (conflict)
    rows.push({
      label: t('Conflict, unrest or terror reports'),
      color: NEWS_COLORS.conflict,
      count: conflict,
    });
  if (other)
    rows.push({
      label: t('Other news'),
      color: NEWS_COLORS.news,
      count: other,
    });
  if (rows.length) {
    const shown = metadata?.sources?.find((entry) => entry?.id === 'gdelt');
    rows[0].blurb = [
      t(
        'Places named in the news articles GDELT read in its latest 15-minute batch. A dot is where GDELT geocoded a place name, which is not always where the event happened; its size follows the number of articles. Red marks places where a quarter or more of the articles have conflict, unrest or terror themes. GDELT codes articles by machine, so places, tone and themes can be wrong, and headlines are third-party content.',
      ),
      shown?.truncated
        ? t('Showing the {count} places with the most articles.', {
            count: formatNumber(shown.count),
          })
        : null,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return rows;
}

/**
 * Panel row readout: how old the GDELT batch behind the map is (GDELT
 * publishes every 15 minutes, so a much older batch means it is lagging).
 * @param {?Object} metadata - Response `metadata`.
 * @param {number} nowMs
 * @returns {?{text: string, title: string}}
 */
export function newsRowInfo(metadata, nowMs) {
  const entry = metadata?.sources?.find((source) => source?.id === 'gdelt');
  const age = entry?.batch ? formatAge(nowMs - Date.parse(entry.batch)) : null;
  if (!age) return null;
  return {
    text: t('GDELT batch from {age} ago', { age }),
    title: t('{records} articles read, {places} places found', {
      records: formatNumber(entry.records ?? 0),
      places: formatNumber(entry.locations ?? 0),
    }),
  };
}
