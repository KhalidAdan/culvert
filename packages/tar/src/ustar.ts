import {
  BLOCK_SIZE,
  CHKSUM_LENGTH,
  CHKSUM_OFFSET,
  DEVMAJOR_LENGTH,
  DEVMAJOR_OFFSET,
  DEVMINOR_LENGTH,
  DEVMINOR_OFFSET,
  GID_LENGTH,
  GID_OFFSET,
  GNAME_LENGTH,
  GNAME_OFFSET,
  LINKNAME_LENGTH,
  LINKNAME_OFFSET,
  MAGIC_LENGTH,
  MAGIC_OFFSET,
  MAGIC_USTAR,
  MODE_LENGTH,
  MODE_OFFSET,
  MTIME_LENGTH,
  MTIME_OFFSET,
  NAME_LENGTH,
  NAME_OFFSET,
  PREFIX_LENGTH,
  PREFIX_OFFSET,
  SIZE_LENGTH,
  SIZE_OFFSET,
  TYPEFLAG_OFFSET,
  UID_LENGTH,
  UID_OFFSET,
  UNAME_LENGTH,
  UNAME_OFFSET,
  USTAR_MAX_SIZE,
  USTAR_MAX_UID,
  VERSION_LENGTH,
  VERSION_OFFSET,
  VERSION_USTAR,
} from "./constants.js";
import { TarCorruptionError } from "./errors.js";

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Header checksum
//
// To compute: zero the 8-byte checksum field, then sum every byte of
// the 512-byte header as an unsigned 8-bit value. To verify: the
// checksum field is treated as 8 spaces (0x20 each = 256 total) during
// the sum, then the result is compared against the stored value.
//
// We implement the verify-style sum: read the stored value, compute
// the sum treating CHKSUM_OFFSET..+CHKSUM_LENGTH as spaces, compare.
// ---------------------------------------------------------------------------

export function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (i >= CHKSUM_OFFSET && i < CHKSUM_OFFSET + CHKSUM_LENGTH) {
      sum += 0x20; // ASCII space
    } else {
      sum += header[i]!;
    }
  }
  return sum;
}

/**
 * Read the stored checksum from a header. Octal ASCII, with various
 * trailing-byte conventions (NUL, NUL+space, space+NUL). We tolerate
 * all of them.
 */
export function readStoredChecksum(header: Uint8Array): number {
  return parseOctal(header, CHKSUM_OFFSET, CHKSUM_LENGTH);
}

// ---------------------------------------------------------------------------
// Octal numeric parsing
//
// ustar numeric fields are zero-padded ASCII octal followed by a space
// or NUL. A field of all zeros (or all spaces) means "0". A leading
// 0x80 byte indicates the GNU "base-256" extension — we reject these
// in v1 with TarCorruptionError. Real archives almost never use them
// (PAX records cover the same use case more portably).
// ---------------------------------------------------------------------------

export function parseOctal(buf: Uint8Array, offset: number, length: number): number {
  // GNU base-256: high bit of the first byte set. We don't support it.
  if ((buf[offset]! & 0x80) !== 0) {
    throw new TarCorruptionError(
      "GNU base-256 numeric encoding is not supported in v1. " +
        "Use a tar tool that emits PAX extended headers instead.",
    );
  }

  let result = 0;
  let saw = false;
  let i = 0;
  // POSIX permits leading spaces in octal fields, and historic writers
  // (old Unix tar, star) emit them — the checksum field in particular
  // is often "  NNNN\0 ". Treating a leading space as the terminator
  // read those fields as 0 and rejected valid archives.
  while (i < length && buf[offset + i] === 0x20) i++;
  for (; i < length; i++) {
    const c = buf[offset + i]!;
    // Stop at NUL or space terminators (after the digits).
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) {
      throw new TarCorruptionError(
        `Invalid octal digit 0x${c.toString(16)} at offset ${offset + i}`,
      );
    }
    result = result * 8 + (c - 0x30);
    saw = true;
  }
  return saw ? result : 0;
}

// ---------------------------------------------------------------------------
// String field parsing — null-terminated ASCII (or UTF-8)
// ---------------------------------------------------------------------------

export function parseString(buf: Uint8Array, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  // Find the first NUL terminator; if absent, use the full length.
  let end = slice.length;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) {
      end = i;
      break;
    }
  }
  return decoder.decode(slice.subarray(0, end));
}

// ---------------------------------------------------------------------------
// Octal numeric encoding
//
// Format: zero-padded octal digits filling (length - 1) bytes,
// followed by a NUL terminator. Throws if the value doesn't fit.
//
// The checksum field is special: 6 octal digits + NUL + space.
// Use writeChecksum() for that.
// ---------------------------------------------------------------------------

export function writeOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  if (value < 0) {
    throw new RangeError(`Negative value cannot be encoded as octal: ${value}`);
  }
  const max = Math.pow(8, length - 1);
  if (value >= max) {
    throw new RangeError(
      `Value ${value} does not fit in ${length}-byte octal field (max ${max - 1})`,
    );
  }
  const octal = value.toString(8);
  // Zero-pad to (length - 1) digits, then NUL terminator.
  const padded = octal.padStart(length - 1, "0");
  for (let i = 0; i < length - 1; i++) {
    buf[offset + i] = padded.charCodeAt(i);
  }
  buf[offset + length - 1] = 0; // NUL terminator
}

