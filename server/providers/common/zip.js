/**
 * Minimal, defensive reader for a ZIP archive that holds exactly one file.
 *
 * GDELT publishes each 15-minute batch as a single-entry `.zip`. This reads
 * the central directory, inflates the entry with `node:zlib` (no dependency)
 * and refuses anything unexpected: more than one entry, encryption, ZIP64,
 * a method other than stored/deflate, a compressed or uncompressed size over
 * the caller's caps, or a CRC-32 that does not match. The entry name is only
 * reported, never used as a path.
 * @module server/providers/common/zip
 */
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const CENTRAL_MIN = 46;
const LOCAL_MIN = 30;
/** The EOCD record may be followed by a comment of at most 65,535 bytes. */
const EOCD_SEARCH = EOCD_MIN + 0xffff;

/**
 * A zip that cannot be read safely. `code` is `invalid_payload` (corrupt or
 * unsupported) or `RESPONSE_TOO_LARGE` (over a size cap), the two codes the
 * keyless kit already maps to client-safe errors.
 */
export class ZipError extends Error {
  /**
   * @param {'invalid_payload'|'RESPONSE_TOO_LARGE'} code
   * @param {string} detail Server-log detail; never sent to clients.
   */
  constructor(code, detail) {
    super(detail);
    this.name = 'ZipError';
    this.code = code;
  }
}

const invalid = (detail) => new ZipError('invalid_payload', detail);
const tooLarge = (detail) => new ZipError('RESPONSE_TOO_LARGE', detail);

function findEndOfCentralDirectory(view, length) {
  const lowest = Math.max(0, length - EOCD_SEARCH);
  for (let at = length - EOCD_MIN; at >= lowest; at--) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    // The comment must run exactly to the end of the file.
    if (at + EOCD_MIN + view.getUint16(at + 20, true) === length) return at;
  }
  throw invalid('zip end-of-central-directory record not found');
}

/**
 * Extract the only entry of a ZIP archive.
 * @param {Uint8Array} bytes - The whole archive.
 * @param {{maxCompressedBytes: number, maxUncompressedBytes: number}} limits
 * @returns {{name: string, data: Buffer}} The entry name and its inflated bytes.
 * @throws {ZipError}
 */
export function readSingleEntryZip(
  bytes,
  { maxCompressedBytes, maxUncompressedBytes },
) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < EOCD_MIN)
    throw invalid('not a zip archive');
  if (bytes.byteLength > maxCompressedBytes)
    throw tooLarge('zip over the compressed cap');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== entries
  )
    throw invalid('multi-disk zip');
  if (
    entries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw invalid('zip64 archives are not supported');
  if (entries !== 1) throw invalid(`zip holds ${entries} entries, expected 1`);
  if (
    directoryOffset + CENTRAL_MIN > eocd ||
    directoryOffset + directorySize > eocd
  )
    throw invalid('zip central directory out of range');

  const central = directoryOffset;
  if (view.getUint32(central, true) !== CENTRAL_SIGNATURE)
    throw invalid('zip central directory entry missing');
  const flags = view.getUint16(central + 8, true);
  const method = view.getUint16(central + 10, true);
  const expectedCrc = view.getUint32(central + 16, true);
  const compressedSize = view.getUint32(central + 20, true);
  const uncompressedSize = view.getUint32(central + 24, true);
  const nameLength = view.getUint16(central + 28, true);
  const localOffset = view.getUint32(central + 42, true);
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
    throw invalid('zip64 archives are not supported');
  if (flags & 0x1 || flags & 0x40) throw invalid('encrypted zip entry');
  if (method !== 0 && method !== 8)
    throw invalid(`zip compression method ${method} is not supported`);
  if (compressedSize > maxCompressedBytes)
    throw tooLarge('zip entry over the compressed cap');
  if (uncompressedSize > maxUncompressedBytes)
    throw tooLarge('zip entry over the uncompressed cap');
  if (central + CENTRAL_MIN + nameLength > eocd)
    throw invalid('zip entry name out of range');
  const name = new TextDecoder().decode(
    bytes.subarray(central + CENTRAL_MIN, central + CENTRAL_MIN + nameLength),
  );

  if (
    localOffset + LOCAL_MIN > directoryOffset ||
    view.getUint32(localOffset, true) !== LOCAL_SIGNATURE
  )
    throw invalid('zip local header missing');
  const dataStart =
    localOffset +
    LOCAL_MIN +
    view.getUint16(localOffset + 26, true) +
    view.getUint16(localOffset + 28, true);
  if (dataStart + compressedSize > directoryOffset)
    throw invalid('zip entry data out of range');
  const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

  let data;
  if (method === 0) {
    if (compressedSize !== uncompressedSize)
      throw invalid('stored zip entry sizes differ');
    data = Buffer.from(compressed);
  } else {
    try {
      // The limit is the declared size, itself already under the cap: an
      // entry that inflates past what it declares is a bomb or corrupt.
      data = inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE')
        throw tooLarge('zip entry inflated past its declared size');
      throw invalid('zip entry did not inflate');
    }
  }
  if (data.byteLength !== uncompressedSize)
    throw invalid('zip entry size does not match its header');
  if (crc32(data) !== expectedCrc)
    throw invalid('zip entry CRC-32 does not match');
  return { name, data };
}
