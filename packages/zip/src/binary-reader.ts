import { dosToDate } from "./dos-time.js";
import { ZipCorruptionError } from "./errors.js";
import type { ZipDirectoryEntry } from "./types.js";
import {
  CENTRAL_DIR_FIXED_SIZE,
  CD_COMMENT_LEN_OFFSET,
  CD_COMPRESSED_SIZE_OFFSET,
  CD_COMPRESSION_OFFSET,
  CD_CRC32_OFFSET,
  CD_EXTRA_LEN_OFFSET,
  CD_LOCAL_HEADER_OFFSET,
  CD_MOD_DATE_OFFSET,
  CD_MOD_TIME_OFFSET,
  CD_NAME_LEN_OFFSET,
  CD_UNCOMPRESSED_SIZE_OFFSET,
  EOCD_CD_OFFSET_OFFSET,
  EOCD_CD_SIZE_OFFSET,
  EOCD_COMMENT_LEN_OFFSET,
  EOCD_FIXED_SIZE,
  EOCD_TOTAL_ENTRIES_OFFSET,
  LFH_EXTRA_LEN_OFFSET,
  LFH_NAME_LEN_OFFSET,
  LOCAL_HEADER_FIXED_SIZE,
  SIG_CENTRAL_DIR,
  SIG_END_OF_CENTRAL_DIR,
  SIG_ZIP64_END_OF_CENTRAL_DIR,
  SIG_ZIP64_END_OF_CENTRAL_DIR_LOCATOR,
  ZIP64_EXTRA_FIELD_TAG,
  ZIP64_MAGIC_16,
  ZIP64_MAGIC_32,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Low-level binary readers
//
// ZIP is entirely little-endian. These helpers read unsigned integers
// from raw byte arrays. The >>> 0 in readUint32LE ensures the result
// is unsigned — JavaScript bitwise ops produce signed 32-bit integers.
// ---------------------------------------------------------------------------

export function readUint16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

export function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * Read a 64-bit little-endian unsigned integer as a JavaScript number.
 * Throws if the value exceeds Number.MAX_SAFE_INTEGER (2^53 - 1).
 *
 * This is the same representation the writer uses — see writeUint64 in
 * binary.ts. The practical ceiling is 8 PiB, far above any realistic
 * ZIP archive. If you hit this error, you have a hostile archive.
 */
export function readUint64LE(buf: Uint8Array, offset: number): number {
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  // Number.MAX_SAFE_INTEGER = 2^53 - 1; hi < 2^21 fits safely.
  if (hi >= 0x200000) {
    throw new ZipCorruptionError(
      "ZIP64 value exceeds Number.MAX_SAFE_INTEGER (9 PiB). " +
        "This implementation represents 64-bit sizes as JavaScript numbers.",
    );
  }
  return hi * 0x100000000 + lo;
}

// ---------------------------------------------------------------------------
// ZIP64 constants (sizes of fixed portions)
// ---------------------------------------------------------------------------

const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_FIXED_SIZE = 56;

// Offsets within the 20-byte ZIP64 EOCD locator (APPNOTE §4.3.15)
const ZIP64_LOC_EOCD_OFFSET_FIELD = 8; // uint64 offset to ZIP64 EOCD record

// Offsets within the 56-byte fixed portion of the ZIP64 EOCD record
// (APPNOTE §4.3.14)
const ZIP64_EOCD_TOTAL_ENTRIES_OFFSET = 32; // uint64
const ZIP64_EOCD_CD_SIZE_OFFSET = 40;       // uint64
const ZIP64_EOCD_CD_OFFSET_OFFSET = 48;     // uint64

// ---------------------------------------------------------------------------
// EOCD — End of Central Directory Record
//
// The signpost at the very end of the ZIP file. Points to the central
// directory (byte offset + size) and declares the total entry count.
//
// For standard (sub-4GB, <65535 entries) archives, a single 22-byte
// record at the end contains everything. For ZIP64 archives, the
// standard EOCD holds sentinel values (0xFFFF / 0xFFFFFFFF) and the
// real numbers live in a ZIP64 EOCD record further back in the file,
// reached via a 20-byte ZIP64 EOCD locator that sits immediately
// before the standard EOCD.
// ---------------------------------------------------------------------------

export interface EOCDRecord {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  /**
   * Absolute byte offset of the ZIP64 EOCD record, if this archive
   * uses ZIP64. null for standard archives.
   *
   * When non-null, openZip() must perform a second seek to read the
   * ZIP64 EOCD record and override the sentinel values returned here.
   */
  zip64EocdOffset: number | null;
}

/**
 * Scan a byte buffer (typically the last ~64KB of the file) backward
 * to find the EOCD signature and parse the record.
 *
 * If ZIP64 sentinels appear, also parse the ZIP64 EOCD locator that
 * sits 20 bytes before the standard EOCD. The absolute offset of the
 * ZIP64 EOCD record is returned so the caller can do a second seek.
 */
export function findEOCD(tail: Uint8Array): EOCDRecord {
  for (let i = tail.length - EOCD_FIXED_SIZE; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      // Validate: comment length must be consistent with remaining bytes
      const commentLength = readUint16LE(tail, i + EOCD_COMMENT_LEN_OFFSET);
      const expectedEnd = i + EOCD_FIXED_SIZE + commentLength;
      if (expectedEnd > tail.length) continue; // false positive

      const entryCount = readUint16LE(tail, i + EOCD_TOTAL_ENTRIES_OFFSET);
      const centralDirectorySize = readUint32LE(tail, i + EOCD_CD_SIZE_OFFSET);
      const centralDirectoryOffset = readUint32LE(
        tail,
        i + EOCD_CD_OFFSET_OFFSET,
      );

      const isZip64 =
        entryCount === ZIP64_MAGIC_16 ||
        centralDirectorySize === ZIP64_MAGIC_32 ||
        centralDirectoryOffset === ZIP64_MAGIC_32;

      if (!isZip64) {
        return {
          entryCount,
          centralDirectorySize,
          centralDirectoryOffset,
          zip64EocdOffset: null,
        };
      }

      // --- ZIP64 path: find the locator immediately before the EOCD ---
      const locatorStart = i - ZIP64_LOCATOR_SIZE;
      if (locatorStart < 0) {
        throw new ZipCorruptionError(
          "ZIP64 archive appears truncated: no room for the ZIP64 EOCD locator " +
            "before the standard EOCD.",
        );
      }

      const locatorSig = readUint32LE(tail, locatorStart);
      if (locatorSig !== SIG_ZIP64_END_OF_CENTRAL_DIR_LOCATOR) {
        throw new ZipCorruptionError(
          "ZIP64 EOCD locator signature not found where expected. " +
            "Archive declares ZIP64 sentinels but lacks a valid locator.",
        );
      }

      const zip64EocdOffset = readUint64LE(
        tail,
        locatorStart + ZIP64_LOC_EOCD_OFFSET_FIELD,
      );

      return {
        entryCount,
        centralDirectorySize,
        centralDirectoryOffset,
        zip64EocdOffset,
      };
    }
  }

  throw new ZipCorruptionError(
    "End of central directory record not found. " +
      "The file may not be a ZIP archive or may be truncated.",
  );
}

