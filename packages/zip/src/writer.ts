import { CRC32 } from "@culvert/crc32";
import type { Sink, Source, Transform } from "@culvert/stream";
import { abortable, channel, pipe, tap } from "@culvert/stream";

import {
  buildCentralDirectoryEntry,
  buildEndOfCentralDirectory,
  buildLocalFileHeader,
  encodeFilename,
} from "./binary.js";
import { deflateRaw, identityTransform } from "./deflate.js";
import { ZipAbortError, ZipEntryError } from "./errors.js";
import type {
  AddFileOptions,
  CentralDirectoryEntry,
  ZipArchive,
} from "./types.js";

// ---------------------------------------------------------------------------
// createZip()
//
// Returns a Source<Uint8Array> — the raw ZIP archive bytes. The callback
// receives a ZipArchive handle; each addFile() call streams one entry
// through the channel. The central directory is written after the
// callback completes. The archive is finalized automatically.
//
// Internally, a channel() bridges the imperative push-based callback
// to the pull-based Source. Each writer.write() blocks until the
// consumer pulls, providing structural backpressure all the way from
// the output back to the file sources.
// ---------------------------------------------------------------------------

export function createZip(
  callback: (archive: ZipArchive) => Promise<void>,
  options?: { signal?: AbortSignal },
): Source<Uint8Array> {
  const [writer, source] = channel<Uint8Array>();
  const archiveSignal = options?.signal;

  // Background producer — runs the callback, writes ZIP bytes into the channel
  (async () => {
    try {
      // Check for pre-aborted signal
      if (archiveSignal?.aborted) {
        throw new ZipAbortError();
      }

      const centralDirectory: CentralDirectoryEntry[] = [];
      let offset = 0;

      /** Write bytes to the channel and track the archive offset. */
      const emit = async (bytes: Uint8Array): Promise<void> => {
        await writer.write(bytes);
        offset += bytes.length;
      };

      /** Sink that writes each chunk through the channel. */
      const emitSink: Sink<Uint8Array> = async (source) => {
        for await (const chunk of source) {
          await emit(chunk);
        }
      };

      const archive: ZipArchive = {
        async addFile(opts: AddFileOptions): Promise<void> {
          // --- Validate ---
          if (!opts.name) {
            throw new ZipEntryError("Entry name is required");
          }
          if (!opts.source) {
            throw new ZipEntryError("Entry source is required");
          }

          // --- Check abort ---
          if (archiveSignal?.aborted) throw new ZipAbortError();
          if (opts.signal?.aborted) throw new ZipAbortError();

          // --- Resolve compression ---
          let compress: Transform<Uint8Array, Uint8Array>;
          let compressionMethod: number;

          if ("compress" in opts && opts.compress) {
            compress = opts.compress;
            compressionMethod = opts.compressionMethod;
          } else {
            const mode =
              (opts as { compression?: "deflate" | "store" }).compression ??
              "deflate";
            if (mode === "store") {
              compress = identityTransform();
              compressionMethod = 0;
            } else {
              compress = deflateRaw();
              compressionMethod = 8;
            }
          }

          const name = encodeFilename(opts.name);
          const comment = encodeFilename(opts.comment ?? "");
          const lastModified = opts.lastModified ?? new Date();
          const localHeaderOffset = offset;

          // --- The pipeline: observe → compress → collect ---
          // We collect compressed output so we can write CRC and sizes
          // in the local header. This buffers O(compressed_file_size)
          // per file, but the archive itself still streams file-by-file
          // through the channel.
          const crc = new CRC32();
          let uncompressedSize = 0;
          const compressedChunks: Uint8Array[] = [];

          // Wire up abort signals
          let fileSource: Source<Uint8Array> = opts.source;
          if (archiveSignal) fileSource = abortable(fileSource, archiveSignal);
          if (opts.signal) fileSource = abortable(fileSource, opts.signal);

          await pipe(
            fileSource,
            tap((chunk) => {
              crc.update(chunk);
              uncompressedSize += chunk.length;
            }),
            compress,
            async (source) => {
              for await (const chunk of source) {
                compressedChunks.push(chunk);
              }
            },
          );

          const crcValue = crc.digest();
          let compressedSize = 0;
          for (const c of compressedChunks) compressedSize += c.length;

          // --- Now we know everything: write header, then data ---
          await emit(
            buildLocalFileHeader(
              name,
              compressionMethod,
              lastModified,
              crcValue,
              compressedSize,
              uncompressedSize,
            ),
          );

          for (const chunk of compressedChunks) {
            await emit(chunk);
          }

          // --- Record for central directory ---
          centralDirectory.push({
            name,
            comment,
            compressionMethod,
            crc32: crcValue,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            lastModified,
          });
        },
      };

      // --- Run the user's callback ---
      await callback(archive);

      // --- Write central directory ---
      const centralDirOffset = offset;
      for (const entry of centralDirectory) {
        await emit(buildCentralDirectoryEntry(entry));
      }
      const centralDirSize = offset - centralDirOffset;

      // --- Write end of central directory ---
      await emit(
        buildEndOfCentralDirectory(
          centralDirectory,
          centralDirOffset,
          centralDirSize,
        ),
      );

      // --- Done ---
      await writer.close();
    } catch (err) {
      writer.error(err);
    }
  })();

  return source;
}
