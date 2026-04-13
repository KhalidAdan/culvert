// ---------------------------------------------------------------------------
// ZIP format constants
//
// Every magic number in the ZIP spec, named and documented. If you're
// reading this file, you can trace any constant back to PKWARE's
// APPNOTE.TXT (current version 6.3.10).
//
// Existing code in binary.ts and reader.ts defines some of these
// locally — a future refactor should import from here instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Signatures (APPNOTE §4.3)
//
// Every ZIP structure starts with a 4-byte signature.
// The first two bytes are always 0x50 0x4B — "PK", Phil Katz's initials.
// ---------------------------------------------------------------------------

/** Local file header: PK\x03\x04 */
export const SIG_LOCAL_FILE = 0x04034b50;

/** Data descriptor (optional): PK\x07\x08 */
export const SIG_DATA_DESCRIPTOR = 0x08074b50;

/** Central directory file header: PK\x01\x02 */
export const SIG_CENTRAL_DIR = 0x02014b50;

/** End of central directory record: PK\x05\x06 */
export const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

/** ZIP64 end of central directory record: PK\x06\x06 */
export const SIG_ZIP64_END_OF_CENTRAL_DIR = 0x06064b50;

/** ZIP64 end of central directory locator: PK\x06\x07 */
export const SIG_ZIP64_END_OF_CENTRAL_DIR_LOCATOR = 0x07064b50;

// ---------------------------------------------------------------------------
// General purpose bit flags (APPNOTE §4.4.4)
// ---------------------------------------------------------------------------

/** Bit 3: CRC and sizes live in a data descriptor after file data */
export const FLAG_DATA_DESCRIPTOR = 1 << 3;

/** Bit 11: filename and comment are UTF-8 encoded */
export const FLAG_UTF8 = 1 << 11;

// ---------------------------------------------------------------------------
// Version fields (APPNOTE §4.4.2, §4.4.3)
// ---------------------------------------------------------------------------

/** Version needed to extract: 2.0 — deflate, data descriptors */
export const VERSION_NEEDED = 20;

/** Version needed for ZIP64 extensions */
export const VERSION_NEEDED_ZIP64 = 45;

/** Version made by: 3.0 (ZIP spec 6.3.x), upper byte 0 = MS-DOS compat */
export const VERSION_MADE_BY = 30;

// ---------------------------------------------------------------------------
// Compression methods (APPNOTE §4.4.5)
// ---------------------------------------------------------------------------

/** No compression — bytes stored as-is */
export const COMPRESSION_STORE = 0;

/** Deflate (RFC 1951) */
export const COMPRESSION_DEFLATE = 8;

// ---------------------------------------------------------------------------
// ZIP64 sentinel values
//
// When a 16-bit or 32-bit field contains one of these, the real value
// lives in the ZIP64 extended information extra field (tag 0x0001).
// ---------------------------------------------------------------------------

export const ZIP64_MAGIC_16 = 0xffff;
export const ZIP64_MAGIC_32 = 0xffffffff;

/** ZIP64 extra field tag */
export const ZIP64_EXTRA_FIELD_TAG = 0x0001;

// ---------------------------------------------------------------------------
// Structure sizes (fixed portions)
//
// Each structure has a fixed-size header followed by variable-length
// fields (filename, extra, comment) whose lengths are declared in
// the fixed portion.
// ---------------------------------------------------------------------------

/** Local file header fixed portion: 30 bytes */
export const LOCAL_HEADER_FIXED_SIZE = 30;

/** Central directory entry fixed portion: 46 bytes */
export const CENTRAL_DIR_FIXED_SIZE = 46;

/** End of central directory record fixed portion: 22 bytes */
export const EOCD_FIXED_SIZE = 22;

/** Maximum EOCD comment length (uint16 max) */
export const EOCD_MAX_COMMENT_SIZE = 0xffff;

/**
 * Maximum bytes to read when searching for the EOCD signature.
 * EOCD fixed (22) + max comment (65,535) + 1 byte margin = 65,558.
 */
export const EOCD_SEARCH_SIZE = EOCD_FIXED_SIZE + EOCD_MAX_COMMENT_SIZE + 1;

