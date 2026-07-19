import type { Transform, Source } from "@culvert/stream";
import { CRC32 } from "@culvert/crc32";
import { buildGzipHeader, buildGzipFooter } from "./header.js";
import { GzipAbortError } from "./errors.js";
import type { Deflator, GzipOptions } from "./types.js";

// ---------------------------------------------------------------------------
// EPOCH — reproducible-build mtime default.
// ---------------------------------------------------------------------------

const EPOCH = new Date(0);

// ---------------------------------------------------------------------------
// gzip — streaming gzip compressor.
//
// Takes a Deflator codec and optional framing options. Returns a
// Transform<Uint8Array, Uint8Array> that wraps the input in gzip
// framing (RFC 1952).
//
// The Deflator handles raw DEFLATE (RFC 1951). This function handles
// header, footer, CRC-32 (via @culvert/crc32), and ISIZE.
// ---------------------------------------------------------------------------

/**
 * Streaming gzip compressor.
 *
 * @param deflator - A raw DEFLATE compressor implementing the Deflator interface.
 * @param options  - Gzip header options (filename, comment, mtime) and abort signal.
 * @returns A Transform that compresses input bytes into a gzip stream.
 *
 * @example
 * ```ts
 * await pipe(source, gzip(myDeflator), writeTo("output.gz"));
 * ```
 */
export function gzip(
  deflator: Deflator,
  options: GzipOptions = {},
): Transform<Uint8Array, Uint8Array> {
  return async function* (source: Source<Uint8Array>) {
    if (options.signal?.aborted) {
      throw new GzipAbortError();
    }

    // --- Header ---
    yield buildGzipHeader({
      mtime: options.mtime ?? EPOCH,
      filename: options.filename,
      comment: options.comment,
    });

    // --- Compressed data ---
    // Pull chunks from the source, compress via the codec, and yield.
    // We need a one-chunk lookahead to know when to pass final=true.

    const crc = new CRC32();
    let totalSize = 0;

    const iter = source[Symbol.asyncIterator]();
    let next = await iter.next();

    while (!next.done) {
      if (options.signal?.aborted) {
        throw new GzipAbortError();
      }

      const chunk = next.value;
      crc.update(chunk);
      totalSize += chunk.length;

      // Peek ahead to determine if this is the last chunk
      next = await iter.next();
      const isFinal = next.done === true;

      const compressed = deflator.deflate(chunk, isFinal);
      if (compressed.length > 0) {
        yield compressed;
      }
    }

    // --- Footer ---
    yield buildGzipFooter(crc.digest(), totalSize);
  };
}
