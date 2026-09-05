// ---------------------------------------------------------------------------
// Gzip magic bytes (RFC 1952 §2.3.1)
//
// Every gzip member starts with these two bytes.
// ---------------------------------------------------------------------------

export const GZIP_ID1 = 0x1f;
export const GZIP_ID2 = 0x8b;

// ---------------------------------------------------------------------------
// Compression method (RFC 1952 §2.3.1)
//
// Only CM=8 (DEFLATE) is defined. Values 0-7 are reserved.
// ---------------------------------------------------------------------------

export const CM_DEFLATE = 8;

// ---------------------------------------------------------------------------
// FLG bit masks (RFC 1952 §2.3.1)
//
// Each bit enables an optional field after the fixed 10-byte header.
// ---------------------------------------------------------------------------

export const FTEXT = 0b00000001; // bit 0 — hint: content is ASCII text
export const FHCRC = 0b00000010; // bit 1 — header CRC-16 present
export const FEXTRA = 0b00000100; // bit 2 — extra field present
export const FNAME = 0b00001000; // bit 3 — original filename present
export const FCOMMENT = 0b00010000; // bit 4 — comment present

// Bits 5–7 are reserved and must be zero.
export const FLG_RESERVED_MASK = 0b11100000;

// ---------------------------------------------------------------------------
// Header layout
// ---------------------------------------------------------------------------

export const HEADER_SIZE = 10; // fixed portion: ID1 + ID2 + CM + FLG + MTIME(4) + XFL + OS

// Offsets within the 10-byte fixed header
export const ID1_OFFSET = 0;
export const ID2_OFFSET = 1;
export const CM_OFFSET = 2;
export const FLG_OFFSET = 3;
export const MTIME_OFFSET = 4; // 4 bytes, little-endian uint32
export const XFL_OFFSET = 8;
export const OS_OFFSET = 9;

// ---------------------------------------------------------------------------
// Footer layout
// ---------------------------------------------------------------------------

export const FOOTER_SIZE = 8; // CRC-32 (4 bytes LE) + ISIZE (4 bytes LE)

// ---------------------------------------------------------------------------
// OS values (RFC 1952 §2.3.1)
//
// We write OS_UNKNOWN because we're cross-platform — we genuinely
// don't know which filesystem is in play.
// ---------------------------------------------------------------------------

export const OS_UNKNOWN = 0xff;

// ---------------------------------------------------------------------------
// XFL values (RFC 1952 §2.3.1)
//
// Compressor-specific hints. We write XFL_DEFAULT because we don't
// control the platform's compression level.
// ---------------------------------------------------------------------------

export const XFL_DEFAULT = 0; // no specific compressor flags

/**
 * Maximum accepted length of the NUL-terminated FNAME and FCOMMENT
 * header fields. RFC 1952 declares no limit, which makes the fields an
 * unbounded-read vector in hostile streams; 65,535 mirrors FEXTRA's own
 * 16-bit length cap and is far beyond any real filename or comment.
 */
export const MAX_HEADER_STRING_SIZE = 0xffff;
export const XFL_MAXIMUM_COMPRESSION = 2; // slowest algorithm
export const XFL_FASTEST_COMPRESSION = 4; // fastest algorithm
