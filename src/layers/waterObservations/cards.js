/**
 * Style, legend and click-card model for Buoys & River Gauges. Pure — no
 * Cesium types; the shared feature layer (layers/common/featureLayer.js)
 * turns the CSS colors into graphics and the card into a world-overlay entry.
 * @module layers/waterObservations/cards
 */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { FLOOD_CATEGORIES, floodRank } from './records.js';

/** Wind classes by sustained speed in knots, calmest first. */
const WIND_CLASSES = Object.freeze([
  Object.freeze({
    min: 0,
    color: '#b3e5fc',
    label: msg('Wind under 11 kt'),
  }),
  Object.freeze({
    min: 11,
    color: '#4fc3f7',
    label: msg('Wind 11–21 kt'),
  }),
  Object.freeze({
    min: 22,
    color: '#1e88e5',
    label: msg('Wind 22–33 kt'),
  }),
  Object.freeze({
    min: 34,
    color: '#5e35b1',
    label: msg('Wind 34–47 kt (gale)'),
  }),
  Object.freeze({
    min: 48,
    color: '#ab47bc',
    label: msg('Wind 48 kt or more (storm)'),
  }),
]);

/** Fill for a station that reports no wind speed. */
export const NO_WIND_COLOR = '#9e9e9e';
const NO_WIND_LABEL = msg('No wind reported');

/** River gauge colors by flood category (NWS action, minor, moderate, major). */
export const FLOOD_CATEGORY_COLORS = Object.freeze({
  action: '#ffee58',
  minor: '#ff9800',
  moderate: '#f44336',
  major: '#d500f9',
});

const FLOOD_LABELS = Object.freeze({
  action: msg('Action stage'),
  minor: msg('Minor flooding'),
  moderate: msg('Moderate flooding'),
  major: msg('Major flooding'),
});

/** Gauge dot size by flood category: worse floods are bigger. */
const GAUGE_SIZES = Object.freeze({
  action: 9,
  minor: 10,
  moderate: 11,
  major: 12,
});

/** Subsource chips (English data; t() at display). */
export const WATER_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'buoys', label: msg('Buoys') }),
  Object.freeze({ id: 'rivers', label: msg('River gauges') }),
]);

const STATION_PAGE = 'https://www.ndbc.noaa.gov/station_page.php?station=';
const GAUGE_PAGE = 'https://water.noaa.gov/gauges/';

/** Whether a feature is a river gauge (else it is a buoy or coastal station). */
export const isGauge = (properties) => typeof properties?.gauge === 'string';

/** The wind class of a sustained speed in knots, or null when not reported. */
function windClass(windKt) {
  if (!Number.isFinite(windKt)) return null;
  let found = WIND_CLASSES[0];
  for (const entry of WIND_CLASSES) if (windKt >= entry.min) found = entry;
  return found;
}

/** The worse of a gauge's observed and forecast flood categories, or null. */
export function gaugeLevel(properties) {
  const observed = floodRank(properties?.category);
  const forecast = floodRank(properties?.forecastCategory);
  const rank = Math.max(observed, forecast);
  return rank ? FLOOD_CATEGORIES[rank - 1] : null;
}

/** Dot size for a buoy by wave height (m): rough seas stand out. */
function waveSize(waveM) {
  if (!Number.isFinite(waveM)) return 5;
  if (waveM >= 6) return 9;
  if (waveM >= 4) return 7;
  if (waveM >= 2) return 6;
  return 5;
}

/**
 * Style for a buoy point or a river gauge point.
 * Buoys: colored by sustained wind speed, bigger in higher seas, on the
 * ellipsoid (hundreds of points). Gauges: colored by the worse of the
 * observed and forecast flood category; a white ring marks a gauge that is
 * flooding now, a dark one a gauge only forecast to.
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function waterStyle(feature) {
  const p = feature?.properties || {};
  if (isGauge(p)) {
    const level = gaugeLevel(p);
    return {
      color: level ? FLOOD_CATEGORY_COLORS[level] : NO_WIND_COLOR,
      outlineColor: p.category ? '#ffffff' : '#000000',
      outlineWidth: p.category ? 2 : 1,
      pixelSize: level ? GAUGE_SIZES[level] : 9,
      clampToGround: false,
    };
  }
  const cls = windClass(p.windKt);
  return {
    color: cls ? cls.color : NO_WIND_COLOR,
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: waveSize(p.waveM),
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

const number = (value, maximumFractionDigits = 1) =>
  formatNumber(value, { maximumFractionDigits });

/** "Wind 160° at 10 kt, gusting 16 kt" / "Wind calm", or null when not reported. */
function windText(p) {
  if (!Number.isFinite(p.windKt)) return null;
  if (p.windKt === 0) return t('Wind calm');
  const speed = number(p.windKt, 0);
  const gusting = Number.isFinite(p.gustKt) && p.gustKt > p.windKt;
  const gust = gusting ? number(p.gustKt, 0) : null;
  if (!Number.isFinite(p.windDir))
    return gusting
      ? t('Wind {speed} kt, gusting {gust} kt', { speed, gust })
      : t('Wind {speed} kt', { speed });
  const dir = String(Math.round(p.windDir) % 360).padStart(3, '0');
  return gusting
    ? t('Wind {dir}° at {speed} kt, gusting {gust} kt', { dir, speed, gust })
    : t('Wind {dir}° at {speed} kt', { dir, speed });
}

