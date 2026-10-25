/**
 * Style, legend and click-card model for Internet Outages & Data Centers.
 * Pure — no Cesium types; the shared feature layer (layers/common/featureLayer.js)
 * turns the CSS colors into graphics and the card into a world-overlay entry.
 * @module layers/internetInfrastructure/cards
 */
import { getLocale, msg, t, tn } from '../../i18n/index.js';

/** Marker colors by outage level, and for a recovered country. */
export const OUTAGE_COLORS = Object.freeze({
  critical: '#f44336',
  warning: '#ff9800',
  normal: '#66bb6a',
});

/** Fill for a data center or interconnection facility. */
export const FACILITY_COLOR = '#26c6da';

const OUTAGE_LABELS = Object.freeze({
  critical: msg('Critical outage'),
  warning: msg('Outage warning'),
  normal: msg('Recovered in the last 24 h'),
});

/** IODA signal names (English data; t() at display). */
const DATASOURCE_LABELS = Object.freeze({
  bgp: msg('BGP routing'),
  'ping-slash24': msg('Active probing'),
  gtr: msg('Google traffic'),
  'merit-nt': msg('Network telescope'),
  'ucsd-nt': msg('Network telescope'),
});

/** Subsource chips (English data; t() at display). */
export const INTERNET_SUBSOURCES = Object.freeze([
  Object.freeze({ id: 'outages', label: msg('Outages') }),
  Object.freeze({ id: 'datacenters', label: msg('Data centers') }),
]);

/** Whether a feature is a data center (else it is a country outage marker). */
export const isFacility = (properties) =>
  Number.isInteger(properties?.facility);

/** The outage level of a marker: critical, warning or normal (recovered). */
export function outageLevel(properties) {
  return Object.hasOwn(OUTAGE_COLORS, properties?.level)
    ? properties.level
    : 'normal';
}

/** Dot size for a facility by the number of networks present: hubs stand out. */
function facilitySize(netCount) {
  if (!Number.isFinite(netCount)) return 4;
  if (netCount >= 150) return 8;
  if (netCount >= 50) return 6;
  if (netCount >= 10) return 5;
  return 4;
}

/**
 * Style for an outage marker or a data center point.
 * Outages: colored by level, big for a country-wide signal and a little
 * smaller when only regions inside the country are down, white ring while the
 * outage is going and dark when it has recovered. Data centers: small cyan
 * dots sized by the networks present, on the ellipsoid (thousands of points).
 * @param {Object} feature
 * @returns {Object} Style for createKeylessFeatureLayer.
 */
