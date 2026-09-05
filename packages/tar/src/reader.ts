import { abortable, type Source } from "@culvert/stream";
import { byteReader, isAllZeros, type ByteReader } from "./byte-reader.js";
import {
  BLOCK_SIZE,
  MAX_PAX_HEADER_SIZE,
  PAX_KEY_GID,
  PAX_KEY_LINKPATH,
  PAX_KEY_MTIME,
  PAX_KEY_PATH,
  PAX_KEY_SIZE,
  PAX_KEY_UID,
  TYPEFLAG_CONTIGUOUS,
  TYPEFLAG_DIRECTORY,
  TYPEFLAG_FILE,
  TYPEFLAG_FILE_OLD,
  TYPEFLAG_HARDLINK,
  TYPEFLAG_PAX_EXTENDED,
  TYPEFLAG_PAX_GLOBAL,
  TYPEFLAG_SYMLINK,
} from "./constants.js";
import { TarAbortError, TarCorruptionError } from "./errors.js";
import { applyPathPolicy } from "./path-policy.js";
import { PaxState, parsePaxRecords } from "./pax.js";
import type {
  ReadTarOptions,
  TarDirectoryEntry,
  TarEntry,
  TarFileEntry,
  TarHardLinkEntry,
  TarSymlinkEntry,
  TarUnknownEntry,
} from "./types.js";
import { joinPath, parseUstarHeader } from "./ustar.js";

// ---------------------------------------------------------------------------
// Pad an entry's data section to BLOCK_SIZE alignment.
// ---------------------------------------------------------------------------

