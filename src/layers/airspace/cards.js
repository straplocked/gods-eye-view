/**
 * Style, legend and click-card model for Airspace Restrictions & Airport
 * Delays. Pure — no Cesium types; the shared feature layer
 * (layers/common/featureLayer.js) turns the CSS colors into graphics and the
 * card into a world-overlay entry.
 * @module layers/airspace/cards
 */
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { DELAY_TYPES, TFR_CATEGORIES } from './records.js';

/** Subsource chips (English data; t() at display). */
export const AIRSPACE_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'tfr', label: msg('TFRs') }),
  Object.freeze({ id: 'delays', label: msg('Airport delays') }),
]);

/** TFR category: display name and color. */
const TFR_STYLES = Object.freeze({
  vip: Object.freeze({ name: msg('VIP movement'), color: '#ff1744' }),
  security: Object.freeze({ name: msg('Security'), color: '#ff9100' }),
  hazards: Object.freeze({ name: msg('Hazards'), color: '#ffd600' }),
  airshow: Object.freeze({ name: msg('Air show or sports'), color: '#40c4ff' }),
  uas: Object.freeze({ name: msg('UAS public gathering'), color: '#b388ff' }),
  space: Object.freeze({ name: msg('Space operations'), color: '#00e5ff' }),
  special: Object.freeze({ name: msg('Special notice'), color: '#9e9e9e' }),
  other: Object.freeze({ name: msg('Other TFR'), color: '#cfd8dc' }),
});

/** Delay program type: display name, color and dot size. */
const DELAY_STYLES = Object.freeze({
  'ground-stop': Object.freeze({
    name: msg('Ground stop'),
    color: '#ff1744',
    size: 13,
  }),
  'ground-delay': Object.freeze({
    name: msg('Ground delay program'),
    color: '#ff9100',
    size: 12,
  }),
  'arrival-delay': Object.freeze({
    name: msg('Arrival delay'),
    color: '#ffd600',
    size: 11,
  }),
  'departure-delay': Object.freeze({
    name: msg('Departure delay'),
    color: '#ffd600',
    size: 11,
  }),
  closure: Object.freeze({
    name: msg('Airport closure'),
    color: '#b388ff',
    size: 10,
  }),
});

const TRENDS = Object.freeze({
  increasing: () => t('increasing'),
  decreasing: () => t('decreasing'),
  steady: () => t('steady'),
});

const MAX_PROGRAM_LINES = 4;
const MAX_REASON_CARD = 140;
const MAX_TEXT_CARD = 220;

const isDelay = (properties) => typeof properties?.delayType === 'string';

const tfrStyleOf = (category) =>
  Object.hasOwn(TFR_STYLES, category) ? TFR_STYLES[category] : TFR_STYLES.other;

const delayStyleOf = (type) =>
  Object.hasOwn(DELAY_STYLES, type) ? DELAY_STYLES[type] : null;

/** TFR type name in the UI language. */
export function tfrTypeLabel(category) {
  return t(tfrStyleOf(category).name);
}

/** Delay program name in the UI language (the code itself when unknown). */
export function delayTypeLabel(type) {
  const style = delayStyleOf(type);
  return style ? t(style.name) : String(type);
}

/**
 * Where a TFR stands at `nowMs`: `scheduled` before its effective time,
 * `active` otherwise (a TFR whose times are unknown is drawn as active; the
 * proxy has already dropped the expired ones).
 * @param {Object} properties
 * @param {number} nowMs
 * @returns {'active'|'scheduled'}
 */
export function tfrStatus(properties, nowMs) {
  const effective = Date.parse(properties?.effective);
  return Number.isFinite(effective) && effective > nowMs
    ? 'scheduled'
    : 'active';
}