export function internetStyle(feature) {
  const p = feature?.properties || {};
  if (isFacility(p))
    return {
      color: FACILITY_COLOR,
      outlineColor: '#00363d',
      outlineWidth: 1,
      pixelSize: facilitySize(p.netCount),
      clampToGround: false,
    };
  const level = outageLevel(p);
  const sizes = { critical: 14, warning: 13, normal: 9 };
  return {
    color: OUTAGE_COLORS[level],
    outlineColor: p.ongoing ? '#ffffff' : '#000000',
    outlineWidth: p.ongoing ? 2 : 1,
    pixelSize: Math.max(8, sizes[level] - (p.scope === 'region' ? 3 : 0)),
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

/** A country's name in the UI language, else the name IODA sent, else the code. */
export function countryName(properties) {
  const code = String(properties?.code ?? '');
  try {
    const name = new Intl.DisplayNames([getLocale()], {
      type: 'region',
      fallback: 'none',
    }).of(code);
    if (name && name !== code) return name;
  } catch {
    // An older runtime without Intl.DisplayNames, or a code it rejects.
  }
  return properties?.name || code;
}

/** The signal's name in the UI language ("BGP routing"); an unknown one as sent. */
export function datasourceLabel(datasource) {
  return Object.hasOwn(DATASOURCE_LABELS, datasource)
    ? t(DATASOURCE_LABELS[datasource])
    : String(datasource);
}

/** "Kano, Dili +2" for the regions behind a marker, or null. */
function regionsText(p) {
  const names = Array.isArray(p.regions) ? p.regions : [];
  if (!names.length) return null;
  const extra = Number.isFinite(p.regionCount)
    ? p.regionCount - names.length
    : 0;
  return t('Regions: {regions}', {
    regions: names.join(', ') + (extra > 0 ? ` +${extra}` : ''),
  });
}

function buildOutageCard(feature, nowMs) {
  const p = feature.properties;
  const level = outageLevel(p);
  const status = !p.ongoing
    ? t('Recovered: connectivity is back to normal')
    : p.scope === 'region'
      ? t('Connectivity dropped inside the country, not country-wide')
      : level === 'critical'
        ? t('Critical drop in connectivity')
        : t('Warning-level drop in connectivity');
  const details = [status, regionsText(p)];
  if (Array.isArray(p.datasources) && p.datasources.length)
    details.push(
      t('Detected by {sources}', {
        sources: p.datasources.map(datasourceLabel).join(' · '),
      }),
    );
  const started = formatAge(nowMs - Date.parse(p.start));
  if (started) details.push(t('started {age} ago', { age: started }));
  const ended = p.end ? formatAge(nowMs - Date.parse(p.end)) : null;
  if (ended) details.push(t('ended {age} ago', { age: ended }));
  details.push(
    t('Marker at the country centre: IODA reports countries, not places'),
  );
  details.push(
    t('{source} ↗ · click card to open', { source: t('Georgia Tech IODA') }),
  );
  return {
    title: countryName(p),
    details: details.filter(Boolean),
    accent: OUTAGE_COLORS[level],
    link: p.url,
  };
}

function buildFacilityCard(feature) {
  const p = feature.properties;
  const place = [p.city, p.country].filter(Boolean).join(', ');
  const counts = [
    Number.isFinite(p.netCount) &&
      tn(p.netCount, '{count} network', '{count} networks'),
    Number.isFinite(p.ixCount) &&
      tn(p.ixCount, '{count} exchange', '{count} exchanges'),
  ].filter(Boolean);
  let host = null;
  try {
    host = p.website ? new URL(p.website).hostname.replace(/^www\./, '') : null;
  } catch {
    host = null;
  }
  const details = [
    [p.org, place].filter(Boolean).join(' · '),
    counts.join(' · '),
    host,
    t('{source} ↗ · click card to open', { source: t('PeeringDB') }),
  ].filter(Boolean);
  return {
    title: p.name,
    details,
    accent: FACILITY_COLOR,
    link: p.url,
  };
}

/**
 * Click card for a country outage marker or a data center.
 * @param {Object} feature - An Internet Outages & Data Centers feature (see records.js).
 * @param {number} nowMs
 * @returns {{title: string, details: string[], accent: string, link: string}}
 */
export function buildInternetCard(feature, nowMs) {
  return isFacility(feature?.properties)
    ? buildFacilityCard(feature)
    : buildOutageCard(feature, nowMs);
}

/**
 * Legend rows for what is drawn: outage levels worst first, then the data
 * center count, each with its count.
 * @param {Array<Object>} features
 * @returns {Array<{label: string, color: string, count: number, blurb?: string}>}
 */
export function internetLegend(features) {
  const levels = new Map();
  let facilities = 0;
  for (const feature of features) {
    const p = feature?.properties;
    if (isFacility(p)) facilities++;
    else {
      const level = outageLevel(p);
      levels.set(level, (levels.get(level) || 0) + 1);
    }
  }
  const rows = ['critical', 'warning', 'normal']
    .filter((level) => levels.has(level))
    .map((level) => ({
      label: t(OUTAGE_LABELS[level]),
      color: OUTAGE_COLORS[level],
      count: levels.get(level),
    }));
  if (facilities)
    rows.push({
      label: t('Data center or network facility'),
      color: FACILITY_COLOR,
      count: facilities,
    });
  if (rows.length)
    rows[0].blurb = t(
      'Red and orange markers are countries where Georgia Tech IODA sees internet connectivity dropping, drawn at the country centre because IODA reports countries, not places; green ones recovered in the last 24 hours. Cyan dots are data centers and interconnection facilities listed in PeeringDB. IODA signals can raise false alarms: not proof of an outage.',
    );
  return rows;
}
