/**
 * Pure normalizers for Geolocated News (GDELT): the 15-minute "last update"
 * pointer and the GDELT 2.0 Global Knowledge Graph (GKG 2.1) tab-delimited
 * records. Shared by the keyless proxy (server/providers/newsEvents.js) and
 * the tests; portable, no Node, Cesium or DOM imports. The zip download, the
 * md5 check and the inflate step live on the server.
 *
 * GKG 2.1 has 27 tab-separated columns per record and no header row. Columns
 * used here (0-based): 1 DATE (YYYYMMDDHHMMSS UTC), 3 SourceCommonName,
 * 4 DocumentIdentifier (the article URL), 7 V1 Themes, 10 V2EnhancedLocations,
 * 15 V2Tone, 26 ExtrasXML. A location block is
 * `Type#FullName#CountryCode#ADM1#ADM2#Lat#Long#FeatureID#CharOffset`
 * (Type 1 country, 2 US state, 3 US city, 4 world city, 5 world state; the
 * country code is FIPS 10-4, not ISO). GKG carries no article text: the
 * headline is `PAGE_TITLE` from the extras, the tone is the first value of
 * V2Tone. Records are aggregated by place into one point each.
 * @module layers/newsEvents/records
 */

import { invalidPayload } from '../common/normalize.js';

/** Layer id and route suffix. */
export const NEWS_EVENTS_LAYER_ID = 'news-events';

/** The pointer to the newest 15-minute batch (https; the http URL redirects). */
export const GDELT_LASTUPDATE_URL =
  'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';

/** Hard caps on the batch zip and on the inflated CSV. */
export const GDELT_MAX_ZIP_BYTES = 10 * 1024 * 1024;
export const GDELT_MAX_CSV_BYTES = 80 * 1024 * 1024;

/** Locations served: the busiest places by article count. */
export const NEWS_MAX_LOCATIONS = 2000;

/** Most recent articles kept per place, and top themes. */
export const MAX_ARTICLES = 5;
export const MAX_THEMES = 5;

/** A place is a conflict place when this share of its articles has conflict themes. */
const CONFLICT_SHARE = 0.25;

/** A record contributes to at most this many distinct places. */
const MAX_LOCATIONS_PER_RECORD = 20;
const GKG_COLUMNS = 27;
const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 200;
const MAX_NAME_LENGTH = 120;
const MAX_SOURCE_LENGTH = 80;

const HOUR_MS = 3_600_000;

/** Themes that mark a report as conflict, unrest or security related. */
const CONFLICT_THEMES = new Set([
  'ARMEDCONFLICT',
  'KILL',
  'TERROR',
  'PROTEST',
  'MILITARY',
  'REBELS',
  'REBELLION',
  'CEASEFIRE',
  'SEIGE',
  'ASSASSINATION',
  'WB_2433_CONFLICT_AND_VIOLENCE',
  'WB_2462_POLITICAL_VIOLENCE_AND_WAR',
  'WB_2468_CONVENTIONAL_WAR',
]);
const CONFLICT_THEME_PREFIXES = ['TAX_TERROR_GROUP'];

/** Taxonomy families that make poor card text (GDELT's thousands of TAX_/WB_ codes). */
const TAXONOMY_PREFIXES = [
  'TAX_',
  'WB_',
  'EPU_',
  'USPEC_',
  'CRISISLEX_',
  'SOC_',
  'MEDIA_',
  'GENERAL_',
  'UNGP_',
  'SLFID_',
  'ECON_',
  'ENV_',
  'MANMADE_',
];
/** Themes too vague to show. */
const VAGUE_THEMES = new Set(['AFFECT', 'LEADER', 'DELAY', 'GEN_HOLIDAY']);

const THEME_LABELS = Object.freeze({
  ARMEDCONFLICT: 'Armed conflict',
  KILL: 'Killings',
  TERROR: 'Terrorism',
  PROTEST: 'Protest',
  MILITARY: 'Military',
  REBELS: 'Rebels',
  REBELLION: 'Rebellion',
  CEASEFIRE: 'Ceasefire',
  SEIGE: 'Siege',
});

const THEME_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const FEATURE_ID = /^[A-Za-z0-9_.-]{1,24}$/;

