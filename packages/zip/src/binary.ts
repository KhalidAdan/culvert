import {
  FLAG_UTF8,
  SIG_CENTRAL_DIR,
  SIG_END_OF_CENTRAL_DIR,
  SIG_LOCAL_FILE,
  SIG_ZIP64_END_OF_CENTRAL_DIR,
  SIG_ZIP64_END_OF_CENTRAL_DIR_LOCATOR,
  VERSION_MADE_BY,
  VERSION_NEEDED,
  VERSION_NEEDED_ZIP64,
  ZIP64_EXTRA_FIELD_TAG,
  ZIP64_MAGIC_16,
  ZIP64_MAGIC_32,
} from "./constants.js";
import { dateToDos } from "./dos-time.js";
import type { CentralDirectoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function encodeFilename(name: string): Uint8Array {
  return encoder.encode(name);
}

function needsZip64(entry: CentralDirectoryEntry): boolean {
  return (
    entry.compressedSize >= ZIP64_MAGIC_32 ||
    entry.uncompressedSize >= ZIP64_MAGIC_32 ||
    entry.localHeaderOffset >= ZIP64_MAGIC_32
  );
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

/** Write a 64-bit value as two 32-bit halves (little-endian). */
function writeUint64(view: DataView, offset: number, value: number): void {
  // Safe for values up to Number.MAX_SAFE_INTEGER
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

// ---------------------------------------------------------------------------
// Local file header
//
// When CRC and sizes are known (collect-then-write approach), we write
// them directly and skip the data descriptor flag. This lets forward-only
// readers know exactly how many bytes to read.
// ---------------------------------------------------------------------------

export function buildLocalFileHeader(
  name: Uint8Array,
  compressionMethod: number,
  lastModified: Date,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const { time, date } = dateToDos(lastModified);
  const zip64 =
    compressedSize >= ZIP64_MAGIC_32 || uncompressedSize >= ZIP64_MAGIC_32;
  const extraFieldLength = zip64 ? 20 : 0; // tag(2) + size(2) + uncomp(8) + comp(8)
  const size = 30 + name.length + extraFieldLength;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);

  const versionNeeded = zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;

  writeUint32(view, 0, SIG_LOCAL_FILE);
  writeUint16(view, 4, versionNeeded); // version needed
  writeUint16(view, 6, FLAG_UTF8); // flags (no data descriptor)
  writeUint16(view, 8, compressionMethod); // compression method
  writeUint16(view, 10, time); // last mod time
  writeUint16(view, 12, date); // last mod date
  writeUint32(view, 14, crc32); // crc32
  writeUint32(view, 18, zip64 ? ZIP64_MAGIC_32 : compressedSize);
  writeUint32(view, 22, zip64 ? ZIP64_MAGIC_32 : uncompressedSize);
  writeUint16(view, 26, name.length); // filename length
  writeUint16(view, 28, extraFieldLength); // extra field length

  buf.set(name, 30);

  if (zip64) {
    const extraOffset = 30 + name.length;
    writeUint16(view, extraOffset, ZIP64_EXTRA_FIELD_TAG);
    writeUint16(view, extraOffset + 2, 16); // data size
    writeUint64(view, extraOffset + 4, uncompressedSize);
    writeUint64(view, extraOffset + 12, compressedSize);
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Central directory entry
// ---------------------------------------------------------------------------

export function buildCentralDirectoryEntry(
  entry: CentralDirectoryEntry,
): Uint8Array {
  const { time, date } = dateToDos(entry.lastModified);
  const zip64 = needsZip64(entry);

  // ZIP64 extra field: tag(2) + size(2) + uncompressed(8) + compressed(8) + offset(8) = 28
  const extraFieldLength = zip64 ? 28 : 0;
  const size = 46 + entry.name.length + extraFieldLength + entry.comment.length;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);

  const versionNeeded = zip64 ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;

  writeUint32(view, 0, SIG_CENTRAL_DIR);
  writeUint16(view, 4, VERSION_MADE_BY); // version made by
  writeUint16(view, 6, versionNeeded); // version needed
  writeUint16(view, 8, FLAG_UTF8); // flags
  writeUint16(view, 10, entry.compressionMethod); // compression
  writeUint16(view, 12, time);
  writeUint16(view, 14, date);
  writeUint32(view, 16, entry.crc32);
  writeUint32(view, 20, zip64 ? ZIP64_MAGIC_32 : entry.compressedSize);
  writeUint32(view, 24, zip64 ? ZIP64_MAGIC_32 : entry.uncompressedSize);
  writeUint16(view, 28, entry.name.length);
  writeUint16(view, 30, extraFieldLength);
  writeUint16(view, 32, entry.comment.length);
  writeUint16(view, 34, 0); // disk number start
  writeUint16(view, 36, 0); // internal file attributes
  writeUint32(view, 38, 0); // external file attributes
  writeUint32(view, 42, zip64 ? ZIP64_MAGIC_32 : entry.localHeaderOffset);

  buf.set(entry.name, 46);

  if (zip64) {
    const extraOffset = 46 + entry.name.length;
    writeUint16(view, extraOffset, ZIP64_EXTRA_FIELD_TAG);
    writeUint16(view, extraOffset + 2, 24); // extra field data size
    writeUint64(view, extraOffset + 4, entry.uncompressedSize);
    writeUint64(view, extraOffset + 12, entry.compressedSize);
    writeUint64(view, extraOffset + 20, entry.localHeaderOffset);
  }

  if (entry.comment.length > 0) {
    buf.set(entry.comment, 46 + entry.name.length + extraFieldLength);
  }

  return buf;
}

// ---------------------------------------------------------------------------
// End of central directory record
//
// If entry count or offsets exceed 32-bit limits, we prepend the ZIP64
// end-of-central-directory record and its locator.
// ---------------------------------------------------------------------------

export function buildEndOfCentralDirectory(
  entries: CentralDirectoryEntry[],
  centralDirOffset: number,
  centralDirSize: number,
): Uint8Array {
  const entryCount = entries.length;
  const zip64 =
    entryCount >= ZIP64_MAGIC_16 ||
    centralDirOffset >= ZIP64_MAGIC_32 ||
    centralDirSize >= ZIP64_MAGIC_32;

  if (zip64) {
    return buildZip64EndOfCentralDirectory(
      entryCount,
      centralDirOffset,
      centralDirSize,
    );
  }

  // Standard EOCD — 22 bytes
  const buf = new Uint8Array(22);
  const view = new DataView(buf.buffer);

  writeUint32(view, 0, SIG_END_OF_CENTRAL_DIR);
  writeUint16(view, 4, 0); // disk number
  writeUint16(view, 6, 0); // disk with central dir
  writeUint16(view, 8, entryCount); // entries on this disk
  writeUint16(view, 10, entryCount); // total entries
  writeUint32(view, 12, centralDirSize); // central dir size
  writeUint32(view, 16, centralDirOffset); // central dir offset
  writeUint16(view, 20, 0); // comment length

  return buf;
}

function buildZip64EndOfCentralDirectory(
  entryCount: number,
  centralDirOffset: number,
  centralDirSize: number,
): Uint8Array {
  // ZIP64 EOCD record (56) + locator (20) + standard EOCD (22) = 98
  const buf = new Uint8Array(98);
  const view = new DataView(buf.buffer);

  // ZIP64 End of Central Directory Record
  writeUint32(view, 0, SIG_ZIP64_END_OF_CENTRAL_DIR);
  writeUint64(view, 4, 44); // size of this record - 12
  writeUint16(view, 12, VERSION_MADE_BY);
  writeUint16(view, 14, VERSION_NEEDED_ZIP64);
  writeUint32(view, 16, 0); // disk number
  writeUint32(view, 20, 0); // disk with central dir
  writeUint64(view, 24, entryCount);
  writeUint64(view, 32, entryCount);
  writeUint64(view, 40, centralDirSize);
  writeUint64(view, 48, centralDirOffset);

  // ZIP64 End of Central Directory Locator
  const locatorOffset = 56;
  writeUint32(view, locatorOffset, SIG_ZIP64_END_OF_CENTRAL_DIR_LOCATOR);
  writeUint32(view, locatorOffset + 4, 0); // disk with ZIP64 EOCD
  writeUint64(view, locatorOffset + 8, centralDirOffset + centralDirSize);
  writeUint32(view, locatorOffset + 16, 1); // total disks

  // Standard EOCD with 0xFFFF / 0xFFFFFFFF markers
  const eocdOffset = 76;
  writeUint32(view, eocdOffset, SIG_END_OF_CENTRAL_DIR);
  writeUint16(view, eocdOffset + 4, ZIP64_MAGIC_16); // disk number
  writeUint16(view, eocdOffset + 6, ZIP64_MAGIC_16); // disk with central dir
  writeUint16(view, eocdOffset + 8, ZIP64_MAGIC_16); // entries on this disk
  writeUint16(view, eocdOffset + 10, ZIP64_MAGIC_16); // total entries
  writeUint32(view, eocdOffset + 12, ZIP64_MAGIC_32); // central dir size
  writeUint32(view, eocdOffset + 16, ZIP64_MAGIC_32); // central dir offset
  writeUint16(view, eocdOffset + 20, 0); // comment length

  return buf;
}
