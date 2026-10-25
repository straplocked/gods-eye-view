/**
 * Style, legend and click-card model for Aviation Weather. Pure — no Cesium
 * types; the shared feature layer (layers/common/featureLayer.js) turns the
 * CSS colors into graphics and the card into a world-overlay entry.
 * @module layers/aviationWeather/cards
 */
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { FLIGHT_CATEGORIES } from './records.js';

/**
 * Standard aviation chart colors for the flight categories: green VFR, blue
 * MVFR, red IFR, magenta LIFR. Grey marks a station that reports no visibility.
 */
export const FLIGHT_CATEGORY_COLORS = Object.freeze({
  VFR: '#2fbf5b',
  MVFR: '#3b8bff',
  IFR: '#ff3b30',
  LIFR: '#e040fb',
});

/** Fill for a station whose flight category is unknown. */
export const UNKNOWN_CATEGORY_COLOR = '#9e9e9e';

/** Point size by category: the weather that matters to a pilot stands out. */
const CATEGORY_SIZES = Object.freeze({ VFR: 5, MVFR: 6, IFR: 8, LIFR: 9 });

const CATEGORY_LABELS = Object.freeze({
  VFR: msg('VFR: ceiling over 3,000 ft and visibility over 5 mi'),
  MVFR: msg('MVFR: ceiling 1,000–3,000 ft or visibility 3–5 mi'),
  IFR: msg('IFR: ceiling 500–1,000 ft or visibility 1–3 mi'),
  LIFR: msg('LIFR: ceiling under 500 ft or visibility under 1 mi'),
});
const UNKNOWN_LABEL = msg('Flight category unknown (no visibility reported)');

/** Advisory hazard codes: display name and polygon color. */
const HAZARDS = Object.freeze({
  CONVECTIVE: Object.freeze({
    name: msg('Convective thunderstorms'),
    color: '#ff9100',
  }),
  TS: Object.freeze({ name: msg('Thunderstorms'), color: '#ff9100' }),
  TURB: Object.freeze({ name: msg('Turbulence'), color: '#ffd600' }),
  ICE: Object.freeze({ name: msg('Icing'), color: '#40c4ff' }),
  VA: Object.freeze({ name: msg('Volcanic ash'), color: '#a1887f' }),
  TC: Object.freeze({ name: msg('Tropical cyclone'), color: '#ff1744' }),
  MTW: Object.freeze({ name: msg('Mountain wave'), color: '#b388ff' }),
  IFR: Object.freeze({ name: msg('IFR conditions'), color: '#90a4ae' }),
  'MTN OBSCN': Object.freeze({
    name: msg('Mountain obscuration'),
    color: '#b0bec5',
  }),
  DS: Object.freeze({ name: msg('Duststorm'), color: '#d4a373' }),
  SS: Object.freeze({ name: msg('Sandstorm'), color: '#d4a373' }),
  RDOACT: Object.freeze({ name: msg('Radioactive cloud'), color: '#76ff03' }),
});
const OTHER_HAZARD_COLOR = '#ffffff';

/** Hazard codes whose qualifier is a name (the volcano or cyclone), not a degree. */
const NAMED_HAZARDS = new Set(['VA', 'TC']);

/**
 * Qualifier words as translators: "Severe" and "Moderate" take the `advisory`
 * context so the shared NWS wording ("Grave" in Spanish) does not leak into
 * "severe turbulence".
 */
const QUALIFIERS = Object.freeze({
  SEV: () => t('Severe', { context: 'advisory' }),
  MOD: () => t('Moderate', { context: 'advisory' }),
  EMBD: () => t('Embedded'),
  FRQ: () => t('Frequent'),
  OBSC: () => t('Obscured'),
  SQL: () => t('Squall line'),
  ISOL: () => t('Isolated'),
  HVY: () => t('Heavy'),
});

const TRENDS = Object.freeze({
  WKN: () => t('weakening'),
  NC: () => t('no change expected'),
  INTSF: () => t('intensifying'),
});

/** Subsource chips (English data; t() at display). */
export const AVIATION_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'metar', label: msg('METAR') }),
  Object.freeze({ id: 'sigmet', label: msg('US SIGMET') }),
  Object.freeze({ id: 'isigmet', label: msg('Intl SIGMET') }),
]);

const METAR_PAGE = 'https://aviationweather.gov/data/metar/?ids=';
const SIGMET_PAGE = 'https://aviationweather.gov/sigmet/';
const MAX_RAW_CARD = 200;

const isAdvisory = (properties) => typeof properties?.hazard === 'string';

