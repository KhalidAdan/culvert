// ---------------------------------------------------------------------------
// Block & record sizes
//
// Tar's universal unit is the 512-byte block. Headers are exactly one
// block. Data sections are padded to the next block boundary. The
// end-of-archive marker is two consecutive zero-filled blocks (1024 bytes).
// ---------------------------------------------------------------------------

export const BLOCK_SIZE = 512;
export const END_OF_ARCHIVE_BLOCKS = 2;
export const END_OF_ARCHIVE_SIZE = BLOCK_SIZE * END_OF_ARCHIVE_BLOCKS;

/**
 * Maximum declared size of a PAX extended header ('x'/'g') data section.
 * PAX data is buffered whole for record parsing and the declared size is
 * attacker-controlled; real PAX headers are a few hundred bytes, so 1 MiB
 * is generous while preventing memory-exhaustion attacks.
 */
export const MAX_PAX_HEADER_SIZE = 1024 * 1024;

// ---------------------------------------------------------------------------
// ustar header field offsets
//
// All offsets within the 512-byte header. Lengths are byte counts.
// All numeric fields are zero-padded ASCII octal followed by a space or
// null terminator. The exception is the checksum field which is followed
// by a null and a space.
//
// Reference: POSIX.1-1988 ustar format (also POSIX.1-2001 §A.6).
// ---------------------------------------------------------------------------

export const NAME_OFFSET = 0;
export const NAME_LENGTH = 100;

export const MODE_OFFSET = 100;
export const MODE_LENGTH = 8;

export const UID_OFFSET = 108;
export const UID_LENGTH = 8;

export const GID_OFFSET = 116;
export const GID_LENGTH = 8;

export const SIZE_OFFSET = 124;
export const SIZE_LENGTH = 12;

export const MTIME_OFFSET = 136;
export const MTIME_LENGTH = 12;

export const CHKSUM_OFFSET = 148;
export const CHKSUM_LENGTH = 8;

export const TYPEFLAG_OFFSET = 156;
export const TYPEFLAG_LENGTH = 1;

export const LINKNAME_OFFSET = 157;
export const LINKNAME_LENGTH = 100;

export const MAGIC_OFFSET = 257;
export const MAGIC_LENGTH = 6;
export const MAGIC_USTAR = "ustar\x00";    // POSIX.1-1988 ustar magic
// GNU tar uses "ustar  \0" (with trailing space) — we read but never write it.

export const VERSION_OFFSET = 263;
export const VERSION_LENGTH = 2;
export const VERSION_USTAR = "00";          // ASCII "00", not null-terminated

export const UNAME_OFFSET = 265;
export const UNAME_LENGTH = 32;

export const GNAME_OFFSET = 297;
export const GNAME_LENGTH = 32;

export const DEVMAJOR_OFFSET = 329;
export const DEVMAJOR_LENGTH = 8;

export const DEVMINOR_OFFSET = 337;
export const DEVMINOR_LENGTH = 8;

export const PREFIX_OFFSET = 345;
export const PREFIX_LENGTH = 155;

// Last 12 bytes of the header are reserved/padding. We don't touch them.

// ---------------------------------------------------------------------------
// Typeflag values (POSIX.1-1988 + POSIX.1-2001)
//
// The single-byte value at offset 156 declaring the entry kind.
// ---------------------------------------------------------------------------

export const TYPEFLAG_FILE = "0";          // regular file (also "\0" for old tars)
export const TYPEFLAG_FILE_OLD = "\x00";   // legacy regular file marker
export const TYPEFLAG_HARDLINK = "1";
export const TYPEFLAG_SYMLINK = "2";
export const TYPEFLAG_CHAR_DEVICE = "3";
export const TYPEFLAG_BLOCK_DEVICE = "4";
export const TYPEFLAG_DIRECTORY = "5";
export const TYPEFLAG_FIFO = "6";
export const TYPEFLAG_CONTIGUOUS = "7";    // historical, treated as regular file

// PAX extensions (POSIX.1-2001)
export const TYPEFLAG_PAX_EXTENDED = "x";  // applies to next entry
export const TYPEFLAG_PAX_GLOBAL = "g";    // applies to all subsequent entries

// ---------------------------------------------------------------------------
// Default modes
// ---------------------------------------------------------------------------

export const DEFAULT_FILE_MODE = 0o644;
export const DEFAULT_DIRECTORY_MODE = 0o755;
export const DEFAULT_SYMLINK_MODE = 0o777;
export const DEFAULT_HARDLINK_MODE = 0o644;

// ---------------------------------------------------------------------------
// PAX record keys we recognize
//
// Unknown keys are ignored, not errors. PAX is forward-compatible by design.
// ---------------------------------------------------------------------------

export const PAX_KEY_PATH = "path";
export const PAX_KEY_LINKPATH = "linkpath";
export const PAX_KEY_SIZE = "size";
export const PAX_KEY_MTIME = "mtime";
export const PAX_KEY_UID = "uid";
export const PAX_KEY_GID = "gid";
export const PAX_KEY_CHARSET = "charset";
export const PAX_KEY_HDRCHARSET = "hdrcharset";

// ---------------------------------------------------------------------------
// ustar field ceilings — values that overflow trigger PAX
// ---------------------------------------------------------------------------

export const USTAR_MAX_SIZE = 0o77777777777;   // 8 GiB - 1, max for 12-byte octal
export const USTAR_MAX_UID = 0o7777777;        // ~2 million, max for 8-byte octal
export const USTAR_MAX_GID = USTAR_MAX_UID;
export const USTAR_MAX_MTIME = 0o77777777777;  // ~292 billion seconds, far beyond practical
