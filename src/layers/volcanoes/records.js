/**
 * Normalizers for the Volcanoes layer: Smithsonian Global Volcanism Program
 * (GVP) continuing eruptions and USGS Volcano Hazards Program alert status,
 * and the merge that turns both into one feature per volcano. Pure and
 * portable — the server proxy (server/providers/volcanoes.js) and tests
 * import them.
 *
 * Each upstream normalizes on its own (feature id = the GVP volcano number,
 * `vnum`, which USGS uses as well). `mergeVolcanoFeatures` runs on the proxy
 * response, after the kit has stamped `properties.source`, and joins a volcano
 * listed by both into a single `source: 'gvp+usgs'` feature.
 * @module layers/volcanoes/records
 */
import { isValidPosition, toIsoTimestamp } from '../common/geojson.js';

export const VOLCANOES_LAYER_ID = 'volcanoes';

/**
 * GVP "Volcanoes of the World" WFS, eruptions since 1960 filtered to those
 * still marked continuing. (The volcano.si.edu RSS feeds are behind bot
 * verification and are not used.)
 */
export const GVP_URL =
  'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:E3WebApp_Eruptions1960&outputFormat=application/json&CQL_FILTER=ContinuingEruption=%27True%27';

/**
 * USGS Volcano Hazards Program status for every US volcano. It answers with a
 * JSON array under a text/html content type.
 */
export const USGS_URL =
  'https://volcanoes.usgs.gov/vsc/api/volcanoApi/vhpstatus';

/**
 * User-Agent for the USGS request. The service answers 404 to a User-Agent
 * that carries a URL (the kit's default `GodsEyeView/fork (+https://…)`) and
 * 200 to the same product token alone, so the USGS subsource names the app
 * without the contact URL.
 */
export const USGS_USER_AGENT = 'GodsEyeView/fork';

/** USGS aviation color codes that style a volcano, mildest first. */
export const AVIATION_COLOR_CODES = Object.freeze([
  'GREEN',
  'YELLOW',
  'ORANGE',
  'RED',
]);

/** USGS alert levels shown by default, mildest first. */
export const ELEVATED_ALERT_LEVELS = Object.freeze([
  'ADVISORY',
  'WATCH',
  'WARNING',
]);

const MAX_TEXT = 200;
const MAX_SYNOPSIS = 400;
const VOLCANO_NUMBER = /^\d{4,7}$/;
const OBSERVATORY_CODE = /^[a-z0-9]{2,8}$/i;
const SYNOPSIS_PREFIX =
  /^.{1,80}? (?:GREEN|YELLOW|ORANGE|RED|UNASSIGNED)\/[A-Z]+ - /;
const NOTICE_TIME =
  /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}))$/;
const USGS_LINK_HOSTS = /(?:^|\.)(?:usgs\.gov|alaska\.edu|volcano\.si\.edu)$/;

/** Error for a corrupt or non-collection payload; never cached (keylessFeed). */
function invalidPayload(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value, limit = MAX_TEXT) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, limit) : null;
};

/** An https link (no credentials) whose hostname passes `hostTest`, or null. */
function httpsLink(value, hostTest) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (hostTest && !hostTest.test(url.hostname)) return null;
  return url.href;
}

/** The GVP page for one volcano (the number is digits only). */
export function gvpVolcanoUrl(vnum) {
  return `https://volcano.si.edu/volcano.cfm?vn=${vnum}`;
}

/** A GVP volcano number as a positive integer, or null. */
function volcanoNumber(value) {
  const digits = typeof value === 'number' ? String(value) : value;
  if (typeof digits !== 'string' || !VOLCANO_NUMBER.test(digits)) return null;
  return Number(digits);
}

function integerIn(value, min, max) {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : null;
}

/**
 * The eruption start as far as GVP knows it: a year, then optionally a month
 * and a day. Some eruptions only have a year (Yasur: 1270) or none at all.
 * A zero month or day in the YYYYMMDD string means "unknown".
 * @returns {{year: ?number, month: ?number, day: ?number}}
 */
function startParts(properties) {
  const written = /^(\d{4})(\d{2})(\d{2})$/.exec(
    String(properties.StartDate ?? ''),
  );
  const year =
    integerIn(properties.StartDateYear, 1, 9999) ??
    (written ? integerIn(written[1], 1, 9999) : null);
  if (year == null) return { year: null, month: null, day: null };
  const month =
    integerIn(properties.StartDateMonth, 1, 12) ??
    (written ? integerIn(written[2], 1, 12) : null);
  const day =
    month == null
      ? null
      : (integerIn(properties.StartDateDay, 1, 31) ??
        (written ? integerIn(written[3], 1, 31) : null));
  return { year, month, day };
}