/** Name and color of a known hazard code, else null (own keys only). */
const hazardInfo = (code) =>
  typeof code === 'string' && Object.hasOwn(HAZARDS, code)
    ? HAZARDS[code]
    : null;

/** The flight category of a METAR feature when it is one of the four, else null. */
export function categoryOf(feature) {
  const category = feature?.properties?.category;
  return FLIGHT_CATEGORIES.includes(category) ? category : null;
}

/** Hazard name in the UI language (the code itself for an unknown hazard). */
export function hazardLabel(code) {
  return hazardInfo(code) ? t(hazardInfo(code).name) : String(code);
}

/**
 * Style for a METAR point or an advisory polygon.
 * METARs: the flight category color, bigger for worse weather, drawn on the
 * ellipsoid (thousands of points). Advisories: translucent hazard-colored
 * fill and outline; an AIRMET is lighter than a SIGMET.
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function aviationStyle(feature) {
  const p = feature?.properties || {};
  if (isAdvisory(p)) {
    const color = hazardInfo(p.hazard)?.color ?? OTHER_HAZARD_COLOR;
    return {
      color,
      fillAlpha: p.advisory === 'airmet' ? 0.12 : 0.22,
      lineWidth: 2,
    };
  }
  const category = categoryOf(feature);
  return {
    color: category ? FLIGHT_CATEGORY_COLORS[category] : UNKNOWN_CATEGORY_COLOR,
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: category ? CATEGORY_SIZES[category] : 5,
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

/** UTC clock time of an ISO timestamp ("12:55"), or null. */
function utcClock(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? formatDate(ms, {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'UTC',
      })
    : null;
}

const number = (value, maximumFractionDigits = 1) =>
  formatNumber(value, { maximumFractionDigits });

const clip = (text, limit) =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** "Wind 280° at 8 kt, gusting 26 kt" / "Wind calm", or null when not reported. */
function windText(p) {
  if (!Number.isFinite(p.wspd)) return null;
  if (p.wspd === 0) return t('Wind calm');
  if (!Number.isFinite(p.wdir))
    return t('Wind variable at {speed} kt', { speed: number(p.wspd, 0) });
  const dir = String(Math.round(p.wdir)).padStart(3, '0');
  return Number.isFinite(p.wgst)
    ? t('Wind {dir}° at {speed} kt, gusting {gust} kt', {
        dir,
        speed: number(p.wspd, 0),
        gust: number(p.wgst, 0),
      })
    : t('Wind {dir}° at {speed} kt', { dir, speed: number(p.wspd, 0) });
}

/** "Visibility 10+ mi · Ceiling 600 ft" (or "No ceiling"), or null. */
function skyText(p) {
  const parts = [];
  if (Number.isFinite(p.vis))
    parts.push(
      t('Visibility {vis} mi', {
        vis: `${number(p.vis, 2)}${p.visPlus ? '+' : ''}`,
      }),
    );
  if (Number.isFinite(p.ceiling))
    parts.push(t('Ceiling {ceiling} ft', { ceiling: number(p.ceiling, 0) }));
  else if (Number.isFinite(p.vis)) parts.push(t('No ceiling'));
  return parts.length ? parts.join(' · ') : null;
}