const isConflictTheme = (theme) =>
  CONFLICT_THEMES.has(theme) ||
  CONFLICT_THEME_PREFIXES.some((prefix) => theme.startsWith(prefix));

const isDisplayTheme = (theme) =>
  !VAGUE_THEMES.has(theme) &&
  !TAXONOMY_PREFIXES.some((prefix) => theme.startsWith(prefix));

/** "NATURAL_DISASTER" to "Natural disaster"; the conflict flags have fixed labels. */
export function themeLabel(theme) {
  if (Object.hasOwn(THEME_LABELS, theme)) return THEME_LABELS[theme];
  const text = theme.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Strip control characters, collapse whitespace and clip to a length. */
function cleanText(value, limit) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, limit).join('');
}

/** Decode the few XML entities GDELT writes inside PAGE_TITLE. */
function decodeEntities(text) {
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g,
    (match, decimal, hex, named) => {
      if (named)
        return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named];
      const code = decimal ? Number(decimal) : parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ' ';
    },
  );
}

/** `YYYYMMDDHHMMSS` (UTC) to epoch milliseconds, or null when not a real time. */
export function parseGdeltTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  return Number.isFinite(ms) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour
    ? ms
    : null;
}

/** GDELT publishes a batch on every quarter hour. */
export const GDELT_BATCH_MS = 15 * 60_000;

/**
 * The batch time `slots` quarter hours before `stamp`, as a 14-digit stamp, or
 * null when `stamp` is not a real batch time.
 * @param {string} stamp - `YYYYMMDDHHMMSS`.
 * @param {number} slots
 * @returns {string|null}
 */
export function earlierBatchStamp(stamp, slots) {
  const ms = parseGdeltTime(stamp);
  if (ms == null) return null;
  return new Date(ms - slots * GDELT_BATCH_MS)
    .toISOString()
    .replace(/\D/g, '')
    .slice(0, 14);
}

/**
 * Read GDELT's `lastupdate.txt`: three lines `<size> <md5> <url>` for the
 * export, mentions and GKG files of the newest batch. Only the GKG line is
 * used, and only its batch time, size and md5: the download URL is rebuilt
 * from the 14-digit batch time on the fixed GDELT host, never taken from the
 * text.
 * @param {string} text
 * @returns {{stamp: string, size: number, md5: string, url: string}}
 * @throws {Error} `code: 'invalid_payload'` without a well-formed GKG line.
 */
export function parseGdeltPointer(text) {
  if (typeof text !== 'string') throw invalidPayload('pointer is not text');
  for (const line of text.split(/\r?\n/)) {
    const match =
      /^(\d{1,9}) ([0-9a-f]{32}) https?:\/\/data\.gdeltproject\.org(?::443)?\/gdeltv2\/(\d{14})\.gkg\.csv\.zip$/.exec(
        line.trim(),
      );
    if (!match) continue;
    const stamp = match[3];
    if (parseGdeltTime(stamp) == null)
      throw invalidPayload('pointer batch time is not a date');
    return {
      stamp,
      size: Number(match[1]),
      md5: match[2],
      url: `https://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`,
    };
  }
  throw invalidPayload('pointer has no GKG line');
}

/**
 * One location block to `{type, name, countryCode, lat, lon, featureId}`, or
 * null when it is malformed: not nine `#` fields, a type outside 1-5, no
 * name, coordinates that are not plain numbers inside WGS84, or 0,0.
 */
export function parseLocationBlock(block) {
  const fields = block.split('#');
  if (fields.length !== 9) return null;
  const [type, fullName, countryCode, , , latText, lonText, featureId] = fields;
  if (!/^[1-5]$/.test(type)) return null;
  if (!NUMBER_TEXT.test(latText) || !NUMBER_TEXT.test(lonText)) return null;
  const lat = Number(latText);
  const lon = Number(lonText);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  if (lat === 0 && lon === 0) return null;
  const name = cleanText(fullName, MAX_NAME_LENGTH);
  if (!name) return null;
  return {
    type: Number(type),
    name,
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    featureId: FEATURE_ID.test(featureId) ? featureId : null,
  };
}

