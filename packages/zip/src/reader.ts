import { CRC32 } from "@culvert/crc32";
import type { Source } from "@culvert/stream";

import { StreamingByteReader } from "./byte-reader.js";
import {
  FLAG_DATA_DESCRIPTOR,
  SIG_DATA_DESCRIPTOR,
  SIG_LOCAL_FILE,
} from "./constants.js";
import { identityTransform, inflateRaw } from "./deflate.js";
import { dosToDate } from "./dos-time.js";
import { ZipCorruptionError } from "./errors.js";
import type { ZipEntry } from "./types.js";

// ---------------------------------------------------------------------------
// readZipEntries()
//
// Forward-only streaming reader. Takes a Source<Uint8Array> of raw ZIP
// bytes and yields ZipEntry objects for each file encountered.
//
// Processes local file headers sequentially. Entry data is consumed
// via the standard pull model — if you don't read an entry's source,
// it's silently drained when you advance to the next entry.
//
// CRC-32 is verified automatically after each entry's source is
// consumed. Throws ZipCorruptionError on mismatch.
//
// Lazy properties (compressedSize, uncompressedSize, crc32) return 0
// with a console.warn() until the entry source is fully consumed.
//
// No ZIP64 support: sizes are read from the 32-bit local header fields
// and the extra field is skipped, so entries >= 4 GiB are unreadable
// here. Use openZip() for large archives.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

interface LocalHeaderInfo {
  name: string;
  compressionMethod: number;
  lastModified: Date;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  hasDataDescriptor: boolean;
}

async function parseLocalHeader(
  reader: StreamingByteReader,
): Promise<LocalHeaderInfo> {
  // Signature already peeked — consume it
  const sig = await reader.readUint32LE();
  if (sig !== SIG_LOCAL_FILE) {
    throw new ZipCorruptionError(
      `Invalid local file header signature: 0x${sig
        .toString(16)
        .padStart(8, "0")}`,
    );
  }

  const _versionNeeded = await reader.readUint16LE();
  const flags = await reader.readUint16LE();
  const compressionMethod = await reader.readUint16LE();
  const modTime = await reader.readUint16LE();
  const modDate = await reader.readUint16LE();
  const crc32 = await reader.readUint32LE();
  const compressedSize = await reader.readUint32LE();
  const uncompressedSize = await reader.readUint32LE();
  const nameLength = await reader.readUint16LE();
  const extraLength = await reader.readUint16LE();

  const nameBytes = await reader.readBytes(nameLength);
  if (extraLength > 0) {
    await reader.readBytes(extraLength); // skip extra field for now
  }

  const name = decoder.decode(nameBytes);
  const lastModified = dosToDate(modTime, modDate);
  const hasDataDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;

  return {
    name,
    compressionMethod,
    lastModified,
    flags,
    crc32,
    compressedSize,
    uncompressedSize,
    hasDataDescriptor,
  };
}

async function parseDataDescriptor(
  reader: StreamingByteReader,
): Promise<{
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}> {
  // The data descriptor may or may not have the 4-byte signature.
  const maybeSig = await reader.peekUint32LE();

  if (maybeSig === SIG_DATA_DESCRIPTOR) {
    await reader.readUint32LE(); // consume signature
  }

  const crc32 = await reader.readUint32LE();
  const compressedSize = await reader.readUint32LE();
  const uncompressedSize = await reader.readUint32LE();

  return { crc32, compressedSize, uncompressedSize };
}