// ---------------------------------------------------------------------------
// Local file header field offsets (APPNOTE §4.3.7)
//
// Offset  Size  Field
// ──────  ────  ─────
//  0      4     Signature
//  4      2     Version needed to extract
//  6      2     General purpose bit flags
//  8      2     Compression method
// 10      2     Last mod file time (DOS format)
// 12      2     Last mod file date (DOS format)
// 14      4     CRC-32
// 18      4     Compressed size
// 22      4     Uncompressed size
// 26      2     Filename length (n)
// 28      2     Extra field length (m)
// 30      n     Filename
// 30+n    m     Extra field
// 30+n+m  ...   File data starts here
// ---------------------------------------------------------------------------

export const LFH_VERSION_OFFSET = 4;
export const LFH_FLAGS_OFFSET = 6;
export const LFH_COMPRESSION_OFFSET = 8;
export const LFH_MOD_TIME_OFFSET = 10;
export const LFH_MOD_DATE_OFFSET = 12;
export const LFH_CRC32_OFFSET = 14;
export const LFH_COMPRESSED_SIZE_OFFSET = 18;
export const LFH_UNCOMPRESSED_SIZE_OFFSET = 22;
export const LFH_NAME_LEN_OFFSET = 26;
export const LFH_EXTRA_LEN_OFFSET = 28;

// ---------------------------------------------------------------------------
// Central directory entry field offsets (APPNOTE §4.3.12)
//
// Offset  Size  Field
// ──────  ────  ─────
//  0      4     Signature
//  4      2     Version made by
//  6      2     Version needed to extract
//  8      2     General purpose bit flags
// 10      2     Compression method
// 12      2     Last mod file time (DOS format)
// 14      2     Last mod file date (DOS format)
// 16      4     CRC-32
// 20      4     Compressed size
// 24      4     Uncompressed size
// 28      2     Filename length (n)
// 30      2     Extra field length (m)
// 32      2     File comment length (k)
// 34      2     Disk number start
// 36      2     Internal file attributes
// 38      4     External file attributes
// 42      4     Relative offset of local header
// 46      n     Filename
// 46+n    m     Extra field
// 46+n+m  k     File comment
// ---------------------------------------------------------------------------

export const CD_VERSION_MADE_BY_OFFSET = 4;
export const CD_VERSION_NEEDED_OFFSET = 6;
export const CD_FLAGS_OFFSET = 8;
export const CD_COMPRESSION_OFFSET = 10;
export const CD_MOD_TIME_OFFSET = 12;
export const CD_MOD_DATE_OFFSET = 14;
export const CD_CRC32_OFFSET = 16;
export const CD_COMPRESSED_SIZE_OFFSET = 20;
export const CD_UNCOMPRESSED_SIZE_OFFSET = 24;
export const CD_NAME_LEN_OFFSET = 28;
export const CD_EXTRA_LEN_OFFSET = 30;
export const CD_COMMENT_LEN_OFFSET = 32;
export const CD_DISK_START_OFFSET = 34;
export const CD_INTERNAL_ATTRS_OFFSET = 36;
export const CD_EXTERNAL_ATTRS_OFFSET = 38;
export const CD_LOCAL_HEADER_OFFSET = 42;

// ---------------------------------------------------------------------------
// End of central directory record field offsets (APPNOTE §4.3.16)
//
// Offset  Size  Field
// ──────  ────  ─────
//  0      4     Signature
//  4      2     Number of this disk
//  6      2     Disk where central directory starts
//  8      2     Number of central directory entries on this disk
// 10      2     Total number of central directory entries
// 12      4     Size of central directory (bytes)
// 16      4     Offset of start of central directory
// 20      2     ZIP file comment length
// ---------------------------------------------------------------------------

export const EOCD_DISK_NUMBER_OFFSET = 4;
export const EOCD_CD_DISK_OFFSET = 6;
export const EOCD_DISK_ENTRIES_OFFSET = 8;
export const EOCD_TOTAL_ENTRIES_OFFSET = 10;
export const EOCD_CD_SIZE_OFFSET = 12;
export const EOCD_CD_OFFSET_OFFSET = 16;
export const EOCD_COMMENT_LEN_OFFSET = 20;

// ---------------------------------------------------------------------------
// I/O tuning
// ---------------------------------------------------------------------------

/** Default chunk size for seek-based reads: 64 KB */
export const READ_CHUNK_SIZE = 64 * 1024;