/**
 * The places of one record: distinct, with a country-level mention dropped
 * when the same record names a state or city in that country (the article is
 * about the more specific place), at most 20. Malformed blocks are skipped
 * one by one and counted in `skipped`.
 */
function recordPlaces(field) {
  const places = new Map();
  let skipped = 0;
  for (const block of String(field).split(';')) {
    if (!block) continue;
    const place = parseLocationBlock(block);
    if (!place) {
      skipped++;
      continue;
    }
    const key = place.featureId ?? `ll_${place.lat}_${place.lon}`;
    if (!places.has(key)) places.set(key, { ...place, key });
  }
  const specific = new Set(
    [...places.values()]
      .filter((place) => place.type !== 1 && place.countryCode)
      .map((place) => place.countryCode),
  );
  const kept = [...places.values()].filter(
    (place) =>
      !(
        place.type === 1 &&
        place.countryCode &&
        specific.has(place.countryCode)
      ),
  );
  return { places: kept.slice(0, MAX_LOCATIONS_PER_RECORD), skipped };
}

/** First V2Tone value (the average tone), or null. */
function parseTone(field) {
  const first = String(field).split(',')[0];
  if (!NUMBER_TEXT.test(first)) return null;
  const tone = Number(first);
  return Math.abs(tone) <= 100 ? Math.round(tone * 100) / 100 : null;
}

/** An article URL as `{key, https}`: key identifies it, https is the link or null. */
function parseArticleUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return { key: url.href, https: url.protocol === 'https:' ? url.href : null };
}

/** Headline and publication time from ExtrasXML (both optional). */
function parseExtras(field) {
  const text = String(field ?? '');
  const title = /<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/.exec(text);
  const published = /<PAGE_PRECISEPUBTIMESTAMP>(\d{14})</.exec(text);
  return {
    title: title
      ? cleanText(decodeEntities(title[1]), MAX_TITLE_LENGTH) || null
      : null,
    publishedMs: published ? parseGdeltTime(published[1]) : null,
  };
}

/**
 * One GKG line to `{url, source, title, tone, dateMs, themes, places,
 * skippedBlocks}`, or null for a corrupt line (wrong column count, no usable
 * article URL, or no valid batch time). Records with no usable location
 * yield an empty `places` and are not aggregated.
 */
function parseRecord(line, nowMs) {
  const columns = line.split('\t');
  if (columns.length !== GKG_COLUMNS) return null;
  const article = parseArticleUrl(columns[4]);
  if (!article) return null;
  const batchMs = parseGdeltTime(columns[1]);
  if (batchMs == null || batchMs > nowMs + HOUR_MS) return null;
  const extras = parseExtras(columns[26]);
  // The publisher's own time wins when it is plausible: not after the batch.
  const dateMs =
    extras.publishedMs != null && extras.publishedMs <= batchMs + HOUR_MS
      ? extras.publishedMs
      : batchMs;
  let source = cleanText(columns[3], MAX_SOURCE_LENGTH);
  if (!source) source = new URL(article.key).hostname;
  const themes = new Set(
    columns[7].split(';').filter((theme) => THEME_CODE.test(theme)),
  );
  const { places, skipped } = recordPlaces(columns[10]);
  return {
    article: {
      key: article.key,
      url: article.https,
      source,
      title: extras.title,
      tone: parseTone(columns[15]),
      dateMs,
    },
    themes,
    places,
    skippedBlocks: skipped,
  };
}

/** "Springfield, Illinois, United States" to "United States"; a country is itself. */
function countryOf(place) {
  if (place.type === 1) return place.name;
  const parts = place.name.split(',');
  return parts.length > 1 ? parts[parts.length - 1].trim() || null : null;
}

const PRECISION = {
  1: 'country',
  2: 'state',
  3: 'city',
  4: 'city',
  5: 'state',
};

