import { CRC32 } from "@culvert/crc32";
import type { Source } from "@culvert/stream";

import {
  findEOCD,
  parseCentralDirectory,
  parseLocalHeaderDataOffset,
  parseZip64EOCDRecord,
  ZIP64_EOCD_FIXED_SIZE,
} from "./binary-reader.js";
import { identityTransform, inflateRaw } from "./deflate.js";
import { ZipCorruptionError } from "./errors.js";
import type {
  OpenZipArchive,
  ZipDirectoryEntry,
  ZipSeekable,
} from "./types.js";
import {
  COMPRESSION_DEFLATE,
  EOCD_SEARCH_SIZE,
  LOCAL_HEADER_FIXED_SIZE,
  READ_CHUNK_SIZE,
} from "./constants.js";

// ---------------------------------------------------------------------------
// openZip()
//
// Opens a ZIP archive for random-access reading. Two seeks, two reads:
//
//   1. Read the tail of the file to find the EOCD (the signpost)
//   2. Read the central directory at the offset EOCD points to
//
// Returns an OpenZipArchive with full entry metadata and on-demand
// decompression. No file data is read until you call source().
// ---------------------------------------------------------------------------

export async function openZip(
  seekable: ZipSeekable,
): Promise<OpenZipArchive> {
  if (seekable.size === 0) {
    throw new ZipCorruptionError("Cannot open an empty file as a ZIP archive");
  }

  // --- Hop 1: Find the EOCD ---
  const tailSize = Math.min(seekable.size, EOCD_SEARCH_SIZE);
  const tail = await seekable.read(seekable.size - tailSize, tailSize);
  let eocd = findEOCD(tail);

  // --- Hop 1b: For ZIP64, read the ZIP64 EOCD record ---
  // The standard EOCD held sentinel values; the real numbers live
  // in the ZIP64 EOCD record pointed to by the ZIP64 locator.
  if (eocd.zip64EocdOffset !== null) {
    const zip64Bytes = await seekable.read(
      eocd.zip64EocdOffset,
      ZIP64_EOCD_FIXED_SIZE,
    );
    const zip64 = parseZip64EOCDRecord(zip64Bytes);
    eocd = {
      entryCount: zip64.entryCount,
      centralDirectorySize: zip64.centralDirectorySize,
      centralDirectoryOffset: zip64.centralDirectoryOffset,
      zip64EocdOffset: eocd.zip64EocdOffset,
    };
  }

  // --- Hop 2: Read the central directory ---
  const cdBytes = await seekable.read(
    eocd.centralDirectoryOffset,
    eocd.centralDirectorySize,
  );
  const entries = parseCentralDirectory(cdBytes);

  // Validate entry count against EOCD
  if (entries.length !== eocd.entryCount) {
    throw new ZipCorruptionError(
      `EOCD declares ${eocd.entryCount} entries but ` +
        `central directory contains ${entries.length}`,
    );
  }

  // Build name → index map for O(1) lookups
  const nameIndex = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    nameIndex.set(entries[i]!.name, i);
  }

  return {
    entries,

    entry(name: string): ZipDirectoryEntry | undefined {
      const idx = nameIndex.get(name);
      return idx !== undefined ? entries[idx] : undefined;
    },

    source(entry: ZipDirectoryEntry): Source<Uint8Array> {
      return entrySource(seekable, entry);
    },

    async close(): Promise<void> {
      await seekable.close?.();
    },
  };
}

// ---------------------------------------------------------------------------
// entrySource()
//
// Turns a central directory entry + seekable into a Source<Uint8Array>
// of decompressed, CRC-verified file data.
//
// Three steps, all reusing existing primitives:
//   1. seekChunks()        — seek-read compressed bytes as a Source
//   2. inflateRaw()        — decompress (or identityTransform for store)
//   3. CRC/size validation — verify integrity after decompression
//
// Once inside this function, everything is Source<Uint8Array> and
// composes with pipe() normally. The random-access world ends here.
// ---------------------------------------------------------------------------

