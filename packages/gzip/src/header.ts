import {
  GZIP_ID1,
  GZIP_ID2,
  CM_DEFLATE,
  HEADER_SIZE,
  FOOTER_SIZE,
  FNAME,
  FCOMMENT,
  OS_UNKNOWN,
  XFL_DEFAULT,
  FLG_RESERVED_MASK,
  FEXTRA,
  FHCRC,
} from "./constants.js";
import { GzipCorruptionError } from "./errors.js";

// ---------------------------------------------------------------------------
// Latin-1 encoding helpers
//
// RFC 1952 specifies ISO 8859-1 for FNAME and FCOMMENT fields.
// Characters outside 0x00-0xFF are silently dropped.
// Null bytes are stripped (they serve as terminators).
// ---------------------------------------------------------------------------

function toLatin1Bytes(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 0 && code <= 0xff) {
      bytes.push(code);
    }
    // Characters outside Latin-1 or null are silently dropped.
  }
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Little-endian uint32 helpers
// ---------------------------------------------------------------------------

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
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
// Header building (compressor)
//
// Returns the complete gzip header as a Uint8Array.
// Handles optional FNAME and FCOMMENT fields.
// ---------------------------------------------------------------------------

export interface BuildHeaderOptions {
  mtime: Date;
  filename?: string;
  comment?: string;
}

export function buildGzipHeader(options: BuildHeaderOptions): Uint8Array {
  const filenameBytes = options.filename
    ? toLatin1Bytes(options.filename)
    : null;
  const commentBytes = options.comment ? toLatin1Bytes(options.comment) : null;

  let flg = 0;
  let extraSize = 0;

  if (filenameBytes && filenameBytes.length > 0) {
    flg |= FNAME;
    extraSize += filenameBytes.length + 1; // +1 for null terminator
  }
  if (commentBytes && commentBytes.length > 0) {
    flg |= FCOMMENT;
    extraSize += commentBytes.length + 1; // +1 for null terminator
  }

  const header = new Uint8Array(HEADER_SIZE + extraSize);

  // Fixed header (10 bytes)
  header[0] = GZIP_ID1;
  header[1] = GZIP_ID2;
  header[2] = CM_DEFLATE;
  header[3] = flg;

  // MTIME: Unix timestamp as uint32 LE. Out-of-range dates (pre-1970,
  // post-2106) clamp to 0 — RFC 1952's "no time stamp available" — since
  // wrapping modulo 2^32 would record a silently wrong timestamp.
  const seconds = Math.floor(options.mtime.getTime() / 1000);
  const mtime = seconds >= 0 && seconds <= 0xffffffff ? seconds : 0;
  writeUint32LE(header, 4, mtime);

  header[8] = XFL_DEFAULT;
  header[9] = OS_UNKNOWN;

  // Optional fields (order per RFC 1952: FEXTRA, FNAME, FCOMMENT, FHCRC)
  let offset = HEADER_SIZE;

  if (filenameBytes && filenameBytes.length > 0) {
    header.set(filenameBytes, offset);
    offset += filenameBytes.length;
    header[offset++] = 0x00; // null terminator
  }

  if (commentBytes && commentBytes.length > 0) {
    header.set(commentBytes, offset);
    offset += commentBytes.length;
    header[offset++] = 0x00; // null terminator
  }

  return header;
}

// ---------------------------------------------------------------------------
// Footer building (compressor)
// ---------------------------------------------------------------------------

export function buildGzipFooter(crc32: number, size: number): Uint8Array {
  const footer = new Uint8Array(FOOTER_SIZE);
  writeUint32LE(footer, 0, crc32 >>> 0);
  writeUint32LE(footer, 4, size % 0x100000000 >>> 0); // ISIZE mod 2^32
  return footer;
}

// ---------------------------------------------------------------------------
// Header parsing (decompressor)
//
// Reads the fixed 10-byte header from a buffer and validates it.
// Returns the FLG byte for the caller to process optional fields.
// ---------------------------------------------------------------------------

export interface ParsedFixedHeader {
  flg: number;
  mtime: number; // Unix timestamp
  xfl: number;
  os: number;
}

export function parseFixedHeader(buf: Uint8Array): ParsedFixedHeader {
  if (buf.length < HEADER_SIZE) {
    throw new GzipCorruptionError(
      `Gzip header too short: expected ${HEADER_SIZE} bytes, got ${buf.length}`,
    );
  }

  if (buf[0] !== GZIP_ID1 || buf[1] !== GZIP_ID2) {
    throw new GzipCorruptionError(
      `Invalid gzip magic bytes: expected 0x1f 0x8b, got 0x${buf[0]!
        .toString(16)
        .padStart(2, "0")} 0x${buf[1]!.toString(16).padStart(2, "0")}`,
    );
  }

  if (buf[2] !== CM_DEFLATE) {
    throw new GzipCorruptionError(
      `Unsupported compression method: expected ${CM_DEFLATE} (DEFLATE), got ${buf[2]}`,
    );
  }

  const flg = buf[3]!;
  if (flg & FLG_RESERVED_MASK) {
    throw new GzipCorruptionError(
      `Reserved FLG bits are set: 0x${flg.toString(
        16,
      )}. This may indicate a newer gzip format.`,
    );
  }

  return {
    flg,
    mtime: readUint32LE(buf, 4),
    xfl: buf[8]!,
    os: buf[9]!,
  };
}
