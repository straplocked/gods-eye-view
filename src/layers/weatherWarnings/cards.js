/**
 * Style, legend and click-card model for Weather & Tsunami Warnings. Pure —
 * no Cesium types; the shared feature layer (layers/common/featureLayer.js)
 * turns the CSS colors into graphics and the card into a world-overlay entry.
 * @module layers/weatherWarnings/cards
 */
import { formatNumber, msg, t } from '../../i18n/index.js';

/** Area color per NWS severity. */
export const SEVERITY_COLORS = Object.freeze({
  Extreme: '#d500f9',
  Severe: '#ff1744',
  Moderate: '#ff9100',
  Minor: '#ffd740',
  Unknown: '#90a4ae',
});

/** Point color per tsunami bulletin level. */
export const TSUNAMI_COLORS = Object.freeze({
  warning: '#ff1744',
  advisory: '#ff9100',
  watch: '#ffd740',
  information: '#4fc3f7',
});

const SEVERITY_LABELS = Object.freeze({
  Extreme: msg('Extreme'),
  Severe: msg('Severe'),
  Moderate: msg('Moderate'),
  Minor: msg('Minor'),
  Unknown: msg('Unknown severity'),
});

const TSUNAMI_LABELS = Object.freeze({
  warning: msg('Tsunami warning'),
  advisory: msg('Tsunami advisory'),
  watch: msg('Tsunami watch'),
  information: msg('Tsunami information'),
});

const CENTER_NAMES = Object.freeze({
  PAAQ: msg('National Tsunami Warning Center'),
  PHEB: msg('Pacific Tsunami Warning Center'),
});

/** Subsource names (English data; t() at display). */
export const WEATHER_WARNING_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'nws', label: msg('NWS alerts') }),
  Object.freeze({ id: 'tsunami', label: msg('NOAA tsunami') }),
]);

/** NWS severity in the UI language. */
export function severityLabel(severity) {
  return t(SEVERITY_LABELS[severity] || SEVERITY_LABELS.Unknown);
}

/** Tsunami bulletin level in the UI language. */
export function tsunamiLabel(level) {
  return t(TSUNAMI_LABELS[level] || TSUNAMI_LABELS.information);
}

const isTsunami = (feature) => feature?.properties?.source === 'tsunami';

/**
 * Style: NWS alerts are translucent areas colored by severity (the more
 * severe, the heavier the outline); tsunami bulletins are points colored by
 * level with a white ring so they read against the areas.
 * @param {Object} feature - A Weather & Tsunami Warnings feature.
 */
export function warningStyle(feature) {
  const p = feature?.properties || {};
  if (isTsunami(feature))
    return {
      color: TSUNAMI_COLORS[p.level] || TSUNAMI_COLORS.information,
      outlineColor: '#ffffff',
      outlineWidth: 2,
      pixelSize:
        { warning: 18, advisory: 15, watch: 13, information: 10 }[p.level] ??
        10,
      fillAlpha: 0.3,
    };
  const severity = SEVERITY_COLORS[p.severity] ? p.severity : 'Unknown';
  return {
    color: SEVERITY_COLORS[severity],
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: 9,
    fillAlpha: severity === 'Extreme' || severity === 'Severe' ? 0.4 : 0.25,
    lineWidth: { Extreme: 4, Severe: 3 }[severity] ?? 2,
  };
}