function entrySource(
  seekable: ZipSeekable,
  entry: ZipDirectoryEntry,
): Source<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      // Bridge from seek to stream
      const compressed = seekChunks(seekable, entry);

      // Pick the right decompression transform — same ones the writer uses
      const decompress =
        entry.compressionMethod === COMPRESSION_DEFLATE
          ? inflateRaw()
          : identityTransform();

      const decompressed = decompress(compressed);

      // Verify CRC and size as data flows through
      const crc = new CRC32();
      let totalSize = 0;

      for await (const chunk of decompressed) {
        crc.update(chunk);
        totalSize += chunk.length;
        yield chunk;
      }

      // CRC verification — skip if CRC is zero (shouldn't happen in
      // well-formed archives, but some tools write 0 for directories)
      const computed = crc.digest();
      if (entry.crc32 !== 0 && computed !== entry.crc32) {
        throw new ZipCorruptionError(
          `CRC-32 mismatch for "${entry.name}": ` +
            `expected 0x${entry.crc32.toString(16).padStart(8, "0")}, ` +
            `got 0x${computed.toString(16).padStart(8, "0")}`,
        );
      }

      // Size verification
      if (entry.uncompressedSize !== 0 && totalSize !== entry.uncompressedSize) {
        throw new ZipCorruptionError(
          `Size mismatch for "${entry.name}": ` +
            `expected ${entry.uncompressedSize} bytes, ` +
            `got ${totalSize}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// seekChunks()
//
// The bridge from random access back to Source<Uint8Array>.
//
// Reads the 30-byte fixed portion of the local header to find where
// file data starts (skipping the variable-length name and extra fields),
// then yields compressed data in READ_CHUNK_SIZE chunks.
//
// Once you're past this function, everything reuses what @culvert/stream
// already provides. inflateRaw() doesn't know or care that its input
// came from seeks instead of a forward stream.
// ---------------------------------------------------------------------------

async function* seekChunks(
  seekable: ZipSeekable,
  entry: ZipDirectoryEntry,
): AsyncGenerator<Uint8Array> {
  // Read just the fixed portion of the local header — 30 bytes
  const localHeader = await seekable.read(
    entry.localHeaderOffset,
    LOCAL_HEADER_FIXED_SIZE,
  );

  // The two variable-length fields (name, extra) tell us where data starts
  const dataOffset = parseLocalHeaderDataOffset(
    localHeader,
    entry.localHeaderOffset,
  );

  // Yield compressed data in chunks — backpressure flows naturally
  // through the async generator. If the consumer is slow, we don't
  // read ahead.
  let remaining = entry.compressedSize;
  let position = dataOffset;

  while (remaining > 0) {
    const chunkSize = Math.min(remaining, READ_CHUNK_SIZE);
    yield await seekable.read(position, chunkSize);
    position += chunkSize;
    remaining -= chunkSize;
  }
}

// ---------------------------------------------------------------------------
// ZipSeekable bridge helpers
//
// Thin adapters from platform I/O primitives to ZipSeekable.
// Each is a one-liner because ZipSeekable's interface is minimal:
// size (a number) and read (offset + length → bytes).
// ---------------------------------------------------------------------------

/**
 * Create a ZipSeekable from a Uint8Array.
 * Useful for testing and small archives already in memory.
 */
export function fromBuffer(buffer: Uint8Array): ZipSeekable {
  return {
    size: buffer.length,
    read: async (offset, length) => buffer.slice(offset, offset + length),
  };
}

/**
 * Create a ZipSeekable from a Blob or File (browser).
 * Blob.slice() is lazy — no data is copied until the slice is read.
 */
export function fromBlob(blob: Blob): ZipSeekable {
  return {
    size: blob.size,
    read: async (offset, length) => {
      const slice = blob.slice(offset, offset + length);
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}
