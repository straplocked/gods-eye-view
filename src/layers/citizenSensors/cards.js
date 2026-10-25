/**
 * Style, legend and click-card model for Citizen Air & Radiation Sensors.
 * Pure — no Cesium types; the shared feature layer
 * (layers/common/featureLayer.js) turns the CSS colors into graphics and the
 * card into a world-overlay entry.
 * @module layers/citizenSensors/cards
 */
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { AQI_CATEGORIES, CPM_PER_USV } from './records.js';

/** US EPA AQI colors, by category (records.js AQI_CATEGORIES). */
export const AQI_COLORS = Object.freeze({
  good: '#00e400',
  moderate: '#ffff00',
  usg: '#ff7e00',
  unhealthy: '#ff0000',
  'very-unhealthy': '#8f3f97',
  hazardous: '#7e0023',
});

const AQI_LABELS = Object.freeze({
  good: msg('Good'),
  moderate: msg('Moderate'),
  usg: msg('Unhealthy for sensitive groups'),
  unhealthy: msg('Unhealthy'),
  'very-unhealthy': msg('Very unhealthy'),
  hazardous: msg('Hazardous'),
});

/** Fill for a cell whose category is unknown (never produced by the server). */
export const UNKNOWN_COLOR = '#9e9e9e';

/** Radiation classes by dose rate in µSv/h, lowest first. Natural background is 0.05-0.3. */
const RADIATION_CLASSES = Object.freeze([
  Object.freeze({
    min: 0,
    color: '#b2ebf2',
    label: msg('Radiation under 0.10 µSv/h'),
  }),
  Object.freeze({
    min: 0.1,
    color: '#26c6da',
    label: msg('Radiation 0.10–0.29 µSv/h'),
  }),
  Object.freeze({
    min: 0.3,
    color: '#ffd54f',
    label: msg('Radiation 0.30–0.99 µSv/h'),
  }),
  Object.freeze({
    min: 1,
    color: '#ff7043',
    label: msg('Radiation 1–9.9 µSv/h'),
  }),
  Object.freeze({
    min: 10,
    color: '#d500f9',
    label: msg('Radiation 10 µSv/h or more'),
  }),
]);

/** Subsource chips (English data; t() at display). */
export const CITIZEN_SENSOR_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'airpm', label: msg('Particulate sensors') }),
  Object.freeze({ id: 'radiation', label: msg('Radiation sensors') }),
]);

const AIR_PAGE = 'https://maps.sensor.community/';
const RADIATION_PAGE = 'https://map.safecast.org/';

/** Whether a feature is a Safecast radiation reading (else it is a PM grid cell). */
export const isRadiation = (properties) => properties?.source === 'radiation';

/** The radiation class of a dose rate in µSv/h, or null when it is not a number. */
function radiationClass(usv) {
  if (!Number.isFinite(usv)) return null;
  let found = RADIATION_CLASSES[0];
  for (const entry of RADIATION_CLASSES) if (usv >= entry.min) found = entry;
  return found;
}

/** The AQI category's name in the UI language ("Unhealthy for sensitive groups"). */
export function aqiLabel(category) {
  return Object.hasOwn(AQI_LABELS, category)
    ? t(AQI_LABELS[category])
    : String(category);
}

/** Dot size of a PM cell by how many sensors back it: well covered cells read first. */
function cellSize(sensors) {
  if (!Number.isFinite(sensors) || sensors < 2) return 6;
  if (sensors < 5) return 7;
  if (sensors < 20) return 8;
  return 10;
}