/**
 * Style for a TFR polygon or a delay dot.
 * TFRs: translucent type-colored fill and outline, fainter while only
 * scheduled. Delays: dots colored and sized by the most severe program, drawn
 * on the ellipsoid (there are a handful) so they stay above terrain.
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function airspaceStyle(feature) {
  const p = feature?.properties || {};
  if (isDelay(p)) {
    const style = delayStyleOf(p.delayType);
    return {
      color: style?.color ?? '#ffffff',
      outlineColor: '#000000',
      outlineWidth: 2,
      pixelSize: style?.size ?? 10,
      clampToGround: false,
    };
  }
  const scheduled = tfrStatus(p, Date.now()) === 'scheduled';
  return {
    color: tfrStyleOf(p.category).color,
    fillAlpha: scheduled ? 0.08 : 0.22,
    lineWidth: scheduled ? 1 : 2,
  };
}

const number = (value, maximumFractionDigits = 0) =>
  formatNumber(value, { maximumFractionDigits });

const clip = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

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

/** "Oct 25, 13:00" in UTC for an ISO timestamp, or null. */
function utcDateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? formatDate(ms, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
      })
    : null;
}

/** "46 min" / "2 h" / "1 h 30 min" for a number of minutes. */
export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return t('{minutes} min', { minutes: number(rest) });
  if (!rest) return t('{hours} h', { hours: number(hours) });
  return t('{hours} h {minutes} min', {
    hours: number(hours),
    minutes: number(rest),
  });
}

