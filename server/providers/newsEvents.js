import { createHash } from 'node:crypto';
import {
  GDELT_LASTUPDATE_URL,
  GDELT_MAX_CSV_BYTES,
  GDELT_MAX_ZIP_BYTES,
  NEWS_EVENTS_LAYER_ID,
  NEWS_MAX_LOCATIONS,
  earlierBatchStamp,
  normalizeGkg,
  parseGdeltPointer,
} from '../../src/layers/newsEvents/records.js';
import {
  KeylessFeedError,
  createKeylessFeedProxy,
} from './common/keylessFeed.js';
import { readSingleEntryZip } from './common/zip.js';

/**
 * How many earlier quarter-hour batches are tried when the one the pointer
 * names has no file yet. GDELT's pointer has been seen naming a batch (and
 * the ones before it, for an hour) that answered 404 for every file.
 */
const MAX_EARLIER_BATCHES = 6;

const batchUrl = (stamp) =>
  `https://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`;

/**
 * Fetch GDELT's newest GKG batch: read the pointer, download the ~2 MB zip it
 * names, check its size and md5 against the pointer, inflate its single CSV
 * under hard caps and aggregate it by place. Only data.gdeltproject.org is
 * ever contacted, and the zip URL is rebuilt from a 14-digit batch time
 * rather than taken from the pointer's text.
 *
 * If the named file is not there (404), up to six earlier quarter-hour
 * batches are tried, newest first. The pointer carries no md5 for those, so
 * they are checked by the zip's own CRC-32 and size caps only, and the
 * snapshot says `md5Verified: false` and which `batch` it is.
 *
 * A batch already served is reused instead of downloaded again (GDELT's
 * pointer often names the same batch for a while, and a fallback batch stays
 * the answer until a newer file appears), so an idle pointer costs a 200-byte
 * request, not a 2 MB download. The memo is per proxy instance and only ever
 * holds a snapshot that passed every check.
 */
function createGdeltFetcher() {
  /** @type {?{stamp: string, md5: ?string, collection: Object}} */
  let last = null;
  return async function fetchGdelt({ fetchText, fetchBytes, now }) {
    const pointer = parseGdeltPointer(
      await fetchText(GDELT_LASTUPDATE_URL, { maxBytes: 16 * 1024 }),
    );
    if (pointer.size > GDELT_MAX_ZIP_BYTES)
      throw Object.assign(new Error('pointer names an oversized zip'), {
        code: 'RESPONSE_TOO_LARGE',
      });
    for (let back = 0; back <= MAX_EARLIER_BATCHES; back++) {
      const stamp = back
        ? earlierBatchStamp(pointer.stamp, back)
        : pointer.stamp;
      if (
        last &&
        last.stamp === stamp &&
        (back > 0 || last.md5 === pointer.md5)
      )
        return last.collection;
      const zip = await fetchBytes(batchUrl(stamp), {
        maxBytes: GDELT_MAX_ZIP_BYTES,
        emptyStatuses: [404],
      });
      if (!zip) continue;
      if (back === 0) {
        if (zip.byteLength !== pointer.size)
          throw new KeylessFeedError(
            'invalid_payload',
            `GDELT zip is ${zip.byteLength} bytes, pointer says ${pointer.size}`,
          );
        const md5 = createHash('md5').update(zip).digest('hex');
        if (md5 !== pointer.md5)
          throw new KeylessFeedError(
            'invalid_payload',
            'GDELT zip md5 does not match the pointer',
          );
      }
      const { name, data } = readSingleEntryZip(zip, {
        maxCompressedBytes: GDELT_MAX_ZIP_BYTES,
        maxUncompressedBytes: GDELT_MAX_CSV_BYTES,
      });
      if (!/\.gkg\.csv$/i.test(name))
        throw new KeylessFeedError(
          'invalid_payload',
          'GDELT zip does not hold a GKG CSV',
        );
      const normalized = normalizeGkg(data.toString('utf8'), {
        nowMs: now(),
        batch: stamp,
      });
      const collection = {
        ...normalized,
        details: { ...normalized.details, md5Verified: back === 0 },
      };
      last = { stamp, md5: back === 0 ? pointer.md5 : null, collection };
      return collection;
    }
    throw new KeylessFeedError(
      'upstream_status',
      'GDELT has no file for the pointed batch or the earlier ones',
    );
  };
}

/**
 * Keyless route at /api/v1/layers/news-events: the newest GDELT 2.0 Global
 * Knowledge Graph batch as one point per geocoded place (article count, mean
 * tone, conflict flag, top themes and the five most recent articles). The
 * busiest 2,000 places are served; the rest are reported as `truncated`.
 */
export function newsEventsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return createKeylessFeedProxy({
    name: 'news-events',
    layerId: NEWS_EVENTS_LAYER_ID,
    fetchImpl,
    now,
    maxFeatures: NEWS_MAX_LOCATIONS,
    subsources: [
      // GDELT publishes a batch every 15 minutes. The refresh covers the
      // pointer, a ~2 MB download and inflating ~6 MB, hence the long timeout.
      {
        id: 'gdelt',
        ttlMs: 15 * 60_000,
        timeoutMs: 60_000,
        fetchSnapshot: createGdeltFetcher(),
      },
    ],
  });
}