/**
 * Parse the 56-byte fixed portion of the ZIP64 EOCD record.
 * Returns the real entry count, central directory size, and offset
 * that override the sentinels in the standard EOCD.
 *
 * The caller (openZip) is responsible for reading exactly
 * ZIP64_EOCD_FIXED_SIZE bytes at the offset returned by findEOCD().
 */
export function parseZip64EOCDRecord(buf: Uint8Array): {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
} {
  if (buf.length < ZIP64_EOCD_FIXED_SIZE) {
    throw new ZipCorruptionError(
      `ZIP64 EOCD record too short: expected ${ZIP64_EOCD_FIXED_SIZE} bytes, ` +
        `got ${buf.length}`,
    );
  }

  const sig = readUint32LE(buf, 0);
  if (sig !== SIG_ZIP64_END_OF_CENTRAL_DIR) {
    throw new ZipCorruptionError(
      `Invalid ZIP64 EOCD record signature: ` +
        `0x${sig.toString(16).padStart(8, "0")}`,
    );
  }

  return {
    entryCount: readUint64LE(buf, ZIP64_EOCD_TOTAL_ENTRIES_OFFSET),
    centralDirectorySize: readUint64LE(buf, ZIP64_EOCD_CD_SIZE_OFFSET),
    centralDirectoryOffset: readUint64LE(buf, ZIP64_EOCD_CD_OFFSET_OFFSET),
  };
}

export { ZIP64_EOCD_FIXED_SIZE };

// ---------------------------------------------------------------------------
// ZIP64 extra field
//
// When a central directory entry has any 32-bit size/offset set to the
// sentinel 0xFFFFFFFF, the real 64-bit value lives in the extra field
// block under tag 0x0001.
//
// The extra field can hold multiple tagged records; we scan for 0x0001.
// Within tag 0x0001, fields appear *only* for sentinel slots, in this
// fixed order: uncompressedSize, compressedSize, localHeaderOffset,
// diskStart. We only consume the fields we needed to fix.
// ---------------------------------------------------------------------------

interface Zip64Overrides {
  uncompressedSize?: number;
  compressedSize?: number;
  localHeaderOffset?: number;
}