function padBytes(dataLength: number): number {
  const remainder = dataLength % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

// ---------------------------------------------------------------------------
// Decide what to do with a parsed header.
// ---------------------------------------------------------------------------

interface MergedFields {
  name: string;
  size: number;
  mtime: Date;
  mode: number;
  uid: number;
  gid: number;
  typeflag: string;
  linkname: string;
}

function mergeFields(
  parsed: ReturnType<typeof parseUstarHeader>,
  pax: PaxState,
): MergedFields {
  // Path: PAX 'path' overrides ustar name+prefix.
  const paxPath = pax.get(PAX_KEY_PATH);
  const name =
    paxPath !== undefined ? paxPath : joinPath(parsed.name, parsed.prefix);

  // Linkname: PAX 'linkpath' overrides ustar linkname.
  const paxLinkpath = pax.get(PAX_KEY_LINKPATH);
  const linkname = paxLinkpath !== undefined ? paxLinkpath : parsed.linkname;

  // Size: PAX 'size' overrides ustar size (decimal vs octal).
  const paxSize = pax.get(PAX_KEY_SIZE);
  const size = paxSize !== undefined ? Number(paxSize) : parsed.size;
  // isInteger, not just isFinite: a fractional size (e.g. PAX "size=1.5")
  // makes the byte accounting never reach zero — the entry source then
  // yields empty chunks in an unbounded loop. The writer already rejects
  // fractional sizes; the reader faces hostile input and must too.
  if (!Number.isInteger(size) || size < 0) {
    throw new TarCorruptionError(
      `Invalid size value: ${paxSize ?? parsed.size}`,
    );
  }

  // mtime: PAX 'mtime' (decimal seconds with optional fraction) overrides
  // ustar mtimeSeconds (integer seconds).
  const paxMtime = pax.get(PAX_KEY_MTIME);
  const mtimeSecondsFloat =
    paxMtime !== undefined ? Number(paxMtime) : parsed.mtimeSeconds;
  if (!Number.isFinite(mtimeSecondsFloat)) {
    throw new TarCorruptionError(`Invalid mtime value: ${paxMtime}`);
  }
  const mtime = new Date(mtimeSecondsFloat * 1000);

  // uid/gid: PAX overrides if present.
  const paxUid = pax.get(PAX_KEY_UID);
  const uid = paxUid !== undefined ? Number(paxUid) : parsed.uid;
  if (!Number.isInteger(uid) || uid < 0) {
    throw new TarCorruptionError(`Invalid uid value: ${paxUid ?? parsed.uid}`);
  }
  const paxGid = pax.get(PAX_KEY_GID);
  const gid = paxGid !== undefined ? Number(paxGid) : parsed.gid;
  if (!Number.isInteger(gid) || gid < 0) {
    throw new TarCorruptionError(`Invalid gid value: ${paxGid ?? parsed.gid}`);
  }

  return {
    name,
    size,
    mtime,
    mode: parsed.mode,
    uid,
    gid,
    typeflag: parsed.typeflag,
    linkname,
  };
}

// ---------------------------------------------------------------------------
// readTarEntries — main reader entry point
// ---------------------------------------------------------------------------

export function readTarEntries(
  source: Source<Uint8Array>,
  options: ReadTarOptions = {},
): AsyncIterable<TarEntry> {
  const checksumPolicy = options.checksumPolicy ?? "strict";
  const pathPolicy = options.pathPolicy;

  return {
    [Symbol.asyncIterator]() {
      const tracked = options.signal
        ? abortable(source, options.signal)
        : source;
      const reader = byteReader(tracked);
      const pax = new PaxState();

      // Tracks an in-flight file entry's data source. Until the consumer
      // either drains it or moves on (triggering auto-skip), we can't
      // read the next header.
      let currentEntryRemaining: number | null = null;

      const drainCurrent = async (): Promise<void> => {
        if (currentEntryRemaining === null) return;
        if (currentEntryRemaining > 0) {
          await reader.skip(currentEntryRemaining);
        }
        currentEntryRemaining = null;
      };

      return {
        async next(): Promise<IteratorResult<TarEntry>> {
          try {
            // Auto-skip prior entry's unconsumed bytes + padding.
            await drainCurrent();

            // Loop because PAX 'x' and 'g' headers don't surface — we
            // process them and try the next block.
            // eslint-disable-next-line no-constant-condition
            while (true) {
              if (options.signal?.aborted) {
                throw new TarAbortError();
              }

              const block = await reader.readExact(BLOCK_SIZE);

              // Check for end-of-archive marker.
              if (isAllZeros(block)) {
                const next = await reader.peek(BLOCK_SIZE);
                if (next.length === BLOCK_SIZE && isAllZeros(next)) {
                  // Two consecutive zero blocks: clean end. Consume the
                  // second zero block and finish.
                  await reader.skip(BLOCK_SIZE);
                  await reader.finish();
                  return { value: undefined, done: true };
                }
                throw new TarCorruptionError(
                  "Single zero block found; archive may be truncated",
                );
              }

              const parsed = parseUstarHeader(block);

              // Checksum verification.
              if (checksumPolicy === "strict") {
                if (parsed.storedChecksum !== parsed.computedChecksum) {
                  throw new TarCorruptionError(
                    `Header checksum mismatch: stored=${parsed.storedChecksum}, ` +
                      `computed=${parsed.computedChecksum}`,
                  );
                }

                // Magic verification — catches crafted blocks that pass
                // checksum but aren't actually tar headers. The 6-byte
                // magic field holds "ustar\0" (POSIX) or "ustar " (GNU —
                // its second space and NUL live in the version field), so
                // the GNU value parses with exactly ONE trailing space.
                if (parsed.magic !== "ustar" && parsed.magic !== "ustar ") {
                  throw new TarCorruptionError(
                    `Invalid ustar magic: ${JSON.stringify(parsed.magic)} ` +
                      `(expected POSIX "ustar" or GNU "ustar ")`,
                  );
                }
              }

              // PAX-typeflag entries are consumed internally. Their data
              // is buffered whole for record parsing, and the declared
              // size is attacker-controlled (up to 8 GiB in octal) — cap
              // it. Real PAX headers are a few hundred bytes.
              if (
                parsed.typeflag === TYPEFLAG_PAX_EXTENDED ||
                parsed.typeflag === TYPEFLAG_PAX_GLOBAL
              ) {
                if (parsed.size > MAX_PAX_HEADER_SIZE) {
                  throw new TarCorruptionError(
                    `PAX extended header too large: ${parsed.size} bytes ` +
                      `(limit ${MAX_PAX_HEADER_SIZE})`,
                  );
                }
                const data = await reader.readExact(parsed.size);
                await reader.skip(padBytes(parsed.size));
                if (parsed.typeflag === TYPEFLAG_PAX_EXTENDED) {
                  pax.applyPending(parsePaxRecords(data));
                } else {
                  pax.applyGlobal(parsePaxRecords(data));
                }
                continue;
              }

              const merged = mergeFields(parsed, pax);
              // PAX 'x' records apply to the next regular entry only.
              // If that entry is rejected or skipped by the path policy,
              // the pending records are spent — they do not carry forward.
              pax.consumePending();

              // Apply path policy on the merged name.
              const policyResult = applyPathPolicy(merged.name, pathPolicy);
              if (policyResult instanceof Error) {
                if (pathPolicy === undefined || pathPolicy === "strict") {
                  // Strict mode halts.
                  throw new TarCorruptionError(
                    `Hostile path rejected: ${policyResult.message}`,
                  );
                }
                // Function form: skip this entry — including its data
                // section for ANY data-bearing typeflag (GNU 'L'/'K',
                // vendor flags), mirroring the unknown-entry emit path.
                // Leaving the data unread would desync the stream: the
                // entry's bytes would be parsed as the next header.
                if (merged.size > 0) {
                  await reader.skip(merged.size + padBytes(merged.size));
                }
                continue;
              }
              const finalName = policyResult;

              // Emit the entry.
              const flag = merged.typeflag;

              if (
                flag === TYPEFLAG_FILE ||
                flag === TYPEFLAG_FILE_OLD ||
                flag === TYPEFLAG_CONTIGUOUS
              ) {
                // File: build a Source<Uint8Array> for its data.
                const fileSource = makeFileSource(
                  reader,
                  merged.size,
                  options.signal,
                  () => {
                    // Called when the file source completes (drained or
                    // returned). Pad bytes still need to be skipped before
                    // the next header read.
                    currentEntryRemaining = 0;
                  },
                  (remaining) => {
                    // Called from drainCurrent if the consumer didn't
                    // finish reading.
                    currentEntryRemaining = remaining;
                  },
                );
                currentEntryRemaining = merged.size + padBytes(merged.size);
                const entry: TarFileEntry = {
                  kind: "file",
                  name: finalName,
                  size: merged.size,
                  lastModified: merged.mtime,
                  mode: merged.mode,
                  uid: merged.uid,
                  gid: merged.gid,
                  source: fileSource,
                };
                return { value: entry, done: false };
              }

              if (flag === TYPEFLAG_DIRECTORY) {
                const entry: TarDirectoryEntry = {
                  kind: "directory",
                  name: finalName,
                  lastModified: merged.mtime,
                  mode: merged.mode,
                  uid: merged.uid,
                  gid: merged.gid,
                };
                return { value: entry, done: false };
              }

              if (flag === TYPEFLAG_SYMLINK) {
                const entry: TarSymlinkEntry = {
                  kind: "symlink",
                  name: finalName,
                  target: merged.linkname,
                  lastModified: merged.mtime,
                };
                return { value: entry, done: false };
              }

              if (flag === TYPEFLAG_HARDLINK) {
                const entry: TarHardLinkEntry = {
                  kind: "hardlink",
                  name: finalName,
                  target: merged.linkname,
                  lastModified: merged.mtime,
                };
                return { value: entry, done: false };
              }

              // Unknown typeflag: surface as TarUnknownEntry, skip its
              // data section if any.
              if (merged.size > 0) {
                currentEntryRemaining = merged.size + padBytes(merged.size);
              }
              const entry: TarUnknownEntry = {
                kind: "unknown",
                typeflag: flag,
                name: finalName,
                size: merged.size,
              };
              return { value: entry, done: false };
            }
          } catch (err) {
            await reader.finish();
            // If the signal fired mid-block, abortable() ends the
            // underlying stream early and the byte reader reports it as
            // truncation. The consumer asked to stop — say so.
            if (options.signal?.aborted && !(err instanceof TarAbortError)) {
              throw new TarAbortError();
            }
            throw err;
          }
        },

        async return(): Promise<IteratorResult<TarEntry>> {
          await reader.finish();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Make a Source<Uint8Array> that streams a file entry's data from the
// underlying ByteReader. The source pulls bytes lazily; consumer can
// drain or abandon it.
//
// We use channel() to bridge the reader's pull-based API to an async
// iterator that the consumer can pipe into. The producer task owns
// the size accounting.
// ---------------------------------------------------------------------------

function makeFileSource(
  reader: ByteReader,
  size: number,
  signal: AbortSignal | undefined,
  onComplete: () => void,
  onAbandon: (remaining: number) => void,
): Source<Uint8Array> {
  // Simple implementation: an async generator. The reader gives us raw
  // bytes; we slice into reasonable-sized chunks and account for
  // padding completion.
  const CHUNK_TARGET = 64 * 1024;

  return {
    [Symbol.asyncIterator]() {
      let remaining = size;
      let completed = false;
      let abandoned = false;

      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (completed || abandoned) {
            return { value: undefined, done: true };
          }
          if (signal?.aborted) {
            throw new TarAbortError();
          }
          try {
            if (remaining === 0) {
              // Skip padding; signal complete to the outer iterator.
              const pad = padBytes(size);
              if (pad > 0) {
                await reader.skip(pad);
              }
              completed = true;
              onComplete();
              return { value: undefined, done: true };
            }
            const want = Math.min(remaining, CHUNK_TARGET);
            const chunk = await reader.readExact(want);
            remaining -= chunk.length;
            return { value: chunk, done: false };
          } catch (err) {
            // Same conversion as the entry iterator: truncation caused by
            // the abort signal surfaces as TarAbortError, not corruption.
            if (signal?.aborted && !(err instanceof TarAbortError)) {
              throw new TarAbortError();
            }
            throw err;
          }
        },

        async return(): Promise<IteratorResult<Uint8Array>> {
          if (!completed && !abandoned) {
            abandoned = true;
            // Tell the outer iterator how many bytes (data + padding) it
            // still needs to skip before the next header.
            onAbandon(remaining + padBytes(size));
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}
