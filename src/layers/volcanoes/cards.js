/**
 * Style, legend and click-card model for Volcanoes. Pure — no Cesium types;
 * the shared feature layer (layers/common/featureLayer.js) turns the CSS
 * colors into graphics and the card into a world-overlay entry.
 * @module layers/volcanoes/cards
 */
import { formatDate, msg, t } from '../../i18n/index.js';
import { featureSources } from '../common/featureModel.js';

/** USGS aviation color codes (the standard green/yellow/orange/red scale). */
export const AVIATION_COLORS = Object.freeze({
  GREEN: '#43a047',
  YELLOW: '#fdd835',
  ORANGE: '#fb8c00',
  RED: '#e53935',
});

/**
 * Fill for a volcano that has no USGS color code: a continuing eruption
 * reported by the Smithsonian GVP. Purple stays clear of the aviation scale.
 */
export const ERUPTION_COLOR = '#8e24aa';

const COLOR_LABELS = Object.freeze({
  GREEN: msg('Green'),
  YELLOW: msg('Yellow'),
  ORANGE: msg('Orange'),
  RED: msg('Red'),
});

const LEVEL_LABELS = Object.freeze({
  NORMAL: msg('Normal'),
  ADVISORY: msg('Advisory'),
  WATCH: msg('Watch'),
  WARNING: msg('Warning'),
});

/** Point size by USGS alert level. */
const ALERT_SIZES = Object.freeze({ ADVISORY: 10, WATCH: 13, WARNING: 16 });

/** Legend order: most severe code first, eruption-only last. */
const LEGEND_ORDER = Object.freeze(['RED', 'ORANGE', 'YELLOW', 'GREEN']);

const SOURCE_NAMES = Object.freeze({
  gvp: msg('Smithsonian GVP'),
  usgs: msg('USGS'),
});

/** Subsource chips (English data; t() at display). */
export const VOLCANO_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'gvp', label: SOURCE_NAMES.gvp }),
  Object.freeze({ id: 'usgs', label: SOURCE_NAMES.usgs }),
]);

const MAX_SYNOPSIS_CARD = 220;

/** Aviation color name in the UI language, or null. */
export function colorLabel(code) {
  return COLOR_LABELS[code] ? t(COLOR_LABELS[code]) : null;
}

/** USGS alert level in the UI language, or null. */
export function levelLabel(level) {
  return LEVEL_LABELS[level] ? t(LEVEL_LABELS[level]) : null;
}

/**
 * Point style. The fill is the USGS aviation color code when the volcano has
 * one, else the eruption color; a white ring marks a continuing eruption.
 * Size follows the larger of the eruption's VEI (9-16 px) and the alert level
 * (Advisory 10, Watch 13, Warning 16).
 * @param {Object} feature - A Volcanoes feature.
 * @returns {{color: string, outlineColor: string, pixelSize: number, outlineWidth: number, fillAlpha: number}}
 */
export function volcanoStyle(feature) {
  const p = feature?.properties || {};
  const vei = Number.isFinite(p.vei) ? Math.min(Math.max(p.vei, 0), 5) : 1;
  const eruptionSize = p.eruption ? Math.round(9 + vei * 1.4) : 0;
  return {
    color: AVIATION_COLORS[p.colorCode] || ERUPTION_COLOR,
    outlineColor: p.eruption ? '#ffffff' : '#212121',
    outlineWidth: p.eruption ? 3 : 1,
    pixelSize: Math.max(9, eruptionSize, ALERT_SIZES[p.alertLevel] ?? 0),
    fillAlpha: 0.3,
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

function sourceLabel(feature) {
  return featureSources(feature)
    .map((id) => (SOURCE_NAMES[id] ? t(SOURCE_NAMES[id]) : id))
    .join(' · ');
}

/**
 * Build the click card for one volcano.
 * @param {Object} feature - A Volcanoes feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: ?string}}
 */
export function buildVolcanoCard(feature, nowMs) {
  const p = feature?.properties || {};
  const details = [];
  if (p.eruption)
    details.push(
      Number.isFinite(p.vei)
        ? t('Eruption ongoing · VEI {vei}', { vei: p.vei })
        : t('Eruption ongoing'),
    );
  const level = levelLabel(p.alertLevel);
  const color = colorLabel(p.colorCode);
  const alert = [
    level && t('Alert level: {level}', { level }),
    color && t('Aviation code: {color}', { color }),
  ].filter(Boolean);
  if (alert.length) details.push(alert.join(' · '));
  const where = [p.observatory, p.region].filter(Boolean).join(' · ');
  if (where) details.push(where);
  if (p.synopsis)
    details.push(
      p.synopsis.length > MAX_SYNOPSIS_CARD
        ? `${p.synopsis.slice(0, MAX_SYNOPSIS_CARD - 1).trimEnd()}…`
        : p.synopsis,
    );
  const startMs = Date.parse(p.eruptionStart);
  if (Number.isFinite(startMs))
    details.push(
      t('erupting since {date}', {
        date: formatDate(startMs, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
      }),
    );
  else if (Number.isInteger(p.eruptionStartYear))
    details.push(
      t('erupting since {year}', { year: String(p.eruptionStartYear) }),
    );
  // `timestamp` is the USGS notice time when there is a USGS alert.
  const updated = p.alertLevel ? p.timestamp : null;
  const age = updated ? formatAge(nowMs - Date.parse(updated)) : null;
  if (age) details.push(t('updated {age} ago', { age }));
  const source = sourceLabel(feature);
  details.push(
    p.url
      ? t('{source} ↗ · click card to open', { source })
      : t('via {source}', { source }),
  );
  return {
    title: p.name || t('Volcano'),
    details,
    accent: AVIATION_COLORS[p.colorCode] || ERUPTION_COLOR,
    link: p.url || null,
  };
}

/**
 * Legend rows for the volcanoes currently shown: aviation codes from red to
 * green, then continuing eruptions with no code.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function volcanoLegend(features) {
  const counts = new Map();
  for (const feature of features) {
    const code = AVIATION_COLORS[feature?.properties?.colorCode]
      ? feature.properties.colorCode
      : 'ERUPTION';
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return [...LEGEND_ORDER, 'ERUPTION']
    .filter((code) => counts.has(code))
    .map((code, index) => ({
      label:
        code === 'ERUPTION'
          ? t('Continuing eruption, no US alert level')
          : t('Aviation code: {color}', { color: colorLabel(code) }),
      color: code === 'ERUPTION' ? ERUPTION_COLOR : AVIATION_COLORS[code],
      count: counts.get(code),
      ...(index === 0
        ? {
            blurb: t(
              'Colour is the USGS aviation colour code for US volcanoes at advisory level or above, otherwise purple for an eruption the Smithsonian reports as continuing. A white ring marks a continuing eruption; size follows its explosivity (VEI) or the alert level.',
            ),
          }
        : {}),
    }));
}

/** Plain analyst record for one volcano (voice/analyst queries). */
export function volcanoAnalystRecord(feature, anchor) {
  const p = feature.properties || {};
  const timeMs = Date.parse(p.timestamp);
  return {
    id: feature.id,
    lat: anchor.lat,
    lon: anchor.lon,
    name: p.name ?? null,
    vnum: p.vnum ?? null,
    erupting: p.eruption === true,
    vei: p.vei ?? null,
    alertLevel: p.alertLevel ?? null,
    colorCode: p.colorCode ?? null,
    source: p.source ?? null,
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
  };
}
