import assert from 'node:assert/strict';
import test from 'node:test';
import { buildZip } from '../../../src/testSupport/zip.mjs';
import { ZipError, readSingleEntryZip } from './zip.js';

const LIMITS = {
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 1024 * 1024,
};
const read = (zip, limits = LIMITS) => readSingleEntryZip(zip, limits);
const TEXT = 'line one\nline two\n'.repeat(50);

test('reads a deflated single-entry zip', () => {
  const { name, data } = read(buildZip('20261025084500.gkg.csv', TEXT));
  assert.equal(name, '20261025084500.gkg.csv');
  assert.equal(data.toString('utf8'), TEXT);
});

test('reads a stored entry and a zip with a trailing comment', () => {
  const stored = read(buildZip('a.csv', 'hello', { method: 0 }));
  assert.equal(stored.data.toString(), 'hello');
  const commented = read(
    buildZip('a.csv', TEXT, { comment: 'made by a test' }),
  );
  assert.equal(commented.data.toString('utf8'), TEXT);
});

test('reads from a Uint8Array that is a view into a bigger buffer', () => {
  const zip = buildZip('a.csv', TEXT);
  const padded = Buffer.concat([Buffer.alloc(7, 1), zip]);
  // Offsets inside the archive are relative to its own start.
  assert.equal(read(padded.subarray(7)).data.toString(), TEXT);
});

test('refuses anything that is not a readable single-entry zip', () => {
  const good = buildZip('a.csv', TEXT);
  const cases = {
    'not a zip': Buffer.from('this is not a zip archive at all, no.'),
    empty: new Uint8Array(0),
    'cut short': good.subarray(0, good.length - 10),
    'two entries': buildZip('a.csv', TEXT, { entries: 2 }),
    'no entries': buildZip('a.csv', TEXT, { entries: 0 }),
    encrypted: buildZip('a.csv', TEXT, { flags: 1 }),
    'wrong crc': buildZip('a.csv', TEXT, { crc: 0xdeadbeef }),
    'unsupported method': (() => {
      const copy = Buffer.from(good);
      // Method field of the central directory entry (46 bytes + name + data).
      const central = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      copy.writeUInt16LE(12, central + 10);
      return copy;
    })(),
    'zip64 markers': (() => {
      const copy = Buffer.from(good);
      copy.writeUInt32LE(0xffffffff, copy.length - 22 + 16);
      return copy;
    })(),
    'size field lies (smaller)': buildZip('a.csv', TEXT, { declaredSize: 10 }),
    'size field lies (larger)': buildZip('a.csv', TEXT, {
      declaredSize: TEXT.length + 5,
    }),
  };
  for (const [label, zip] of Object.entries(cases)) {
    assert.throws(
      () => read(zip),
      (error) =>
        error instanceof ZipError &&
        ['invalid_payload', 'RESPONSE_TOO_LARGE'].includes(error.code),
      label,
    );
  }
  for (const label of [
    'not a zip',
    'empty',
    'cut short',
    'two entries',
    'no entries',
    'encrypted',
    'wrong crc',
    'unsupported method',
    'zip64 markers',
    'size field lies (larger)',
  ])
    assert.throws(() => read(cases[label]), { code: 'invalid_payload' }, label);
});

test('size caps: the compressed zip and the declared and inflated sizes', () => {
  const zip = buildZip('a.csv', TEXT);
  assert.throws(
    () => read(zip, { ...LIMITS, maxCompressedBytes: zip.length - 1 }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  assert.throws(
    () => read(zip, { ...LIMITS, maxUncompressedBytes: TEXT.length - 1 }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  // A header that declares 90 MB is refused before anything is inflated.
  assert.throws(
    () =>
      read(buildZip('a.csv', TEXT, { declaredSize: 90 * 1024 * 1024 }), {
        maxCompressedBytes: 10 * 1024 * 1024,
        maxUncompressedBytes: 80 * 1024 * 1024,
      }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  // A zip bomb: it declares 100 bytes but inflates to far more.
  const bomb = buildZip('a.csv', 'x'.repeat(200_000), { declaredSize: 100 });
  assert.throws(() => read(bomb), { code: 'RESPONSE_TOO_LARGE' });
});