function findZip64ExtraField(
  extra: Uint8Array,
  needUncompressed: boolean,
  needCompressed: boolean,
  needOffset: boolean,
): Zip64Overrides | null {
  let pos = 0;

  while (pos + 4 <= extra.length) {
    const tag = readUint16LE(extra, pos);
    const size = readUint16LE(extra, pos + 2);
    const dataStart = pos + 4;
    const dataEnd = dataStart + size;

    if (dataEnd > extra.length) {
      throw new ZipCorruptionError(
        `Extra field record extends past buffer: tag 0x${tag.toString(16)}, ` +
          `size ${size}, available ${extra.length - dataStart}`,
      );
    }

    if (tag === ZIP64_EXTRA_FIELD_TAG) {
      const overrides: Zip64Overrides = {};
      let p = dataStart;

      if (needUncompressed) {
        overrides.uncompressedSize = readUint64LE(extra, p);
        p += 8;
      }
      if (needCompressed) {
        overrides.compressedSize = readUint64LE(extra, p);
        p += 8;
      }
      if (needOffset) {
        overrides.localHeaderOffset = readUint64LE(extra, p);
        p += 8;
      }
      // If diskStart was also a sentinel (0xFFFF), it would follow here.
      // We don't support split archives, so we ignore it.

      return overrides;
    }

    pos = dataEnd;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Central Directory
//
// A contiguous block of variable-length records, one per file in the
// archive. Each record has a 46-byte fixed header followed by the
// filename, an optional extra field, and an optional comment.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/**
 * Parse the central directory bytes into an array of ZipDirectoryEntry.
 * Applies ZIP64 extra field overrides automatically when sentinel values
 * are detected in the fixed portion.
 */
export function parseCentralDirectory(
  cd: Uint8Array,
): ZipDirectoryEntry[] {
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;

  while (offset < cd.length) {
    if (offset + CENTRAL_DIR_FIXED_SIZE > cd.length) {
      throw new ZipCorruptionError(
        `Central directory truncated at byte ${offset}: ` +
          `need ${CENTRAL_DIR_FIXED_SIZE} bytes, have ${cd.length - offset}`,
      );
    }

    const sig = readUint32LE(cd, offset);
    if (sig !== SIG_CENTRAL_DIR) {
      throw new ZipCorruptionError(
        `Invalid central directory signature at byte ${offset}: ` +
          `0x${sig.toString(16).padStart(8, "0")}`,
      );
    }

    const compressionMethod = readUint16LE(cd, offset + CD_COMPRESSION_OFFSET);
    const modTime = readUint16LE(cd, offset + CD_MOD_TIME_OFFSET);
    const modDate = readUint16LE(cd, offset + CD_MOD_DATE_OFFSET);
    const crc32 = readUint32LE(cd, offset + CD_CRC32_OFFSET);
    let compressedSize = readUint32LE(cd, offset + CD_COMPRESSED_SIZE_OFFSET);
    let uncompressedSize = readUint32LE(
      cd,
      offset + CD_UNCOMPRESSED_SIZE_OFFSET,
    );
    const nameLength = readUint16LE(cd, offset + CD_NAME_LEN_OFFSET);
    const extraLength = readUint16LE(cd, offset + CD_EXTRA_LEN_OFFSET);
    const commentLength = readUint16LE(cd, offset + CD_COMMENT_LEN_OFFSET);
    let localHeaderOffset = readUint32LE(cd, offset + CD_LOCAL_HEADER_OFFSET);

    const nameStart = offset + CENTRAL_DIR_FIXED_SIZE;
    const nameBytes = cd.subarray(nameStart, nameStart + nameLength);
    const extraStart = nameStart + nameLength;
    const commentStart = extraStart + extraLength;
    const commentBytes = cd.subarray(commentStart, commentStart + commentLength);

    // --- ZIP64: consult the extra field if any 32-bit slot is a sentinel ---
    const needUncompressed = uncompressedSize === ZIP64_MAGIC_32;
    const needCompressed = compressedSize === ZIP64_MAGIC_32;
    const needOffset = localHeaderOffset === ZIP64_MAGIC_32;

    if (needUncompressed || needCompressed || needOffset) {
      const extra = cd.subarray(extraStart, extraStart + extraLength);
      const overrides = findZip64ExtraField(
        extra,
        needUncompressed,
        needCompressed,
        needOffset,
      );

      if (!overrides) {
        throw new ZipCorruptionError(
          `Entry "${decoder.decode(nameBytes)}" has ZIP64 sentinel values but ` +
            `no ZIP64 extra field (tag 0x0001) in the central directory.`,
        );
      }

      if (overrides.uncompressedSize !== undefined) {
        uncompressedSize = overrides.uncompressedSize;
      }
      if (overrides.compressedSize !== undefined) {
        compressedSize = overrides.compressedSize;
      }
      if (overrides.localHeaderOffset !== undefined) {
        localHeaderOffset = overrides.localHeaderOffset;
      }
    }

    entries.push({
      name: decoder.decode(nameBytes),
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      lastModified: dosToDate(modTime, modDate),
      comment: commentLength > 0 ? decoder.decode(commentBytes) : "",
    });

    offset += CENTRAL_DIR_FIXED_SIZE + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Local File Header — data offset calculation
//
// The central directory tells us where each local header starts.
// But we can't jump straight to the file data — the local header
// has variable-length filename and extra fields that we must skip.
// ---------------------------------------------------------------------------

/**
 * Given the fixed portion of a local file header (30 bytes), return
 * the byte offset where the file's compressed data begins.
 */
export function parseLocalHeaderDataOffset(
  localHeader: Uint8Array,
  headerOffset: number,
): number {
  const nameLength = readUint16LE(localHeader, LFH_NAME_LEN_OFFSET);
  const extraLength = readUint16LE(localHeader, LFH_EXTRA_LEN_OFFSET);
  return headerOffset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength;
}