/** ISO midnight UTC for a complete, real calendar date, else null. */
function startIso({ year, month, day }) {
  if (year == null || month == null || day == null) return null;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Date.UTC maps years 0-99 to 1900-1999 and rolls 31 Feb over to March.
  if (
    year < 100 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return date.toISOString();
}

/** Sort key of a start, unknown parts counting as the earliest. */
const startRank = ({ year, month, day }) =>
  (year ?? -1) * 10000 + (month ?? 0) * 100 + (day ?? 0);

/** [lon, lat] from a Point geometry, else from decimal fields, else null. */
function eruptionPosition(feature, properties) {
  const coordinates = feature.geometry?.coordinates;
  if (feature.geometry?.type === 'Point' && isValidPosition(coordinates))
    return [coordinates[0], coordinates[1]];
  const position = [properties.LongitudeDecimal, properties.LatitudeDecimal];
  return isValidPosition(position) ? position : null;
}

/**
 * Normalize the GVP continuing-eruptions WFS payload into one point per
 * volcano.
 *
 * A volcano can have more than one open eruption record; the one with the
 * latest start date is kept (ties go to the higher `Activity_ID`). Records not
 * flagged `ContinuingEruption: 'True'` are skipped even though the request
 * filters for it, so a server that ignores the filter cannot turn the layer
 * into every eruption since 1960. Feature ids are the volcano number.
 * @param {Object} payload - GeoServer FeatureCollection.
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws When the payload is not a FeatureCollection.
 */
export function normalizeGvpEruptions(payload) {
  if (!isObject(payload) || !Array.isArray(payload.features))
    throw invalidPayload('GVP payload is not a FeatureCollection');
  const latest = new Map();
  for (const feature of payload.features) {
    const properties = feature?.properties;
    if (!isObject(properties)) continue;
    if (String(properties.ContinuingEruption).toLowerCase() !== 'true')
      continue;
    const vnum = volcanoNumber(properties.VolcanoNumber);
    const position =
      vnum == null ? null : eruptionPosition(feature, properties);
    if (!position) continue;
    const start = startParts(properties);
    const activity = Number.isFinite(properties.Activity_ID)
      ? properties.Activity_ID
      : -1;
    const previous = latest.get(vnum);
    if (previous) {
      const delta = startRank(start) - startRank(previous.start);
      if (delta < 0 || (delta === 0 && activity <= previous.activity)) continue;
    }
    latest.set(vnum, { properties, position, start, activity });
  }
  const features = [];
  for (const [vnum, { properties, position, start }] of latest) {
    const eruptionStart = startIso(start);
    features.push({
      type: 'Feature',
      id: String(vnum),
      geometry: { type: 'Point', coordinates: position },
      properties: {
        name: text(properties.VolcanoName),
        vnum,
        eruption: true,
        vei: integerIn(properties.ExplosivityIndexMax, 0, 8),
        eruptionStart,
        eruptionStartYear: start.year,
        url: gvpVolcanoUrl(vnum),
        // GVP has no update time: the eruption's start is the only date.
        timestamp: eruptionStart,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Upper-case a short label (alert level, color code), or null. */
function label(value) {
  const cleaned = text(value, 24);
  return cleaned && /^[A-Za-z][A-Za-z _-]*$/.test(cleaned)
    ? cleaned.toUpperCase()
    : null;
}

/** The time of a USGS notice id ("DOI-USGS-AVO-2026-10-24T17:32:14+00:00"), or null. */
function noticeTime(noticeId) {
  const match =
    typeof noticeId === 'string' ? NOTICE_TIME.exec(noticeId) : null;
  return match ? toIsoTimestamp(match[1]) : null;
}

/**
 * Normalize the USGS Volcano Hazards Program status list into one point per
 * volcano with an elevated alert level.
 *
 * Only ADVISORY, WATCH and WARNING volcanoes are kept; NORMAL (green) and
 * UNASSIGNED (not monitored) are skipped unless `includeNormal` asks for the
 * NORMAL ones. The synopsis loses the "AVO Great Sitkin ORANGE/WATCH - "
 * prefix that repeats the level and color. The feature id is the GVP volcano
 * number (`vnum`), or `cd-<volcanoCd>` for a volcano without one.
 * @param {Array<Object>} payload - The status list.
 * @param {{includeNormal?: boolean}} [options]
 * @returns {{type: 'FeatureCollection', features: Array<Object>}}
 * @throws When the payload is not a non-empty array (USGS always lists its
 *   monitored volcanoes, so an empty list means a broken feed).
 */
export function normalizeUsgsStatus(payload, { includeNormal = false } = {}) {
  if (!Array.isArray(payload) || !payload.length)
    throw invalidPayload('USGS payload is not a volcano status list');
  const byId = new Map();
  for (const volcano of payload) {
    if (!isObject(volcano)) continue;
    const alertLevel = label(volcano.alertLevel);
    if (!alertLevel || alertLevel === 'UNASSIGNED') continue;
    if (alertLevel === 'NORMAL' && !includeNormal) continue;
    const position = [volcano.long, volcano.lat];
    if (!isValidPosition(position)) continue;
    const vnum = volcanoNumber(volcano.vnum);
    const code =
      typeof volcano.volcanoCd === 'string' &&
      /^[a-z0-9]{2,16}$/i.test(volcano.volcanoCd)
        ? volcano.volcanoCd.toLowerCase()
        : null;
    const id = vnum != null ? String(vnum) : code ? `cd-${code}` : null;
    if (!id || byId.has(id)) continue;
    const color = label(volcano.colorCode);
    const alertDate = toIsoTimestamp(volcano.alertDate);
    const observatory = text(volcano.obs, 8);
    byId.set(id, {
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: position },
      properties: {
        name: text(volcano.vName),
        vnum,
        alertLevel,
        colorCode: AVIATION_COLOR_CODES.includes(color) ? color : null,
        observatory:
          observatory && OBSERVATORY_CODE.test(observatory)
            ? observatory.toUpperCase()
            : null,
        region: text(volcano.region),
        synopsis: text(
          text(volcano.noticeSynopsis, 1000)?.replace(SYNOPSIS_PREFIX, ''),
          MAX_SYNOPSIS,
        ),
        alertDate,
        url: httpsLink(volcano.vUrl, USGS_LINK_HOSTS),
        timestamp: noticeTime(volcano.noticeId) ?? alertDate,
      },
    });
  }
  return { type: 'FeatureCollection', features: [...byId.values()] };
}

const SOURCE_IDS = Object.freeze(['gvp', 'usgs']);

/**
 * Join the GVP and USGS features of the proxy response into one feature per
 * volcano. Runs after the kit has prefixed ids (`gvp:332010`, `usgs:332010`)
 * and stamped `properties.source`; it is the kit's `combine` hook.
 *
 * - A volcano in both becomes one feature, `source: 'gvp+usgs'`, carrying the
 *   USGS alert fields and the GVP eruption fields; the point is GVP's.
 * - The feature id is `volcano:<key>` whichever feeds supply it, so an open
 *   card survives one feed dropping out and returning.
 * - The link prefers the USGS page (live status) and falls back to GVP's.
 * - `timestamp` is the USGS notice time when there is one, else the eruption
 *   start.
 * Pure: the input features are not changed.
 * @param {Array<Object>} features - Stamped features from both subsources.
 * @returns {Array<Object>}
 */
export function mergeVolcanoFeatures(features) {
  const groups = new Map();
  for (const feature of features) {
    const source = feature?.properties?.source;
    if (!SOURCE_IDS.includes(source) || typeof feature.id !== 'string')
      continue;
    const key = feature.id.slice(source.length + 1);
    if (!key) continue;
    const group = groups.get(key) || { gvp: null, usgs: null };
    group[source] = feature;
    groups.set(key, group);
  }
  const merged = [];
  for (const [key, { gvp, usgs }] of groups) {
    const base = gvp || usgs;
    const g = gvp?.properties;
    const u = usgs?.properties;
    const vnum = g?.vnum ?? u?.vnum ?? null;
    merged.push({
      type: 'Feature',
      id: `volcano:${key}`,
      geometry: base.geometry,
      properties: {
        layer: base.properties.layer,
        source: [gvp && 'gvp', usgs && 'usgs'].filter(Boolean).join('+'),
        name: g?.name ?? u?.name ?? null,
        vnum,
        eruption: Boolean(gvp),
        vei: g?.vei ?? null,
        eruptionStart: g?.eruptionStart ?? null,
        eruptionStartYear: g?.eruptionStartYear ?? null,
        alertLevel: u?.alertLevel ?? null,
        colorCode: u?.colorCode ?? null,
        observatory: u?.observatory ?? null,
        region: u?.region ?? null,
        synopsis: u?.synopsis ?? null,
        alertDate: u?.alertDate ?? null,
        url: u?.url ?? g?.url ?? (vnum != null ? gvpVolcanoUrl(vnum) : null),
        gvpUrl: g?.url ?? null,
        usgsUrl: u?.url ?? null,
        timestamp: u?.timestamp ?? g?.timestamp ?? null,
      },
    });
  }
  return merged;
}
