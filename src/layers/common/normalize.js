/**
 * Small value helpers shared by the keyless-feed normalizers
 * (src/layers/<name>/records.js).
 *
 * Pure and portable like geojson.js: the server kit, portable sources and
 * tests all load the normalizers, so nothing here may import Node, DOM or
 * Cesium modules.
 * @module layers/common/normalize
 */

/** Longest link a normalizer passes on to a click card. */
const MAX_LINK_LENGTH = 2048;

/**
 * An error marking a corrupt or non-collection upstream payload. Normalizers
 * cannot import the server kit, so they use the plain `code` that
 * keylessErrorCode() maps to the client-safe `invalid_payload`.
 * @param {string} detail - Server-log detail; never sent to clients.
 * @returns {Error & {code: 'invalid_payload'}}
 */
export function invalidPayload(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

/**
 * A finite number from a JSON number or a non-blank numeric string, else null.
 * @param {unknown} value
 * @returns {?number}
 */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The normalized href of an https link without credentials, or null.
 * `hosts` limits the link to exact host names (an array) or to host names a
 * RegExp accepts; omit it to accept any host.
 * @param {unknown} value
 * @param {?(string[]|RegExp)} [hosts]
 * @returns {?string}
 */
export function httpsLink(value, hosts = null) {
  if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (Array.isArray(hosts) && !hosts.includes(url.hostname)) return null;
  if (hosts instanceof RegExp && !hosts.test(url.hostname)) return null;
  return url.href;
}
