import type { Transform, Source } from "@culvert/stream";
import { CRC32 } from "@culvert/crc32";
import { GzipCorruptionError, GzipAbortError } from "./errors.js";
import { parseFixedHeader, readUint32LE } from "./header.js";
import { createByteReader } from "./byte-reader.js";
import type { Inflator, GunzipOptions } from "./types.js";
import {
  GZIP_ID1,
  GZIP_ID2,
  HEADER_SIZE,
  FOOTER_SIZE,
  FEXTRA,
  FNAME,
  FCOMMENT,
  FHCRC,
} from "./constants.js";

// ---------------------------------------------------------------------------
// gunzip — streaming gzip decompressor with codec.
//
// Owns the full decompression pipeline:
// - Header parsing and validation
// - Delegates raw DEFLATE to the injected Inflator codec
// - CRC-32 verification via @culvert/crc32
// - ISIZE verification
// - Concatenated member support (RFC 1952 §2.2)
// - Corruption policy (strict / permissive)
//
// The Inflator codec processes one chunk at a time and reports how
// many bytes it consumed. This solves the DEFLATE boundary problem:
// when the codec says done, the unconsumed bytes are pushed back
// to the byte reader, and the next 8 bytes are the footer.
// ---------------------------------------------------------------------------

/**
 * Streaming gzip decompressor.
 *
 * @param inflator - A raw DEFLATE decompressor implementing the Inflator interface.
 * @param options  - CRC policy and abort signal.
 * @returns A Transform that decompresses gzip streams, including concatenated members.
 *
 * @example
 * ```ts
 * await pipe(source, gunzip(myInflator), writeTo("output.txt"));
 * ```
 */
export function gunzip(
  inflator: Inflator,
  options: GunzipOptions = {},
): Transform<Uint8Array, Uint8Array> {
  const strict = (options.crcPolicy ?? "strict") === "strict";

  return async function* (source: Source<Uint8Array>) {
    if (options.signal?.aborted) {
      throw new GzipAbortError();
    }

    const reader = createByteReader(source);
    let hasProcessedMember = false;

    // --- Concatenated member loop (RFC 1952 §2.2) ---
    while (true) {
      // Peek for gzip magic bytes. EOF = done. Non-magic after a member = trailing
      // bytes, also done. Non-magic at the start = malformed stream.
      const magic = await reader.peekBytes(2);
      if (magic === null) break;
      if (magic[0] !== GZIP_ID1 || magic[1] !== GZIP_ID2) {
        if (!hasProcessedMember) {
          throw new GzipCorruptionError(
            `Invalid gzip magic bytes: expected 0x${GZIP_ID1.toString(16).padStart(2, "0")} 0x${GZIP_ID2.toString(16).padStart(2, "0")}, got 0x${magic[0]!.toString(16).padStart(2, "0")} 0x${magic[1]!.toString(16).padStart(2, "0")}`,
          );
        }
        break;
      }

      // --- Parse fixed header (10 bytes) ---
      const headerBuf = await reader.readExact(HEADER_SIZE);
      const header = parseFixedHeader(headerBuf);

      // --- Skip optional fields per FLG bits ---
      // Order per RFC 1952 §2.3.1: FEXTRA, FNAME, FCOMMENT, FHCRC
      //
      // When FHCRC is present, every header byte up to the CRC16 field
      // feeds a CRC-32 whose low 16 bits must match it (§2.3.1). The
      // producer supplied that checksum precisely so header corruption
      // is detectable — discarding it would leave strict mode blind to
      // a flipped bit in MTIME, FNAME, or the extra field.
      const headerCrc = header.flg & FHCRC ? new CRC32() : null;
      headerCrc?.update(headerBuf);

      if (header.flg & FEXTRA) {
        const lenBuf = await reader.readExact(2);
        headerCrc?.update(lenBuf);
        const extraLen = lenBuf[0]! | (lenBuf[1]! << 8);
        const extra = await reader.readExact(extraLen); // content discarded
        headerCrc?.update(extra);
      }

      if (header.flg & FNAME) {
        // Read until null terminator
        while (true) {
          const byte = await reader.readExact(1);
          headerCrc?.update(byte);
          if (byte[0] === 0x00) break;
        }
      }

      if (header.flg & FCOMMENT) {
        while (true) {
          const byte = await reader.readExact(1);
          headerCrc?.update(byte);
          if (byte[0] === 0x00) break;
        }
      }

      if (header.flg & FHCRC) {
        const crc16Buf = await reader.readExact(2);
        if (strict) {
          const stored = crc16Buf[0]! | (crc16Buf[1]! << 8);
          const computed = headerCrc!.digest() & 0xffff;
          if (computed !== stored) {
            throw new GzipCorruptionError(
              `Header CRC-16 mismatch: expected 0x${stored
                .toString(16)
                .padStart(4, "0")}, got 0x${computed.toString(16).padStart(4, "0")}`,
            );
          }
        }
      }

      // --- Inflate via codec ---
      const crc = new CRC32();
      let size = 0;

      while (true) {
        if (options.signal?.aborted) {
          throw new GzipAbortError();
        }

        const chunk = await reader.pull();
        if (chunk === null) {
          throw new GzipCorruptionError(
            "Unexpected end of gzip stream: DEFLATE data truncated",
          );
        }

        // A codec rejecting its input is stream corruption — wrap it in
        // the taxonomy so callers can catch GzipCorruptionError, not a
        // codec-specific error type.
        let result;
        try {
          result = inflator.inflate(chunk);
        } catch (err) {
          throw new GzipCorruptionError(
            `DEFLATE data is corrupt: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (result.output.length > 0) {
          crc.update(result.output);
          size += result.output.length;
          yield result.output;
        }

        // Push back unconsumed bytes
        if (result.consumed < chunk.length) {
          reader.pushBack(chunk.subarray(result.consumed));
        }

        if (result.done) break;
      }

      // --- Read and verify footer (8 bytes) ---
      const footer = await reader.readExact(FOOTER_SIZE);
      const expectedCrc = readUint32LE(footer, 0);
      const expectedIsize = readUint32LE(footer, 4);

      if (strict) {
        if (crc.digest() !== expectedCrc) {
          throw new GzipCorruptionError(
            `CRC-32 mismatch: expected 0x${expectedCrc
              .toString(16)
              .padStart(8, "0")}, ` +
              `got 0x${crc.digest().toString(16).padStart(8, "0")}`,
          );
        }
        if (size % 0x100000000 !== expectedIsize) {
          throw new GzipCorruptionError(
            `ISIZE mismatch: expected ${expectedIsize}, got ${
              size % 0x100000000
            }`,
          );
        }
      }

      // Reset codec for next concatenated member
      inflator.reset();
      hasProcessedMember = true;

      // Loop continues — peekBytes(2) will check for next member
    }
  };
}
