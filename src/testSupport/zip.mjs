// Tiny single-entry ZIP writer for tests. Not a test file: the unit runner
// only collects *.test.mjs. It writes the local header, the data and the
// central directory by hand so the reader (server/providers/common/zip.js) is
// exercised against bytes whose layout the test controls.
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Build a ZIP archive with one entry.
 * @param {string} name - Entry name.
 * @param {string|Uint8Array} content - Entry bytes before compression.
 * @param {{method?: 0|8, crc?: number, declaredSize?: number, flags?: number, comment?: string, entries?: number}} [options]
 *   `method` 8 deflates (default), 0 stores; `crc`, `declaredSize`, `flags`,
 *   `comment` and `entries` let a test write a deliberately wrong header.
 * @returns {Buffer}
 */
export function buildZip(name, content, options = {}) {
  const raw = Buffer.from(content);
  const method = options.method ?? 8;
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const crc = options.crc ?? crc32(raw);
  const declaredSize = options.declaredSize ?? raw.length;
  const flags = options.flags ?? 0;
  const nameBytes = Buffer.from(name);
  const comment = Buffer.from(options.comment ?? '');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const directoryOffset = local.length + nameBytes.length + data.length;
  const directorySize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const entries = options.entries ?? 1;
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([
    local,
    nameBytes,
    data,
    central,
    nameBytes,
    end,
    comment,
  ]);
}