/**
 * Write the checksum field. Format: 6 octal digits, NUL, space.
 */
export function writeChecksum(buf: Uint8Array, value: number): void {
  const padded = value.toString(8).padStart(6, "0");
  for (let i = 0; i < 6; i++) {
    buf[CHKSUM_OFFSET + i] = padded.charCodeAt(i);
  }
  buf[CHKSUM_OFFSET + 6] = 0;     // NUL
  buf[CHKSUM_OFFSET + 7] = 0x20;  // space
}

/**
 * Write a UTF-8 string into a fixed-length field, NUL-terminated if
 * there's room. Throws if the encoded bytes don't fit (caller should
 * have already determined PAX is needed).
 */
export function writeString(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) {
    throw new RangeError(
      `String "${value}" encodes to ${bytes.length} bytes, exceeds ${length}-byte field`,
    );
  }
  buf.set(bytes, offset);
  // Remainder is left zero (the buffer comes pre-zeroed).
}

/**
 * Like writeString but writes raw bytes if you've already encoded them.
 */
export function writeBytes(buf: Uint8Array, offset: number, length: number, bytes: Uint8Array): void {
  if (bytes.length > length) {
    throw new RangeError(
      `Byte sequence (${bytes.length}) exceeds ${length}-byte field`,
    );
  }
  buf.set(bytes, offset);
}

// ---------------------------------------------------------------------------
// Header parsing
//
// Returns the raw ustar values from a 512-byte header block. PAX
// overrides are NOT applied here — that's the caller's job after
// merging with PaxState.
// ---------------------------------------------------------------------------

export interface ParsedUstarHeader {
  name: string;
  prefix: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtimeSeconds: number;
  storedChecksum: number;
  computedChecksum: number;
  typeflag: string;
  linkname: string;
  magic: string;
  version: string;
  uname: string;
  gname: string;
  devmajor: number;
  devminor: number;
}

export function parseUstarHeader(header: Uint8Array): ParsedUstarHeader {
  if (header.length !== BLOCK_SIZE) {
    throw new TarCorruptionError(
      `Header must be ${BLOCK_SIZE} bytes, got ${header.length}`,
    );
  }

  return {
    name: parseString(header, NAME_OFFSET, NAME_LENGTH),
    prefix: parseString(header, PREFIX_OFFSET, PREFIX_LENGTH),
    mode: parseOctal(header, MODE_OFFSET, MODE_LENGTH),
    uid: parseOctal(header, UID_OFFSET, UID_LENGTH),
    gid: parseOctal(header, GID_OFFSET, GID_LENGTH),
    size: parseOctal(header, SIZE_OFFSET, SIZE_LENGTH),
    mtimeSeconds: parseOctal(header, MTIME_OFFSET, MTIME_LENGTH),
    storedChecksum: readStoredChecksum(header),
    computedChecksum: computeChecksum(header),
    typeflag: parseString(header, TYPEFLAG_OFFSET, 1),
    linkname: parseString(header, LINKNAME_OFFSET, LINKNAME_LENGTH),
    magic: parseString(header, MAGIC_OFFSET, MAGIC_LENGTH),
    version: parseString(header, VERSION_OFFSET, VERSION_LENGTH),
    uname: parseString(header, UNAME_OFFSET, UNAME_LENGTH),
    gname: parseString(header, GNAME_OFFSET, GNAME_LENGTH),
    devmajor: parseOctal(header, DEVMAJOR_OFFSET, DEVMAJOR_LENGTH),
    devminor: parseOctal(header, DEVMINOR_OFFSET, DEVMINOR_LENGTH),
  };
}

/**
 * Combine ustar's name + prefix fields into a single path string.
 * Empty prefix means "use name as-is."
 */
export function joinPath(name: string, prefix: string): string {
  if (prefix.length === 0) return name;
  return prefix + "/" + name;
}

// ---------------------------------------------------------------------------
// Header encoding
//
// Build a 512-byte ustar header from a set of fields. Caller is
// responsible for splitting long names into name+prefix when possible
// and for emitting PAX records when fields don't fit.
// ---------------------------------------------------------------------------

export interface UstarHeaderFields {
  name: string | Uint8Array;            // up to NAME_LENGTH bytes UTF-8
  prefix?: string | Uint8Array;         // up to PREFIX_LENGTH bytes UTF-8
  mode: number;
  uid: number;
  gid: number;
  size: number;            // 0 for directories, symlinks, hardlinks
  mtimeSeconds: number;    // integer seconds since epoch
  typeflag: string;        // single character
  linkname?: string | Uint8Array;       // for symlinks/hardlinks
  uname?: string;
  gname?: string;
}