/** "Waves 2.4 m · Wave period 7 s", or null. */
function waveText(p) {
  const parts = [
    Number.isFinite(p.waveM) &&
      t('Waves {height} m', { height: number(p.waveM) }),
    Number.isFinite(p.wavePeriodS) &&
      t('Wave period {period} s', { period: number(p.wavePeriodS, 0) }),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** "Pressure 1,012.3 hPa · Change -1.8 hPa in 3 h", or null. */
function pressureText(p) {
  const parts = [
    Number.isFinite(p.pressureHpa) &&
      t('Pressure {pressure} hPa', { pressure: number(p.pressureHpa) }),
    Number.isFinite(p.pressureTrendHpa) &&
      t('Change {change} hPa in 3 h', {
        change: formatNumber(p.pressureTrendHpa, {
          maximumFractionDigits: 1,
          signDisplay: 'exceptZero',
        }),
      }),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** "Temp 21°C · Water 22.5°C · Dew point 17°C", or null. */
function temperatureText(p) {
  const parts = [
    Number.isFinite(p.airC) && t('Temp {temp}°C', { temp: number(p.airC) }),
    Number.isFinite(p.waterC) &&
      t('Water {temp}°C', { temp: number(p.waterC) }),
    Number.isFinite(p.dewC) && t('Dew point {dew}°C', { dew: number(p.dewC) }),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** "Visibility 1.6 nmi · Tide 0.6 ft", or null. */
function seaText(p) {
  const parts = [
    Number.isFinite(p.visNmi) &&
      t('Visibility {vis} nmi', { vis: number(p.visNmi) }),
    Number.isFinite(p.tideFt) &&
      t('Tide {tide} ft', { tide: number(p.tideFt, 2) }),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function buildBuoyCard(feature, nowMs) {
  const p = feature.properties;
  const cls = windClass(p.windKt);
  const details = [
    windText(p),
    waveText(p),
    pressureText(p),
    temperatureText(p),
    seaText(p),
  ].filter(Boolean);
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('observed {age} ago', { age }));
  details.push(
    t('{source} ↗ · click card to open', { source: t('NOAA NDBC') }),
  );
  return {
    title: t('NDBC station {station}', { station: p.station }),
    details,
    accent: cls ? cls.color : NO_WIND_COLOR,
    link: `${STATION_PAGE}${encodeURIComponent(p.station)}`,
  };
}

/** The category's label in the UI language ("Minor flooding"). */
export function floodLabel(category) {
  return Object.hasOwn(FLOOD_LABELS, category)
    ? t(FLOOD_LABELS[category])
    : String(category);
}

function buildGaugeCard(feature, nowMs) {
  const p = feature.properties;
  const level = gaugeLevel(p);
  const stage = Number.isFinite(p.stageFt)
    ? t('Stage {stage} ft', { stage: number(p.stageFt, 2) })
    : null;
  const flow = Number.isFinite(p.flowKcfs)
    ? t('Flow {flow} kcfs', { flow: number(p.flowKcfs, 2) })
    : null;
  const forecastStage = Number.isFinite(p.forecastStageFt)
    ? t('Stage {stage} ft', { stage: number(p.forecastStageFt, 2) })
    : null;
  const details = [
    [p.gauge, p.state].filter(Boolean).join(' · '),
    p.category
      ? t('Now: {category}', { category: floodLabel(p.category) })
      : t('Now: below action stage'),
    [stage, flow].filter(Boolean).join(' · '),
    p.forecastCategory &&
      [
        t('Forecast: {category}', {
          category: floodLabel(p.forecastCategory),
        }),
        forecastStage,
      ]
        .filter(Boolean)
        .join(' · '),
  ].filter(Boolean);
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('observed {age} ago', { age }));
  details.push(
    t('{source} ↗ · click card to open', { source: t('NOAA NWPS') }),
  );
  return {
    title: p.name,
    details,
    accent: level ? FLOOD_CATEGORY_COLORS[level] : NO_WIND_COLOR,
    link: `${GAUGE_PAGE}${encodeURIComponent(String(p.gauge).toLowerCase())}`,
  };
}

/**
 * Click card for a buoy or station, or a river gauge.
 * @param {Object} feature - A Buoys & River Gauges feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildWaterCard(feature, nowMs) {
  return isGauge(feature?.properties)
    ? buildGaugeCard(feature, nowMs)
    : buildBuoyCard(feature, nowMs);
}

/**
 * Legend rows for what is drawn: flood categories worst first, then wind
 * classes strongest first, each with its count.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function waterLegend(features) {
  const levels = new Map();
  const winds = new Map();
  for (const feature of features) {
    const p = feature?.properties;
    if (isGauge(p)) {
      const level = gaugeLevel(p);
      if (level) levels.set(level, (levels.get(level) || 0) + 1);
    } else {
      const cls = windClass(p?.windKt);
      winds.set(cls, (winds.get(cls) || 0) + 1);
    }
  }
  const rows = [...FLOOD_CATEGORIES]
    .reverse()
    .filter((level) => levels.has(level))
    .map((level) => ({
      label: floodLabel(level),
      color: FLOOD_CATEGORY_COLORS[level],
      count: levels.get(level),
    }));
  for (const cls of [...WIND_CLASSES].reverse().concat(null))
    if (winds.has(cls))
      rows.push({
        label: t(cls ? cls.label : NO_WIND_LABEL),
        color: cls ? cls.color : NO_WIND_COLOR,
        count: winds.get(cls),
      });
  if (rows.length)
    rows[0].blurb = t(
      'Dots at sea and on the coast are the latest NOAA NDBC buoy and station observations, colored by wind speed and larger in higher seas. Dots on rivers are NWS gauges at or above flood action stage, now or in the forecast. Informational only: not for navigation or flood warnings.',
    );
  return rows;
}
