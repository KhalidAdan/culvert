// ---------------------------------------------------------------------------
// Codec interfaces
//
// The user provides these. The package handles gzip framing around them.
// ---------------------------------------------------------------------------

/**
 * Result of a single inflate call. The three fields solve the
 * DEFLATE boundary problem:
 * - `output`: decompressed bytes (may be empty on a given call)
 * - `consumed`: how many input bytes were used from this chunk
 * - `done`: BFINAL seen — the DEFLATE stream is complete
 */
export interface InflateResult {
  output: Uint8Array;
  consumed: number;
  done: boolean;
}

/**
 * A raw DEFLATE decompressor (RFC 1951).
 *
 * Stateful, synchronous, chunk-at-a-time. The framing layer calls
 * `inflate()` with chunks from the byte reader and uses `consumed`
 * to track the stream position. When `done` is true, the remaining
 * bytes in the chunk are pushed back to the reader — the next bytes
 * are the gzip footer.
 *
 * `reset()` reinitializes internal state for the next concatenated
 * gzip member. Each member contains a separate DEFLATE stream.
 *
 * Libraries with zlib-heritage APIs (pako, wasm-zlib) expose the
 * fields needed to implement this interface. See the README for
 * wrapper examples.
 */
export interface Inflator {
  inflate(chunk: Uint8Array): InflateResult;
  reset(): void;
}

/**
 * A raw DEFLATE compressor (RFC 1951).
 *
 * `deflate(chunk, final)` compresses the input. When `final` is
 * true, the compressor flushes and emits the BFINAL block.
 */
export interface Deflator {
  deflate(chunk: Uint8Array, final: boolean): Uint8Array;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GzipOptions {
  /** Original filename, stored in gzip header (FNAME). ISO 8859-1. */
  filename?: string;
  /**
   * Modification time, stored in gzip header.
   * Defaults to epoch (Unix time 0) for reproducible output.
   */
  mtime?: Date;
  /** Comment, stored in gzip header (FCOMMENT). ISO 8859-1. */
  comment?: string;
  /** Cancel compression. */
  signal?: AbortSignal;
}

/**
 * Parsed gzip member header metadata (RFC 1952 §2.3.1), surfaced via
 * `GunzipOptions.onHeader`.
 */
export interface GzipHeader {
  /** MTIME field. `null` when the field is 0 — "no time stamp available". */
  mtime: Date | null;
  /** FNAME, decoded as ISO 8859-1. `null` when the field is absent. */
  filename: string | null;
  /** FCOMMENT, decoded as ISO 8859-1. `null` when the field is absent. */
  comment: string | null;
  /** Raw FEXTRA payload, subfields undecoded. `null` when absent. */
  extra: Uint8Array | null;
  /** XFL byte — compressor hints (2 = max compression, 4 = fastest). */
  xfl: number;
  /** OS byte (RFC 1952 §2.3.1 table; 255 = unknown). */
  os: number;
}

export interface GunzipOptions {
  /**
   * CRC-32 and ISIZE validation policy.
   *
   * - `'strict'` (default) — throw GzipCorruptionError on mismatch.
   * - `'permissive'` — ignore mismatches, yield data anyway.
   */
  crcPolicy?: "strict" | "permissive";
  /**
   * Observe each member's header metadata — an observer in the spirit
   * of `tap()`, called once per gzip member (concatenated streams have
   * several) with a 0-based member index, after the header has been
   * parsed and (in strict mode) FHCRC-verified, and before any of that
   * member's data is yielded. Exceptions propagate and tear the
   * pipeline down. When omitted, header fields are skipped without
   * being retained.
   */
  onHeader?: (header: GzipHeader, memberIndex: number) => void;
  /** Cancel decompression. */
  signal?: AbortSignal;
}
