/**
 * Style, legend, row readout and click-card model for Aurora & Space Weather.
 * Pure — no Cesium types; the shared feature layer
 * (layers/common/featureLayer.js) turns the CSS colors into graphics and the
 * card into a world-overlay entry.
 * @module layers/spaceWeather/cards
 */
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { AURORA_BANDS, spaceWeatherFromMetadata } from './records.js';

/**
 * Fill per probability band (same order as AURORA_BANDS): faint green to
 * red, translucent so the terrain and imagery stay readable. Areas are
 * drawn without an outline: neighboring blocks of a band meet along shared
 * edges and an outline would draw them as seams.
 */
export const AURORA_BAND_STYLES = Object.freeze([
  Object.freeze({ color: '#00e676', fillAlpha: 0.22 }),
  Object.freeze({ color: '#76ff03', fillAlpha: 0.32 }),
  Object.freeze({ color: '#ffea00', fillAlpha: 0.4 }),
  Object.freeze({ color: '#ff1744', fillAlpha: 0.48 }),
]);

/** Where the card's click-through goes: SWPC's own aurora forecast page. */
export const AURORA_PAGE_URL =
  'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast';

/** Feed names for the "<feed> feed unavailable" status (no row chips: Kp has no features). */
export const SPACE_WEATHER_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'aurora', label: msg('NOAA aurora'), chip: false }),
  Object.freeze({ id: 'kp', label: msg('NOAA Kp index'), chip: false }),
]);

/** NOAA geomagnetic storm names, G1 to G5. */
const STORM_NAMES = Object.freeze({
  1: msg('minor geomagnetic storm'),
  2: msg('moderate geomagnetic storm'),
  3: msg('strong geomagnetic storm'),
  4: msg('severe geomagnetic storm'),
  5: msg('extreme geomagnetic storm'),
});

/** Kp as shown: whole numbers bare, thirds with two decimals ("5.33"). */
export function formatKp(kp) {
  return formatNumber(kp, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/** UTC clock time of an ISO timestamp ("06:00"), or null. */
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

/** Index into AURORA_BANDS for a feature, from its lower bound; clamps unknowns to the faintest. */
function bandIndex(feature) {
  const index = AURORA_BANDS.findIndex(
    ({ min }) => min === feature?.properties?.band,
  );
  return index < 0 ? 0 : index;
}

/** "10–20%" / "60% or more" in the UI language. */
function bandLabel(band) {
  return band.max === null
    ? t('Aurora chance {min}% or more', { min: band.min })
    : t('Aurora chance {min}–{max}%', { min: band.min, max: band.max });
}

/**
 * Area style: the band's fill color, no outline.
 * @param {Object} feature - An aurora band feature.
 * @returns {{color: string, fillAlpha: number, outline: false}}
 */
export function auroraStyle(feature) {
  const { color, fillAlpha } = AURORA_BAND_STYLES[bandIndex(feature)];
  return { color, fillAlpha, outline: false };
}

/**
 * "Kp 5.33 · G1 minor geomagnetic storm" for a summary from
 * `spaceWeatherFromMetadata`.
 * @param {{kp: number, gScale: number}} summary
 * @returns {string}
 */
export function kpSummaryText({ kp, gScale }) {
  return STORM_NAMES[gScale]
    ? t('Kp {kp} · G{level} {storm}', {
        kp: formatKp(kp),
        level: gScale,
        storm: t(STORM_NAMES[gScale]),
      })
    : t('Kp {kp} · no geomagnetic storm', { kp: formatKp(kp) });
}

/**
 * Panel row readout: the latest planetary Kp and NOAA G-scale, with the
 * interval it covers and the 24-hour peak as the tooltip. Null while the Kp
 * feed has not answered.
 * @param {?Object} metadata - Response `metadata`.
 * @returns {?{text: string, title: string}}
 */
export function spaceWeatherRowInfo(metadata) {
  const summary = spaceWeatherFromMetadata(metadata);
  if (!summary) return null;
  const from = utcClock(summary.kpTime);
  const peak = summary.kpMax24h;
  return {
    text: kpSummaryText(summary),
    title:
      from && peak !== null
        ? t(
            'Planetary K-index for the 3-hour interval starting {time} UTC; highest of the last 24 hours: {peak}',
            { time: from, peak: formatKp(peak) },
          )
        : t('Planetary K-index (NOAA SWPC)'),
  };
}

/**
 * Build the click card for one aurora band block.
 * @param {Object} feature - An aurora band feature (see records.js).
 * @param {number} nowMs
 * @param {?Object} metadata - Response `metadata` (for the Kp line).
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildAuroraCard(feature, nowMs, metadata) {
  const p = feature?.properties || {};
  const index = bandIndex(feature);
  const details = [];
  if (Number.isFinite(p.probability))
    details.push(
      t('Peak {probability}% in this area', { probability: p.probability }),
    );
  const valid = utcClock(p.forecastTime);
  const age = formatAge(nowMs - Date.parse(p.observationTime));
  const timing = [
    valid && t('nowcast for {time} UTC', { time: valid }),
    age && t('updated {age} ago', { age }),
  ].filter(Boolean);
  if (timing.length) details.push(timing.join(' · '));
  const summary = spaceWeatherFromMetadata(metadata);
  if (summary) details.push(kpSummaryText(summary));
  details.push(
    t('{source} ↗ · click card to open', { source: t('NOAA SWPC') }),
  );
  return {
    title: bandLabel(AURORA_BANDS[index]),
    details,
    accent: AURORA_BAND_STYLES[index].color,
    link: AURORA_PAGE_URL,
  };
}

/**
 * Legend rows for the aurora bands currently drawn, faintest first.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: null, blurb?: string}>}
 */
export function auroraLegend(features) {
  const present = new Set(features.map((feature) => bandIndex(feature)));
  return AURORA_BANDS.map((band, index) => ({ band, index }))
    .filter(({ index }) => present.has(index))
    .map(({ band, index }, position) => ({
      label: bandLabel(band),
      color: AURORA_BAND_STYLES[index].color,
      count: null,
      ...(position === 0
        ? {
            blurb: t(
              'NOAA OVATION aurora nowcast: the chance of visible aurora, drawn in bands from 10% and refreshed about every 5 minutes. Kp is the planetary geomagnetic index; G1 to G5 is the NOAA storm scale.',
            ),
          }
        : {}),
    }));
}
