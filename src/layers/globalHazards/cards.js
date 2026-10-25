/**
 * Style, legend and click-card model for Global Hazards. Pure — no Cesium
 * types; the shared feature layer (layers/common/featureLayer.js) turns the
 * CSS colors into graphics and the card into a world-overlay entry.
 * @module layers/globalHazards/cards
 */
import { formatNumber, msg, t } from '../../i18n/index.js';

/** Fill color per hazard kind (records.js HAZARD_KINDS). */
export const HAZARD_COLORS = Object.freeze({
  earthquake: '#ffb74d',
  cyclone: '#4fc3f7',
  storm: '#81d4fa',
  flood: '#1e88e5',
  volcano: '#ff1744',
  drought: '#a1887f',
  wildfire: '#ff6d00',
  landslide: '#8d6e63',
  ice: '#e0f7fa',
  snow: '#ffffff',
  temperature: '#ce93d8',
  dust: '#d7ccc8',
  water: '#26a69a',
  manmade: '#9e9e9e',
  other: '#bdbdbd',
});

/** Outline color per GDACS alert level. */
export const ALERT_COLORS = Object.freeze({
  green: '#43a047',
  orange: '#fb8c00',
  red: '#e53935',
});

const HAZARD_LABELS = Object.freeze({
  earthquake: msg('Earthquake'),
  cyclone: msg('Tropical cyclone'),
  storm: msg('Severe storm'),
  flood: msg('Flood'),
  volcano: msg('Volcano'),
  drought: msg('Drought'),
  wildfire: msg('Wildfire'),
  landslide: msg('Landslide'),
  ice: msg('Sea and lake ice'),
  snow: msg('Heavy snow'),
  temperature: msg('Temperature extreme'),
  dust: msg('Dust and haze'),
  water: msg('Water colour'),
  manmade: msg('Human-made'),
  other: msg('Other hazard'),
});

const ALERT_LABELS = Object.freeze({
  green: msg('Green alert'),
  orange: msg('Orange alert'),
  red: msg('Red alert'),
});

/** Subsource names (English data; t() at display). */
export const GLOBAL_HAZARD_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'gdacs', label: msg('GDACS') }),
  Object.freeze({ id: 'eonet', label: msg('NASA EONET') }),
]);

/** Hazard kind in the UI language. */
export function hazardLabel(kind) {
  return t(HAZARD_LABELS[kind] || HAZARD_LABELS.other);
}

/** GDACS alert level in the UI language, or null. */
export function alertLabel(level) {
  return ALERT_LABELS[level] ? t(ALERT_LABELS[level]) : null;
}

/**
 * Point style: hazard fill, alert-level ring and size (red alerts read
 * first). EONET events carry no alert level and get a thin dark ring.
 * @param {Object} feature - A Global Hazards feature.
 * @returns {{color: string, outlineColor: string, pixelSize: number, outlineWidth: number, fillAlpha: number}}
 */
export function hazardStyle(feature) {
  const { hazard, alertlevel } = feature?.properties || {};
  const pixelSize = { red: 16, orange: 13, green: 10 }[alertlevel] ?? 9;
  return {
    color: HAZARD_COLORS[hazard] || HAZARD_COLORS.other,
    outlineColor: ALERT_COLORS[alertlevel] || '#212121',
    outlineWidth: alertlevel ? 3 : 1,
    pixelSize,
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

/**
 * Build the click card for one hazard.
 * @param {Object} feature - A Global Hazards feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: ?string}}
 */
export function buildHazardCard(feature, nowMs) {
  const p = feature?.properties || {};
  const kind = hazardLabel(p.hazard);
  const headline = [kind];
  const alert = alertLabel(p.alertlevel);
  if (alert) headline.push(alert);
  const details = [headline.join(' · ')];
  if (p.country) details.push(p.country);
  if (p.severity) details.push(p.severity);
  else if (Number.isFinite(p.magnitudeValue) && p.magnitudeUnit)
    details.push(`${formatNumber(p.magnitudeValue)} ${p.magnitudeUnit}`);
  const ages = [];
  const began = formatAge(nowMs - Date.parse(p.fromdate));
  if (p.fromdate && began) ages.push(t('began {age} ago', { age: began }));
  const updated = formatAge(nowMs - Date.parse(p.timestamp));
  if (p.timestamp && updated && p.timestamp !== p.fromdate)
    ages.push(t('updated {age} ago', { age: updated }));
  if (ages.length) details.push(ages.join(' · '));
  const sourceName =
    p.source === 'gdacs'
      ? t('GDACS')
      : p.source === 'eonet'
        ? t('NASA EONET')
        : p.source;
  details.push(
    p.url
      ? t('{source} ↗ · click card to open', { source: sourceName })
      : t('via {source}', { source: sourceName }),
  );
  return {
    title: p.name || kind,
    details,
    accent:
      ALERT_COLORS[p.alertlevel] ||
      HAZARD_COLORS[p.hazard] ||
      HAZARD_COLORS.other,
    link: p.url || null,
  };
}

/**
 * Legend rows for the hazards currently shown, most frequent first.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function hazardLegend(features) {
  const counts = new Map();
  for (const feature of features) {
    const kind = HAZARD_LABELS[feature?.properties?.hazard]
      ? feature.properties.hazard
      : 'other';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count], index) => ({
      label: hazardLabel(kind),
      color: HAZARD_COLORS[kind],
      count,
      ...(index === 0
        ? {
            blurb: t(
              'Colour shows the hazard; the ring and size show the GDACS alert level (green, orange, red). NASA EONET events have no alert level.',
            ),
          }
        : {}),
    }));
}

/** Plain analyst record for one hazard (voice/analyst queries). */
export function hazardAnalystRecord(feature, anchor) {
  const p = feature.properties || {};
  const timeMs = Date.parse(p.timestamp);
  return {
    id: feature.id,
    lat: anchor.lat,
    lon: anchor.lon,
    hazard: p.hazard ?? null,
    alertLevel: p.alertlevel ?? null,
    name: p.name ?? null,
    country: p.country ?? null,
    source: p.source ?? null,
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
  };
}
