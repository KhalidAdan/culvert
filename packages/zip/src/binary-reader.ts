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

// ---------------------------------------------------------------------------
// EOCD — End of Central Directory Record
//
// The signpost at the very end of the ZIP file. It doesn't contain
// file metadata — it contains a pointer to the central directory
// (byte offset + size) and the total entry count.
//
// Finding it requires scanning backward because an optional comment
// field of up to 65,535 bytes may follow the fixed 22-byte record.
// ---------------------------------------------------------------------------

export interface EOCDRecord {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}

/**
 * Scan a byte buffer (typically the last ~64KB of the file) backward
 * to find the EOCD signature and parse the record.
 *
 * Validates that the comment length field is consistent with the
 * buffer size to reject false-positive signature matches inside
 * compressed data.
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

      // Check for ZIP64 sentinel values — not yet supported in the
      // random-access reader. The writer produces ZIP64 when needed,
      // but the read path requires parsing the ZIP64 EOCD record
      // and ZIP64 extra fields in central directory entries.
      if (
        entryCount === ZIP64_MAGIC_16 ||
        centralDirectorySize === ZIP64_MAGIC_32 ||
        centralDirectoryOffset === ZIP64_MAGIC_32
      ) {
        throw new ZipCorruptionError(
          "ZIP64 archives are not yet supported by the random-access reader. " +
            "This archive has more than 65,534 entries or exceeds 4 GB.",
        );
      }

      return { entryCount, centralDirectorySize, centralDirectoryOffset };
    }
  }

  throw new ZipCorruptionError(
    "End of central directory record not found. " +
      "The file may not be a ZIP archive or may be truncated.",
  );
}

// ---------------------------------------------------------------------------
// Central Directory
//
// A contiguous block of variable-length records, one per file in the
// archive. Each record has a 46-byte fixed header followed by the
// filename, an optional extra field, and an optional comment.
//
// The central directory is the authoritative index — it can contain
// metadata that local headers don't (external attributes, comments),
// and it's more resilient to corruption.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/**
 * Parse the central directory bytes into an array of ZipDirectoryEntry.
 * Each entry contains everything needed for random-access reads:
 * the local header offset (for seeking) and CRC/sizes (for verification).
 */
export function parseCentralDirectory(
  cd: Uint8Array,
): ZipDirectoryEntry[] {
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;

  while (offset < cd.length) {
    // Verify signature
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
    const compressedSize = readUint32LE(cd, offset + CD_COMPRESSED_SIZE_OFFSET);
    const uncompressedSize = readUint32LE(
      cd,
      offset + CD_UNCOMPRESSED_SIZE_OFFSET,
    );
    const nameLength = readUint16LE(cd, offset + CD_NAME_LEN_OFFSET);
    const extraLength = readUint16LE(cd, offset + CD_EXTRA_LEN_OFFSET);
    const commentLength = readUint16LE(cd, offset + CD_COMMENT_LEN_OFFSET);
    const localHeaderOffset = readUint32LE(cd, offset + CD_LOCAL_HEADER_OFFSET);

    // Variable-length fields follow the fixed header
    const nameStart = offset + CENTRAL_DIR_FIXED_SIZE;
    const nameBytes = cd.subarray(nameStart, nameStart + nameLength);

    const commentStart = nameStart + nameLength + extraLength;
    const commentBytes = cd.subarray(commentStart, commentStart + commentLength);

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

    // Advance past: fixed header + name + extra + comment
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
//
// We only need 30 bytes (the fixed portion) to determine the two
// variable lengths, then: dataOffset = headerOffset + 30 + n + m.
// ---------------------------------------------------------------------------

/**
 * Given the fixed portion of a local file header (30 bytes), return
 * the byte offset where the file's compressed data begins.
 *
 * @param localHeader  The 30-byte fixed portion of the local header
 * @param headerOffset The byte offset of the local header in the archive
 * @returns The byte offset of the first byte of compressed file data
 */
export function parseLocalHeaderDataOffset(
  localHeader: Uint8Array,
  headerOffset: number,
): number {
  const nameLength = readUint16LE(localHeader, LFH_NAME_LEN_OFFSET);
  const extraLength = readUint16LE(localHeader, LFH_EXTRA_LEN_OFFSET);
  return headerOffset + LOCAL_HEADER_FIXED_SIZE + nameLength + extraLength;
}