export function encodeUstarHeader(fields: UstarHeaderFields): Uint8Array {
  const buf = new Uint8Array(BLOCK_SIZE);

  if (fields.name instanceof Uint8Array) {
    writeBytes(buf, NAME_OFFSET, NAME_LENGTH, fields.name);
  } else {
    writeString(buf, NAME_OFFSET, NAME_LENGTH, fields.name);
  }
  if (fields.prefix) {
    if (fields.prefix instanceof Uint8Array) {
      writeBytes(buf, PREFIX_OFFSET, PREFIX_LENGTH, fields.prefix);
    } else {
      writeString(buf, PREFIX_OFFSET, PREFIX_LENGTH, fields.prefix);
    }
  }
  writeOctal(buf, MODE_OFFSET, MODE_LENGTH, fields.mode);
  writeOctal(buf, UID_OFFSET, UID_LENGTH, fields.uid);
  writeOctal(buf, GID_OFFSET, GID_LENGTH, fields.gid);
  writeOctal(buf, SIZE_OFFSET, SIZE_LENGTH, fields.size);
  writeOctal(buf, MTIME_OFFSET, MTIME_LENGTH, fields.mtimeSeconds);

  // Initially fill the checksum field with spaces, per the spec —
  // computeChecksum already treats it as spaces, so this is just for
  // honesty when readers inspect the raw bytes.
  for (let i = 0; i < CHKSUM_LENGTH; i++) {
    buf[CHKSUM_OFFSET + i] = 0x20;
  }

  buf[TYPEFLAG_OFFSET] = fields.typeflag.charCodeAt(0);

  if (fields.linkname) {
    if (fields.linkname instanceof Uint8Array) {
      writeBytes(buf, LINKNAME_OFFSET, LINKNAME_LENGTH, fields.linkname);
    } else {
      writeString(buf, LINKNAME_OFFSET, LINKNAME_LENGTH, fields.linkname);
    }
  }

  writeBytes(buf, MAGIC_OFFSET, MAGIC_LENGTH, encoder.encode(MAGIC_USTAR));
  writeBytes(buf, VERSION_OFFSET, VERSION_LENGTH, encoder.encode(VERSION_USTAR));

  if (fields.uname) writeString(buf, UNAME_OFFSET, UNAME_LENGTH, fields.uname);
  if (fields.gname) writeString(buf, GNAME_OFFSET, GNAME_LENGTH, fields.gname);

  // devmajor/devminor stay zero — we don't support device files in the writer.

  // Compute and write the real checksum.
  const checksum = computeChecksum(buf);
  writeChecksum(buf, checksum);

  return buf;
}

// ---------------------------------------------------------------------------
// Field-fits-in-ustar checks — used to decide if PAX is needed
// ---------------------------------------------------------------------------

/**
 * Try to split a path into (name, prefix) such that name fits in
 * NAME_LENGTH bytes and prefix fits in PREFIX_LENGTH bytes, with the
 * split happening at a "/" boundary. Returns null if no such split exists.
 *
 * Both halves measured as UTF-8 byte length, NOT character count.
 */
export function trySplitPath(path: string): { name: string; prefix: string } | null {
  const fullBytes = encoder.encode(path);
  if (fullBytes.length <= NAME_LENGTH) {
    // Whole path fits in name field — no prefix needed.
    return { name: path, prefix: "" };
  }

  // Find the last "/" such that everything after fits in NAME_LENGTH bytes
  // and everything before fits in PREFIX_LENGTH bytes.
  for (let splitChar = path.lastIndexOf("/"); splitChar > 0; splitChar = path.lastIndexOf("/", splitChar - 1)) {
    const prefix = path.substring(0, splitChar);
    const name = path.substring(splitChar + 1);
    const prefixBytes = encoder.encode(prefix).length;
    const nameBytes = encoder.encode(name).length;
    if (nameBytes <= NAME_LENGTH && prefixBytes <= PREFIX_LENGTH) {
      return { name, prefix };
    }
  }

  return null;
}

/**
 * Truncate a string so that its UTF-8 byte length is at most `maxBytes`,
 * cutting at a character boundary (never mid-codepoint). Used to produce
 * fallback ustar field values when the full value is being carried in a
 * PAX record.
 *
 * Returns a string whose UTF-8 encoding is guaranteed to fit. If even
 * the first character exceeds maxBytes, returns the empty string.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  // Walk codepoints (not UTF-16 code units) so surrogate pairs stay intact.
  let acc = "";
  let accBytes = 0;
  for (const ch of value) {
    const chBytes = encoder.encode(ch).length;
    if (accBytes + chBytes > maxBytes) break;
    acc += ch;
    accBytes += chBytes;
  }
  return acc;
}

/**
 * Returns true if all fields can be expressed in ustar without PAX records.
 */
export function fitsInUstar(fields: {
  path: string;
  size: number;
  uid: number;
  gid: number;
  linkname?: string;
}): boolean {
  if (trySplitPath(fields.path) === null) return false;
  if (fields.size > USTAR_MAX_SIZE) return false;
  if (fields.uid > USTAR_MAX_UID) return false;
  if (fields.gid > USTAR_MAX_UID) return false;
  if (fields.linkname && encoder.encode(fields.linkname).length > LINKNAME_LENGTH) {
    return false;
  }
  return true;
}
