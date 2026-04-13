import type { Source, Transform } from "@culvert/stream";

// ---------------------------------------------------------------------------
// Public types — Writer
// ---------------------------------------------------------------------------

/**
 * Options for adding a file to a ZIP archive.
 *
 * The discriminated union enforces: if you bring your own compressor,
 * you must also provide the ZIP compression method number. TypeScript
 * prevents a transform without a header value.
 */
export type AddFileOptions = {
  /** Path within the archive. Forward slashes. No leading slash. */
  name: string;

  /** File data as an async iterable of byte chunks. */
  source: Source<Uint8Array>;

  /** Defaults to now. */
  lastModified?: Date;

  /** Per-entry comment stored in the central directory. */
  comment?: string;

  /** Cancel this individual file. */
  signal?: AbortSignal;
} & (
  | { compression?: "deflate" | "store" }
  | { compress: Transform<Uint8Array, Uint8Array>; compressionMethod: number }
);

/**
 * A single entry from a ZIP archive, yielded by readZipEntries().
 *
 * Metadata available immediately: name, compressionMethod, lastModified.
 * Lazy metadata (compressedSize, uncompressedSize, crc32): returns 0
 * with a console.warn() if accessed before source is fully consumed.
 */
export interface ZipEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly lastModified: Date;

  /** Decompressed file data. Pull-based — backpressure is structural. */
  readonly source: Source<Uint8Array>;

  /** Available after source is fully consumed. */
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
}

// ---------------------------------------------------------------------------
// Public types — Random-access reader
// ---------------------------------------------------------------------------

/**
 * A seekable byte source for random-access ZIP reading.
 *
 * Two reads to open any archive: one for the EOCD, one for the
 * central directory. Then each file is one local-header read
 * plus chunked data reads.
 *
 * Wrapping platform primitives is one line:
 *   fromBuffer(bytes)   → Uint8Array (testing, small archives)
 *   fromBlob(file)      → Browser File/Blob
 *
 * Node.js fs.FileHandle example:
 *   const handle = await open("archive.zip");
 *   const stat = await handle.stat();
 *   const seekable: ZipSeekable = {
 *     size: stat.size,
 *     read: async (offset, length) => {
 *       const buf = new Uint8Array(length);
 *       const { bytesRead } = await handle.read(buf, 0, length, offset);
 *       return buf.subarray(0, bytesRead);
 *     },
 *     close: () => handle.close(),
 *   };
 */
export interface ZipSeekable {
  /** Total size in bytes. */
  readonly size: number;

  /** Read `length` bytes starting at byte `offset`. */
  read(offset: number, length: number): Promise<Uint8Array>;

  /**
   * Release the underlying resource (file handle, etc.).
   * Called by OpenZipArchive.close(). Optional — omit for
   * in-memory sources like fromBuffer().
   */
  close?(): Promise<void>;
}

/**
 * A parsed central directory entry. All metadata available
 * immediately after openZip() — no I/O required.
 *
 * This is the read-path counterpart to CentralDirectoryEntry.
 * Names and comments are decoded strings (not raw Uint8Array)
 * because the reader needs them for display and lookup, not
 * for building binary structures.
 */
export interface ZipDirectoryEntry {
  readonly name: string;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly lastModified: Date;
  readonly comment: string;
}

/**
 * An opened ZIP archive for random-access reading.
 * Returned by openZip(). Holds the seekable source open
 * until close() is called.
 *
 * Usage:
 *   const archive = await openZip(seekable);
 *   const entry = archive.entry("page-0437.jpg");
 *   const bytes = await pipe(archive.source(entry), collectBytes());
 *   await archive.close();
 */
export interface OpenZipArchive {
  /** All entries parsed from the central directory, in archive order. */
  readonly entries: readonly ZipDirectoryEntry[];

  /**
   * Look up an entry by exact name. Returns undefined if not found.
   * O(1) via internal Map.
   */
  entry(name: string): ZipDirectoryEntry | undefined;

  /**
   * Get decompressed file data for an entry. Returns a
   * Source<Uint8Array> that seeks to the entry's byte offset
   * and decompresses on demand.
   *
   * Each call creates a fresh source — safe to call multiple times
   * for the same entry. Once you have the source, everything
   * composes with pipe() normally.
   */
  source(entry: ZipDirectoryEntry): Source<Uint8Array>;

  /** Release the underlying seekable resource. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types — Writer
// ---------------------------------------------------------------------------

/** Accumulated per-file metadata for the central directory. */
export interface CentralDirectoryEntry {
  name: Uint8Array;
  comment: Uint8Array;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  lastModified: Date;
}

/** The archive handle passed to the createZip callback. */
export interface ZipArchive {
  addFile(options: AddFileOptions): Promise<void>;
}
