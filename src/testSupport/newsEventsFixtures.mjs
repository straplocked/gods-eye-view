// Hand-written GDELT GKG 2.1 fixtures modeled on a real 15-minute batch
// (20261025084500). Not a test file: the unit runner only collects *.test.mjs.
// Values are small and made up; the shapes (27 tab-separated columns, location
// blocks of nine '#' fields, V2Tone, ExtrasXML) are the real ones.
import { createHash } from 'node:crypto';
import { buildZip } from './zip.mjs';

/** 2026-10-25T09:00:00.000Z, fifteen minutes after the batch below. */
export const NOW_MS = Date.UTC(2026, 9, 25, 9, 0, 0);
/** The batch time the pointer names. */
export const BATCH = '20261025084500';

/**
 * One GKG 2.1 line. Columns not named here are empty, like most real ones.
 * @param {Object} fields
 * @returns {string}
 */
export function gkgLine({
  id = '20261025084500-0',
  date = BATCH,
  source = 'example-daily.com',
  url = 'https://example-daily.com/story',
  themes = '',
  locations = '',
  tone = '0,1,1,2,10,0,500',
  extras = '',
} = {}) {
  const columns = new Array(27).fill('');
  columns[0] = id;
  columns[1] = date;
  columns[2] = '1';
  columns[3] = source;
  columns[4] = url;
  columns[7] = themes;
  columns[10] = locations;
  columns[15] = tone;
  columns[26] = extras;
  return columns.join('\t');
}

export const LUCKNOW =
  '4#Lucknow, Uttar Pradesh, India#IN#IN36#17941#26.85#80.9167#-2102835#5487';
export const BALLIA =
  '4#Ballia, Bihar, India#IN#IN34#17895#25.75#84.1667#-2089956#900';
export const INDIA = '1#India#IN#IN##20#77#IN#212';
export const KYIV =
  "4#Kyiv, Kyyivs'ka Oblast', Ukraine#UP#UP12#17901#50.4333#30.5167#-1044367#100";
export const BRAZIL = '1#Brazil#BR#BR##-10#-55#BR#10';
export const CHICAGO =
  '3#Chicago, Illinois, United States#US#USIL#17031#41.85#-87.65#423587#30';

const title = (text, published = '') =>
  `${published ? `<PAGE_PRECISEPUBTIMESTAMP>${published}</PAGE_PRECISEPUBTIMESTAMP>` : ''}<PAGE_TITLE>${text}</PAGE_TITLE>`;

/** A hand-written batch: good records, a country-only one and several corrupt lines. */
export function batchLines() {
  return [
    // Two places in India (the country mention is dropped), a publisher time
    // before the batch, an encoded ampersand in the title, plain themes.
    gkgLine({
      id: '20261025084500-0',
      source: 'example-daily.com',
      url: 'https://example-daily.com/politics/poster-war',
      themes:
        'ELECTION;TAX_FNCACT;EPU_POLICY;WB_696_PUBLIC_SECTOR_MANAGEMENT;LEADER;',
      locations: [LUCKNOW, INDIA, BALLIA].join(';'),
      tone: '-0.32,2.65,2.97,5.63,20.03,0.24,1119',
      extras: title(
        'Poster War &amp; More: UP Heads to the Polls',
        '20261025072900',
      ),
    }),
    // A second Lucknow article: http link, conflict themes, no title.
    gkgLine({
      id: '20261025084500-1',
      date: '20261025083000',
      source: 'city-news.example',
      url: 'http://city-news.example/lucknow/clash',
      themes: 'ARMEDCONFLICT;KILL;PROTEST;TAX_TERROR_GROUP_FRONT;',
      locations: LUCKNOW,
      tone: '-6.5,1,7.5,8.5,22,1,640',
    }),
    // Kyiv: conflict, three themes that are shown.
    gkgLine({
      id: '20261025084500-2',
      source: 'wire.example',
      url: 'https://wire.example/world/kyiv-strikes',
      themes: 'ARMEDCONFLICT;MILITARY;NATURAL_DISASTER;',
      locations: KYIV,
      tone: '-8.1,0.5,8.6,9.1,25,0.4,900',
      extras: title('Overnight strikes hit Kyiv', '20261025081500'),
    }),
    // A country-only mention stays a country point.
    gkgLine({
      id: '20261025084500-3',
      source: 'sport.example',
      url: 'https://sport.example/football/brazil-squad',
      themes: 'EDUCATION;',
      locations: BRAZIL,
      tone: '3.4,5,1.6,6.6,18,0.2,400',
      extras: title('Brazil names its squad'),
    }),
    // No location at all: counted as a record, not mapped.
    gkgLine({
      id: '20261025084500-4',
      source: 'tech.example',
      url: 'https://tech.example/gadgets',
      themes: 'EPU_POLICY;',
      locations: '',
    }),
    // Corrupt lines: too few columns, no usable URL, an impossible batch time.
    'only\tfive\tcolumns\tin\tthis line',
    gkgLine({ id: 'x-1', url: 'not a url', locations: CHICAGO }),
    gkgLine({ id: 'x-2', date: '20261325084500', locations: CHICAGO }),
    // Bad location blocks: no coordinates, 0,0, a wrong field count; the good
    // block in the same record still counts.
    gkgLine({
      id: '20261025084500-5',
      source: 'local.example',
      url: 'https://local.example/chicago/council',
      themes: 'LEGISLATION;',
      locations: [
        '4#Nowhere#XX#XX00#0#0#0#-1#1',
        '4#Nullville#XX#XX00#0##5#-2#1',
        'not a block',
        CHICAGO,
      ].join(';'),
      tone: 'oops',
      extras: title('Council votes'),
    }),
  ].join('\n');
}

/** The GKG CSV for {@link batchLines}, with the file's trailing newline. */
export const batchCsv = () => `${batchLines()}\n`;

/** lastupdate.txt for a zip: export, mentions and GKG lines, as GDELT writes them. */
export function pointerText({
  stamp = BATCH,
  size = 1234,
  md5 = '0123456789abcdef0123456789abcdef',
} = {}) {
  return [
    `29512 e0f841bc36590ebacbecaa045b0e6c2d http://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`,
    `34309 569c30bbdc93a15fe46830f4f17d70a2 http://data.gdeltproject.org/gdeltv2/${stamp}.mentions.CSV.zip`,
    `${size} ${md5} http://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`,
    '',
  ].join('\n');
}

/** A real zip of a CSV plus the pointer text that matches it. */
export function batchZip(csv = batchCsv(), stamp = BATCH) {
  const zip = buildZip(`${stamp}.gkg.csv`, csv);
  const md5 = createHash('md5').update(zip).digest('hex');
  return { zip, md5, pointer: pointerText({ stamp, size: zip.length, md5 }) };
}