/**
 * Aggregate GKG 2.1 records by place into a FeatureCollection of points.
 *
 * Each point is one place (GDELT FeatureID, else the rounded coordinates)
 * with `articleCount` (distinct articles naming it), the mean tone of those
 * articles, `conflictCount` (articles with a conflict, unrest or terror
 * theme) and `conflict` (a quarter or more of them), up to five `themes` and up to five of the most recent
 * `articles` `{url, source, title, tone, date}` (`url` is an https link or
 * null). Features are sorted busiest first (then conflict, then newest), all
 * of them; the proxy applies the {@link NEWS_MAX_LOCATIONS} cap and reports
 * the cut as `truncated`. Corrupt lines and malformed location blocks are
 * skipped, never fatal. `details` carries the batch time and line counts.
 *
 * @param {string} text - The GKG CSV (tab-delimited, no header).
 * @param {{nowMs: number, batch?: string}} options - `batch` is the 14-digit
 *   batch time from the pointer.
 * @returns {{type: 'FeatureCollection', features: Array<Object>, details: Object}}
 * @throws {Error} `code: 'invalid_payload'` when no line is a readable GKG
 *   record (an empty or non-GKG body).
 */
export function normalizeGkg(text, { nowMs, batch = null } = {}) {
  if (typeof text !== 'string') throw invalidPayload('GKG body is not text');
  if (!Number.isFinite(nowMs)) throw new TypeError('normalizeGkg needs nowMs');
  const lines = text.split('\n');
  const groups = new Map();
  let records = 0;
  let corruptLines = 0;
  let skippedBlocks = 0;
  let geolocated = 0;
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;
    const record = parseRecord(line, nowMs);
    if (!record) {
      corruptLines++;
      continue;
    }
    records++;
    skippedBlocks += record.skippedBlocks;
    if (!record.places.length) continue;
    geolocated++;
    const conflict = [...record.themes].some(isConflictTheme);
    const shownThemes = [...record.themes].filter(isDisplayTheme);
    for (const place of record.places) {
      let group = groups.get(place.key);
      if (!group) {
        group = {
          key: place.key,
          place,
          articles: new Map(),
          themeCounts: new Map(),
          conflictCount: 0,
        };
        groups.set(place.key, group);
      }
      // An article counts once per place, however often the place is named.
      if (group.articles.has(record.article.key)) continue;
      group.articles.set(record.article.key, record.article);
      if (conflict) group.conflictCount++;
      for (const theme of shownThemes)
        group.themeCounts.set(theme, (group.themeCounts.get(theme) || 0) + 1);
    }
  }
  // A batch is never empty: no readable record means a broken file, which
  // must not be cached as "no news".
  if (!records) throw invalidPayload('no GKG record in the batch');

  const features = [...groups.values()].map((group) => {
    const articles = [...group.articles.values()].sort(
      (a, b) => b.dateMs - a.dateMs || a.key.localeCompare(b.key),
    );
    const tones = articles.map((a) => a.tone).filter((tone) => tone != null);
    const themes = [...group.themeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_THEMES)
      .map(([theme]) => themeLabel(theme));
    const { place } = group;
    return {
      type: 'Feature',
      id: group.key,
      geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
      properties: {
        name: place.name,
        country: countryOf(place),
        countryCode: place.countryCode,
        precision: PRECISION[place.type],
        articleCount: articles.length,
        tone: tones.length
          ? Math.round(
              (tones.reduce((sum, tone) => sum + tone, 0) / tones.length) * 100,
            ) / 100
          : null,
        conflict: group.conflictCount / articles.length >= CONFLICT_SHARE,
        conflictCount: group.conflictCount,
        themes,
        articles: articles.slice(0, MAX_ARTICLES).map((article) => ({
          url: article.url,
          source: article.source,
          title: article.title,
          tone: article.tone,
          date: new Date(article.dateMs).toISOString(),
        })),
        timestamp: new Date(articles[0].dateMs).toISOString(),
      },
    };
  });
  features.sort(
    (a, b) =>
      b.properties.articleCount - a.properties.articleCount ||
      b.properties.conflictCount - a.properties.conflictCount ||
      Date.parse(b.properties.timestamp) - Date.parse(a.properties.timestamp) ||
      a.id.localeCompare(b.id),
  );
  const batchMs = parseGdeltTime(batch);
  return {
    type: 'FeatureCollection',
    features,
    details: {
      ...(batchMs == null ? {} : { batch: new Date(batchMs).toISOString() }),
      records,
      geolocated,
      locations: features.length,
      corruptLines,
      skippedBlocks,
    },
  };
}