/** "Temp 12°C · Dew point 8°C · Altimeter 30.12 inHg", or null. */
function conditionsText(p) {
  const parts = [
    Number.isFinite(p.temp) && t('Temp {temp}°C', { temp: number(p.temp) }),
    Number.isFinite(p.dew) && t('Dew point {dew}°C', { dew: number(p.dew) }),
    Number.isFinite(p.altim) &&
      t('Altimeter {altim} inHg', { altim: number(p.altim, 2) }),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function buildMetarCard(feature, nowMs) {
  const p = feature.properties;
  const category = categoryOf(feature);
  const details = [
    windText(p),
    skyText(p),
    conditionsText(p),
    p.wx && t('Weather: {wx}', { wx: p.wx }),
  ].filter(Boolean);
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('observed {age} ago', { age }));
  if (p.raw) details.push(clip(p.raw, MAX_RAW_CARD));
  details.push(t('{source} ↗ · click card to open', { source: t('NOAA AWC') }));
  return {
    title: category
      ? t('{station} · {category}', { station: p.station, category })
      : p.station,
    details,
    accent: category
      ? FLIGHT_CATEGORY_COLORS[category]
      : UNKNOWN_CATEGORY_COLOR,
    link: `${METAR_PAGE}${encodeURIComponent(p.station)}`,
  };
}

/** "FL250" at and above 18,000 ft, "5,000 ft" below, "surface" at 0. */
function levelText(feet) {
  if (feet <= 0) return t('surface');
  if (feet >= 18000)
    return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`;
  return t('{feet} ft', { feet: number(feet, 0) });
}

/** "surface to FL250" / "Up to FL250" / "Above 5,000 ft", or null. */
function altitudeText(p) {
  const hasBase = Number.isFinite(p.base);
  const hasTop = Number.isFinite(p.top);
  if (hasBase && hasTop)
    return t('{base} to {top}', {
      base: levelText(p.base),
      top: levelText(p.top),
    });
  if (hasTop) return t('Up to {top}', { top: levelText(p.top) });
  if (hasBase && p.base > 0)
    return t('Above {base}', { base: levelText(p.base) });
  return null;
}

/** The advisory text without its WMO header line, on one line. */
export function advisoryBody(raw) {
  if (typeof raw !== 'string') return null;
  const lines = raw.split('\n').map((line) => line.trim());
  if (/^[A-Z]{4}\d{2} [A-Z]{4} \d{6}(?: [A-Z]{3})?$/.test(lines[0] ?? ''))
    lines.shift();
  const body = lines.filter(Boolean).join(' ');
  return body || null;
}

function buildAdvisoryCard(feature) {
  const p = feature.properties;
  const named = NAMED_HAZARDS.has(p.hazard) && p.qualifier;
  const qualifier =
    !named && p.qualifier
      ? Object.hasOwn(QUALIFIERS, p.qualifier)
        ? QUALIFIERS[p.qualifier]()
        : p.qualifier
      : null;
  const kind = p.advisory === 'airmet' ? 'AIRMET' : 'SIGMET';
  const from = utcClock(p.validFrom);
  const to = utcClock(p.validTo);
  const valid =
    from && to
      ? t('valid {from}–{to} UTC', { from, to })
      : to
        ? t('valid until {to} UTC', { to })
        : null;
  const body = advisoryBody(p.raw);
  const details = [
    [qualifier, [kind, p.series, p.issuer].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(' · '),
    p.firName,
    altitudeText(p),
    valid,
    Object.hasOwn(TRENDS, p.change) &&
      t('Trend: {trend}', { trend: TRENDS[p.change]() }),
    body && clip(body, MAX_RAW_CARD),
    t('{source} ↗ · click card to open', { source: t('NOAA AWC') }),
  ].filter(Boolean);
  const hazard = hazardLabel(p.hazard);
  return {
    title: named
      ? t('{hazard} · {name}', { hazard, name: p.qualifier })
      : hazard,
    details,
    accent: hazardInfo(p.hazard)?.color ?? OTHER_HAZARD_COLOR,
    link: SIGMET_PAGE,
  };
}

/**
 * Click card for a METAR station or an advisory area.
 * @param {Object} feature - An Aviation Weather feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildAviationCard(feature, nowMs) {
  return isAdvisory(feature?.properties)
    ? buildAdvisoryCard(feature)
    : buildMetarCard(feature, nowMs);
}

/**
 * Legend rows for what is drawn: flight categories worst first, then the
 * advisory hazards present, each with its count.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function aviationLegend(features) {
  const categories = new Map();
  const hazards = new Map();
  for (const feature of features) {
    const p = feature?.properties;
    if (isAdvisory(p)) hazards.set(p.hazard, (hazards.get(p.hazard) || 0) + 1);
    else {
      const key = categoryOf(feature) ?? 'UNKNOWN';
      categories.set(key, (categories.get(key) || 0) + 1);
    }
  }
  const rows = [...FLIGHT_CATEGORIES]
    .reverse()
    .concat('UNKNOWN')
    .filter((key) => categories.has(key))
    .map((key) => ({
      label: t(key === 'UNKNOWN' ? UNKNOWN_LABEL : CATEGORY_LABELS[key]),
      color:
        key === 'UNKNOWN'
          ? UNKNOWN_CATEGORY_COLOR
          : FLIGHT_CATEGORY_COLORS[key],
      count: categories.get(key),
    }));
  for (const [code, count] of [...hazards].sort((a, b) => b[1] - a[1]))
    rows.push({
      label: hazardLabel(code),
      color: hazardInfo(code)?.color ?? OTHER_HAZARD_COLOR,
      count,
    });
  if (rows.length)
    rows[0].blurb = t(
      'Dots are the latest METAR per station, colored by flight category (NOAA value, or worked out from ceiling and visibility). Areas are current SIGMET and AIRMET advisories, colored by hazard. Informational only: not for flight planning.',
    );
  return rows;
}