/**
 * Style for a PM grid cell or a radiation reading. Cells: the EPA AQI color of
 * the median PM2.5, bigger where more sensors agree, black outline. Radiation:
 * the dose-rate class color with a white ring (so it never reads as a PM cell).
 * Both sit on the ellipsoid (thousands of points).
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function citizenStyle(feature) {
  const p = feature?.properties || {};
  if (isRadiation(p)) {
    const cls = radiationClass(p.usv);
    return {
      color: cls ? cls.color : UNKNOWN_COLOR,
      outlineColor: '#ffffff',
      outlineWidth: 2,
      pixelSize: 9,
      clampToGround: false,
    };
  }
  return {
    color: Object.hasOwn(AQI_COLORS, p.category)
      ? AQI_COLORS[p.category]
      : UNKNOWN_COLOR,
    outlineColor: '#000000',
    outlineWidth: 1,
    pixelSize: cellSize(p.sensors),
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

function buildAirCard(feature, nowMs) {
  const p = feature.properties;
  const details = [
    t('PM2.5 {pm25} µg/m³ · AQI {aqi}', {
      pm25: number(p.pm25),
      aqi: number(p.aqi, 0),
    }),
  ];
  if (Number.isFinite(p.pm10))
    details.push(t('PM10 {pm10} µg/m³', { pm10: number(p.pm10) }));
  if (Number.isFinite(p.sensors))
    details.push(
      tn(
        p.sensors,
        '{count} outdoor sensor in this 0.1° cell (median shown)',
        '{count} outdoor sensors in this 0.1° cell (median shown)',
      ),
    );
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('observed {age} ago', { age }));
  details.push(t('Community-built sensors: indicative, not calibrated.'));
  details.push(
    t('{source} ↗ · click card to open', { source: t('Sensor.Community') }),
  );
  return {
    title: t('Air quality: {category}', { category: aqiLabel(p.category) }),
    details,
    accent: Object.hasOwn(AQI_COLORS, p.category)
      ? AQI_COLORS[p.category]
      : UNKNOWN_COLOR,
    link: AIR_PAGE,
  };
}

function buildRadiationCard(feature, nowMs) {
  const p = feature.properties;
  const cls = radiationClass(p.usv);
  const details = [];
  if (Number.isFinite(p.cpm))
    details.push(t('{cpm} counts per minute', { cpm: number(p.cpm, 0) }));
  details.push(
    p.usvEstimated
      ? t(
          'Dose rate estimated at {factor} counts per minute per µSv/h; the real factor depends on the detector',
          { factor: number(CPM_PER_USV, 0) },
        )
      : t('Dose rate as reported by the device'),
  );
  if (Number.isFinite(p.device))
    details.push(t('Safecast device {device}', { device: p.device }));
  const age = formatAge(nowMs - Date.parse(p.timestamp));
  if (age) details.push(t('observed {age} ago', { age }));
  details.push(t('{source} ↗ · click card to open', { source: t('Safecast') }));
  return {
    title: p.usvEstimated
      ? t('Radiation ≈ {usv} µSv/h', { usv: number(p.usv, 3) })
      : t('Radiation {usv} µSv/h', { usv: number(p.usv, 3) }),
    details,
    accent: cls ? cls.color : UNKNOWN_COLOR,
    link: RADIATION_PAGE,
  };
}

/**
 * Click card for a PM grid cell or a radiation reading.
 * @param {Object} feature - A Citizen Sensors feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildCitizenCard(feature, nowMs) {
  return isRadiation(feature?.properties)
    ? buildRadiationCard(feature, nowMs)
    : buildAirCard(feature, nowMs);
}

/**
 * Legend rows for what is drawn: air quality categories worst first, then
 * radiation classes highest first, each with its count.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function citizenLegend(features) {
  const air = new Map();
  const radiation = new Map();
  for (const feature of features) {
    const p = feature?.properties;
    if (isRadiation(p)) {
      const cls = radiationClass(p.usv);
      if (cls) radiation.set(cls, (radiation.get(cls) || 0) + 1);
    } else if (Object.hasOwn(AQI_COLORS, p?.category)) {
      air.set(p.category, (air.get(p.category) || 0) + 1);
    }
  }
  const rows = [...AQI_CATEGORIES]
    .reverse()
    .filter((category) => air.has(category))
    .map((category) => ({
      label: t('Air quality: {category}', { category: aqiLabel(category) }),
      color: AQI_COLORS[category],
      count: air.get(category),
    }));
  for (const cls of [...RADIATION_CLASSES].reverse())
    if (radiation.has(cls))
      rows.push({
        label: t(cls.label),
        color: cls.color,
        count: radiation.get(cls),
      });
  if (rows.length)
    rows[0].blurb = t(
      'Dots with a black outline are outdoor Sensor.Community particulate sensors, the median PM2.5 of each 0.1° cell, colored by US EPA air quality category. Dots with a white ring are the latest Safecast radiation reading of each device in the last six hours; counts per minute are converted to µSv/h at a nominal factor, so treat them as estimates. Citizen-built sensors: informational only.',
    );
  return rows;
}