export function readZipEntries(
  source: Source<Uint8Array>,
): AsyncIterable<ZipEntry> {
  return (async function* () {
    const reader = new StreamingByteReader(source);

    try {
      while (await reader.hasMoreData()) {
        const sig = await reader.peekUint32LE();
        if (sig === null || sig !== SIG_LOCAL_FILE) {
          // No more local headers — we've hit the central directory or EOF
          break;
        }

        const header = await parseLocalHeader(reader);

        // Streamed archives (Java ZipOutputStream, most server-side zip
        // streamers) set flag bit 3 and defer sizes to a data descriptor
        // after the data. Without a size in the local header there is no
        // way to know where the data ends in a forward pass — proceeding
        // would misparse file bytes as the descriptor and report a bogus
        // CRC mismatch on a valid archive. Fail honestly instead.
        if (
          header.hasDataDescriptor &&
          header.compressedSize === 0 &&
          header.uncompressedSize === 0
        ) {
          throw new ZipCorruptionError(
            `Entry "${header.name}" defers its sizes to a data descriptor, ` +
              `which the forward-only reader cannot stream. ` +
              `Use openZip() for this archive.`,
          );
        }

        // --- State for lazy properties ---
        let consumed = false;
        let finalCrc = 0;
        let finalCompressedSize = 0;
        let finalUncompressedSize = 0;

        function lazyGet(label: string, getValue: () => number): number {
          if (!consumed) {
            console.warn(
              `@culvert/zip: '${label}' accessed before entry source was consumed. ` +
                `This value is not available until the source is fully drained. ` +
                `Returning 0.`,
            );
            return 0;
          }
          return getValue();
        }

        // --- Build the entry source ---
        //
        // The file's compressed data follows the local header.
        // If compressedSize is known (>0 in header), we read exactly
        // that many bytes. If it's 0 with a data descriptor flag,
        // we know the size will come after the data — but we need to
        // know how many bytes to read. This is a fundamental limitation
        // of streaming ZIP reading with data descriptors.
        //
        // For v1: we require compressedSize > 0 in the local header
        // when reading. Most ZIP writers (including ours) set it even
        // when using data descriptors for the CRC.

        const compressedSize = header.compressedSize;

        // Track whether this entry's data has been consumed, and how
        // many compressed bytes were actually pulled from the stream —
        // if the consumer abandons the entry mid-read, the difference
        // must be skipped byte-for-byte before the next header.
        let dataConsumed = false;
        let descriptorConsumed = false;
        let compressedBytesPulled = 0;

        const entrySource: Source<Uint8Array> = (async function* () {
          // Get the raw compressed bytes as a source
          const compressedSource = reader.readBytesAsSource(compressedSize);

          // Decompress. Anything but store (0) and deflate (8) would
          // either yield raw compressed bytes as if stored or feed
          // garbage to the inflater — refuse it by name instead.
          let decompress;
          if (header.compressionMethod === 0) {
            decompress = identityTransform();
          } else if (header.compressionMethod === 8) {
            decompress = inflateRaw();
          } else {
            throw new ZipCorruptionError(
              `Unsupported compression method ${header.compressionMethod} ` +
                `for "${header.name}": only store (0) and deflate (8) are supported`,
            );
          }

          // Track CRC and sizes through the pipeline
          const crc = new CRC32();
          let rawSize = 0;

          // Wrap compressed source with a consumption tracker, then decompress
          const trackedCompressed: Source<Uint8Array> = (async function* () {
            for await (const chunk of compressedSource) {
              compressedBytesPulled += chunk.length;
              yield chunk;
            }
          })();

          const decompressed = decompress(trackedCompressed);

          for await (const chunk of decompressed) {
            crc.update(chunk);
            rawSize += chunk.length;
            yield chunk;
          }

          // --- Read data descriptor if present ---
          if (header.hasDataDescriptor) {
            const desc = await parseDataDescriptor(reader);
            descriptorConsumed = true;
            finalCrc = desc.crc32;
            finalCompressedSize = desc.compressedSize;
            finalUncompressedSize = desc.uncompressedSize;
          } else {
            finalCrc = header.crc32;
            finalCompressedSize = header.compressedSize;
            finalUncompressedSize = header.uncompressedSize;
          }

          // --- Verify CRC ---
          const computedCrc = crc.digest();
          if (finalCrc !== 0 && computedCrc !== finalCrc) {
            throw new ZipCorruptionError(
              `CRC-32 mismatch for "${header.name}": ` +
                `expected 0x${finalCrc.toString(16).padStart(8, "0")}, ` +
                `got 0x${computedCrc.toString(16).padStart(8, "0")}`,
            );
          }

          consumed = true;
          dataConsumed = true;
        })();

        const entry: ZipEntry = {
          name: header.name,
          compressionMethod: header.compressionMethod,
          lastModified: header.lastModified,
          source: entrySource,

          get compressedSize() {
            return lazyGet("compressedSize", () => finalCompressedSize);
          },
          get uncompressedSize() {
            return lazyGet("uncompressedSize", () => finalUncompressedSize);
          },
          get crc32() {
            return lazyGet("crc32", () => finalCrc);
          },
        };

        yield entry;

        // If the consumer didn't drain this entry's source, do it now.
        // Skipping isn't free — it's consumption by another name.
        //
        // Crucially this drains at the BYTE level, not by re-iterating
        // entrySource: if the consumer broke out mid-entry, that
        // generator is already closed and re-iterating it is a silent
        // no-op — which used to leave unread file bytes to be parsed
        // as the next header, losing every remaining entry.
        if (!dataConsumed) {
          const remaining = compressedSize - compressedBytesPulled;
          if (remaining > 0) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _ of reader.readBytesAsSource(remaining)) {
              // drain
            }
          }
          if (header.hasDataDescriptor && !descriptorConsumed) {
            await parseDataDescriptor(reader);
          }
        }
      }
    } finally {
      await reader.close();
    }
  })();
}