/** Compact span, "5m" / "3h" / "2d", in the UI language. */
function formatSpan(deltaMs) {
  const ms = Math.abs(deltaMs);
  if (!Number.isFinite(ms)) return null;
  const hours = Math.floor(ms / 3600000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(ms / 60000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

function nwsCard(feature, nowMs) {
  const p = feature.properties;
  const head = [severityLabel(p.severity)];
  if (p.urgency && p.urgency !== 'Unknown') head.push(p.urgency);
  const details = [head.join(' · ')];
  if (p.areaDesc)
    details.push(
      p.areaDesc.length > 120 ? `${p.areaDesc.slice(0, 117)}…` : p.areaDesc,
    );
  const times = [];
  const onsetMs = Date.parse(p.onset);
  if (p.onset && onsetMs > nowMs)
    times.push(t('starts in {age}', { age: formatSpan(onsetMs - nowMs) }));
  else if (p.onset && Number.isFinite(onsetMs) && nowMs - onsetMs >= 60000)
    times.push(t('began {age} ago', { age: formatSpan(nowMs - onsetMs) }));
  const expiresMs = Date.parse(p.expires);
  if (p.expires && Number.isFinite(expiresMs))
    times.push(
      expiresMs > nowMs
        ? t('expires in {age}', { age: formatSpan(expiresMs - nowMs) })
        : t('expired'),
    );
  if (times.length) details.push(times.join(' · '));
  if (p.senderName) details.push(p.senderName);
  details.push(
    p.url
      ? t('{source} ↗ · click card to open', { source: t('NWS') })
      : t('via {source}', { source: t('NWS') }),
  );
  return {
    title: p.event || t('Weather alert'),
    details,
    accent: SEVERITY_COLORS[p.severity] || SEVERITY_COLORS.Unknown,
    link: p.url || null,
  };
}

function tsunamiCard(feature, nowMs) {
  const p = feature.properties;
  const head = [tsunamiLabel(p.level)];
  if (Number.isFinite(p.magnitude))
    head.push(
      `M ${formatNumber(p.magnitude, { minimumFractionDigits: 1 })}${
        p.magnitudeType ? ` ${p.magnitudeType}` : ''
      }`,
    );
  const details = [head.join(' · ')];
  const updatedMs = Date.parse(p.timestamp);
  if (Number.isFinite(updatedMs) && nowMs >= updatedMs)
    details.push(
      t('updated {age} ago', { age: formatSpan(nowMs - updatedMs) }),
    );
  if (CENTER_NAMES[p.center]) details.push(t(CENTER_NAMES[p.center]));
  details.push(
    p.url
      ? t('{source} ↗ · click card to open', { source: t('NOAA tsunami') })
      : t('via {source}', { source: t('NOAA tsunami') }),
  );
  return {
    title: p.title || tsunamiLabel(p.level),
    details,
    accent: TSUNAMI_COLORS[p.level] || TSUNAMI_COLORS.information,
    link: p.url || null,
  };
}

/**
 * Build the click card for one NWS alert or tsunami bulletin.
 * @param {Object} feature - A layer feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: ?string}}
 */
export function buildWarningCard(feature, nowMs) {
  return isTsunami(feature)
    ? tsunamiCard(feature, nowMs)
    : nwsCard(feature, nowMs);
}

/**
 * Legend rows for what is shown: NWS severities (most severe first) and the
 * tsunami levels present.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function warningLegend(features) {
  const severities = new Map();
  const levels = new Map();
  for (const feature of features) {
    const p = feature?.properties || {};
    if (isTsunami(feature)) levels.set(p.level, (levels.get(p.level) || 0) + 1);
    else {
      const severity = SEVERITY_COLORS[p.severity] ? p.severity : 'Unknown';
      severities.set(severity, (severities.get(severity) || 0) + 1);
    }
  }
  const rows = [
    ...Object.keys(SEVERITY_COLORS)
      .filter((severity) => severities.has(severity))
      .map((severity) => ({
        label: severityLabel(severity),
        color: SEVERITY_COLORS[severity],
        count: severities.get(severity),
      })),
    ...Object.keys(TSUNAMI_COLORS)
      .filter((level) => levels.has(level))
      .map((level) => ({
        label: tsunamiLabel(level),
        color: TSUNAMI_COLORS[level],
        count: levels.get(level),
      })),
  ];
  if (rows.length)
    rows[0].blurb = t(
      'Areas are US National Weather Service alerts colored by severity; dots are NOAA tsunami bulletins colored by level. Alerts whose zone boundaries are still loading appear on a later refresh. Not for life-safety decisions.',
    );
  return rows;
}

/** Plain analyst record for one warning (voice/analyst queries). */
export function warningAnalystRecord(feature, anchor) {
  const p = feature.properties || {};
  const timeMs = Date.parse(p.timestamp);
  const tsunami = isTsunami(feature);
  return {
    id: feature.id,
    lat: anchor.lat,
    lon: anchor.lon,
    kind: tsunami ? 'tsunami' : 'weather',
    event: (tsunami ? p.title : p.event) ?? null,
    severity: (tsunami ? p.level : p.severity) ?? null,
    area: tsunami ? null : (p.areaDesc ?? null),
    timeMs: Number.isFinite(timeMs) ? timeMs : null,
  };
}