/** "FL180", "surface", "1,000 ft AGL" or "5,000 ft MSL" for one altitude limit. */
function levelText(feet, ref) {
  if (ref === 'FL')
    return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`;
  if (feet <= 0) return t('surface');
  if (ref === 'AGL') return t('{feet} ft AGL', { feet: number(feet) });
  if (ref === 'MSL') return t('{feet} ft MSL', { feet: number(feet) });
  return t('{feet} ft', { feet: number(feet) });
}

/** "surface to 1,000 ft AGL" / "Up to FL180" / "Above 5,000 ft MSL", or null. */
export function altitudeText(p) {
  const hasLower = Number.isFinite(p?.lowerFt);
  const hasUpper = Number.isFinite(p?.upperFt);
  if (hasLower && hasUpper)
    return t('{base} to {top}', {
      base: levelText(p.lowerFt, p.lowerRef),
      top: levelText(p.upperFt, p.upperRef),
    });
  if (hasUpper)
    return t('Up to {top}', { top: levelText(p.upperFt, p.upperRef) });
  if (hasLower && p.lowerFt > 0)
    return t('Above {base}', { base: levelText(p.lowerFt, p.lowerRef) });
  return null;
}

/** "In effect until Nov 1, 01:00 UTC" and friends, or null when the times are unknown. */
function validityText(p, nowMs) {
  const from = utcDateTime(p.effective);
  const to = utcDateTime(p.expire);
  if (tfrStatus(p, nowMs) === 'scheduled' && from)
    return to
      ? t('Starts {from} UTC · ends {to} UTC', { from, to })
      : t('Starts {from} UTC', { from });
  if (to) return t('In effect until {to} UTC', { to });
  // No expiry is "until further notice" only when the start is known too: a
  // TFR whose times could not be read says nothing rather than guess.
  return p.effective ? t('In effect until further notice') : null;
}

function buildTfrCard(feature, nowMs) {
  const p = feature.properties;
  const style = tfrStyleOf(p.category);
  const area =
    p.areaCount > 1
      ? t('{area} · {index} of {count}', {
          area: p.area || t('Area'),
          index: p.areaIndex,
          count: p.areaCount,
        })
      : null;
  const section = /^\d{2}\.\d/.test(p.regulation ?? '')
    ? t('14 CFR {section}', { section: p.regulation })
    : null;
  const details = [
    p.location,
    area,
    altitudeText(p),
    validityText(p, nowMs),
    p.scheduled && t('Daily schedule applies: see the FAA notice'),
    section,
    p.text && clip(p.text, MAX_TEXT_CARD),
    t('{source} ↗ · click card to open', { source: t('FAA TFR') }),
  ].filter(Boolean);
  return {
    title: t('TFR {notam} · {type}', {
      notam: p.notam,
      type: t(style.name),
    }),
    details,
    accent: style.color,
    link: p.link,
  };
}

/** One card line for a delay program. */
function programLine(program) {
  const label = delayTypeLabel(program.type);
  const parts = [];
  switch (program.type) {
    case 'ground-stop':
      parts.push(
        program.endTime
          ? t('Ground stop until {time}', { time: program.endTime })
          : label,
      );
      break;
    case 'ground-delay': {
      parts.push(label);
      const avg = formatDuration(program.avg);
      const max = formatDuration(program.max);
      if (avg) parts.push(t('average {delay}', { delay: avg }));
      if (max) parts.push(t('maximum {delay}', { delay: max }));
      break;
    }
    case 'arrival-delay':
    case 'departure-delay': {
      parts.push(label);
      const min = formatDuration(program.min);
      const max = formatDuration(program.max);
      if (min && max) parts.push(t('{base} to {top}', { base: min, top: max }));
      else if (max) parts.push(t('Up to {top}', { top: max }));
      if (Object.hasOwn(TRENDS, program.trend))
        parts.push(t('Trend: {trend}', { trend: TRENDS[program.trend]() }));
      break;
    }
    case 'closure': {
      const from = utcDateTime(program.start);
      const to = utcDateTime(program.reopen);
      parts.push(
        from && to
          ? t('Closed {from} to {to} UTC', { from, to })
          : to
            ? t('Closed until {to} UTC', { to })
            : label,
      );
      break;
    }
    default:
      parts.push(label);
  }
  if (program.reason) parts.push(clip(program.reason, MAX_REASON_CARD));
  return parts.join(' · ');
}

function buildDelayCard(feature, nowMs) {
  const p = feature.properties;
  const style = delayStyleOf(p.delayType);
  const programs = Array.isArray(p.programs) ? p.programs : [];
  const shown = programs.slice(0, MAX_PROGRAM_LINES).map(programLine);
  if (programs.length > MAX_PROGRAM_LINES)
    shown.push(
      t('+{count} more', { count: programs.length - MAX_PROGRAM_LINES }),
    );
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  const details = [
    p.name,
    ...shown,
    age && t('updated {age} ago', { age }),
    t('{source} ↗ · click card to open', { source: t('FAA NAS Status') }),
  ].filter(Boolean);
  return {
    title: t('{airport} · {type}', {
      airport: p.airport,
      type: delayTypeLabel(p.delayType),
    }),
    details,
    accent: style?.color ?? '#ffffff',
    link: p.link,
  };
}

/**
 * Click card for a TFR area or an airport with delays.
 * @param {Object} feature - An Airspace feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildAirspaceCard(feature, nowMs) {
  return isDelay(feature?.properties)
    ? buildDelayCard(feature, nowMs)
    : buildTfrCard(feature, nowMs);
}

/**
 * Legend rows for what is drawn: the TFR types present, then the delay
 * programs present (by the most severe program of each airport), each with
 * its count.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function airspaceLegend(features) {
  const tfrs = new Map();
  const delays = new Map();
  for (const feature of features) {
    const p = feature?.properties;
    if (isDelay(p)) delays.set(p.delayType, (delays.get(p.delayType) || 0) + 1);
    else {
      const key = Object.hasOwn(TFR_STYLES, p?.category) ? p.category : 'other';
      tfrs.set(key, (tfrs.get(key) || 0) + 1);
    }
  }
  const rows = [
    ...TFR_CATEGORIES.filter((key) => tfrs.has(key)).map((key) => ({
      label: tfrTypeLabel(key),
      color: TFR_STYLES[key].color,
      count: tfrs.get(key),
    })),
    ...DELAY_TYPES.filter((type) => delays.has(type)).map((type) => ({
      label: delayTypeLabel(type),
      color: DELAY_STYLES[type].color,
      count: delays.get(type),
    })),
  ];
  if (rows.length)
    rows[0].blurb = t(
      'Areas are current FAA Temporary Flight Restrictions, colored by type. Dots are airports with ground stops, delay programs or closures, colored by the most severe. Informational only: not for flight planning.',
    );
  return rows;
}
