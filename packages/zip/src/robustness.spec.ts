import { describe, it, expect } from "vitest";
import { collectBytes, from, pipe } from "@culvert/stream";
import type { Source } from "@culvert/stream";
import {
  createZip,
  readZipEntries,
  openZip,
  fromBuffer,
  ZipCorruptionError,
} from "./index.js";
import { findEOCD } from "./binary-reader.js";
import { EOCD_SEARCH_SIZE } from "./constants.js";

// ---------------------------------------------------------------------------
// Regression suite from the 2026-09-05 deep review: early-termination
// hangs, silent entry loss, misleading errors on valid-but-unsupported
// archives, and unsupported compression methods passed through as store.
// ---------------------------------------------------------------------------

const encode = (s: string) => new TextEncoder().encode(s);

async function buildZip(
  entries: Array<{ name: string; data: Uint8Array; compression: "store" | "deflate" }>,
): Promise<Uint8Array> {
  const zip = createZip(async (archive) => {
    for (const e of entries) {
      await archive.addFile({
        name: e.name,
        source: from([e.data]),
        compression: e.compression,
        lastModified: new Date(2024, 0, 1),
      });
    }
  });
  return pipe(zip, collectBytes());
}

/** Feed bytes as many small chunks so entry data spans chunk boundaries. */
function chunked(bytes: Uint8Array, size: number): Source<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < bytes.length; i += size) {
      yield bytes.slice(i, i + size);
    }
  })();
}

/** Find a signature's byte offset in a buffer. */
function findSig(bytes: Uint8Array, sig: number[], fromIndex = 0): number {
  outer: for (let i = fromIndex; i <= bytes.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) {
      if (bytes[i + j] !== sig[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe("early-termination teardown", () => {
  it(
    "breaking out of a deflated entry source terminates (openZip)",
    { timeout: 5000 },
    async () => {
      const big = new Uint8Array(4 * 1024 * 1024); // highly compressible
      const bytes = await buildZip([
        { name: "big.bin", data: big, compression: "deflate" },
      ]);

      const archive = await openZip(fromBuffer(bytes));
      const entry = archive.entries[0]!;

      let chunks = 0;
      // Before the fix, the `break` awaited the transform's blocked pump
      // forever and this loop never exited.
      for await (const _chunk of archive.source(entry)) {
        chunks++;
        break;
      }
      expect(chunks).toBe(1);
    },
  );

  it(
    "corrupt deflate data surfaces as ZipCorruptionError, not a platform error",
    { timeout: 5000 },
    async () => {
      const data = encode("hello world, this compresses fine".repeat(50));
      const bytes = await buildZip([
        { name: "a.bin", data, compression: "deflate" },
      ]);

      // Compressed data starts after the 30-byte local header + name.
      const dataStart = 30 + "a.bin".length;
      bytes[dataStart] = 0x07; // BFINAL=1, BTYPE=11 (reserved) — hard inflate error

      const archive = await openZip(fromBuffer(bytes));
      const entry = archive.entries[0]!;
      await expect(
        pipe(archive.source(entry), collectBytes()),
      ).rejects.toThrow(ZipCorruptionError);
    },
  );
});

describe("forward reader robustness", () => {
  it(
    "partially consuming an entry does not lose the entries after it",
    { timeout: 5000 },
    async () => {
      const bytes = await buildZip([
        { name: "one.txt", data: encode("x".repeat(100)), compression: "store" },
        { name: "two.txt", data: encode("y".repeat(100)), compression: "store" },
        { name: "three.txt", data: encode("z".repeat(100)), compression: "store" },
      ]);

      const names: string[] = [];
      // Small chunks force each entry's data to span many pulls, so
      // breaking after the first chunk leaves bytes unconsumed.
      for await (const entry of readZipEntries(chunked(bytes, 16))) {
        names.push(entry.name);
        for await (const _chunk of entry.source) {
          break; // abandon the rest of this entry
        }
      }
      expect(names).toEqual(["one.txt", "two.txt", "three.txt"]);
    },
  );

  it("streamed ZIPs with sizes deferred to data descriptors get a clear error", async () => {
    // Hand-crafted: local header with flag bit 3 set and zero sizes —
    // what Java's ZipOutputStream and most streaming writers emit.
    const name = encode("a.txt");
    const data = encode("hello");
    const header = new Uint8Array(30 + name.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0x0008, true); // flags: data descriptor
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(26, name.length, true);
    header.set(name, 30);

    const descriptor = new Uint8Array(16);
    const ddv = new DataView(descriptor.buffer);
    ddv.setUint32(0, 0x08074b50, true); // descriptor signature
    ddv.setUint32(4, 0x3610a686, true); // crc32("hello")
    ddv.setUint32(8, data.length, true);
    ddv.setUint32(12, data.length, true);

    const zip = new Uint8Array([...header, ...data, ...descriptor]);

    await expect(async () => {
      for await (const entry of readZipEntries(from([zip]))) {
        await pipe(entry.source, collectBytes());
      }
    }).rejects.toThrow(/data descriptor.*openZip/s);
  });
});

describe("unsupported compression methods", () => {
  async function patchedMethodArchive(): Promise<Uint8Array> {
    const bytes = await buildZip([
      { name: "weird.bin", data: encode("some stored data"), compression: "store" },
    ]);
    // Patch method to 12 (bzip2) in the local header (+8) and the
    // central directory entry (+10).
    const lfh = findSig(bytes, [0x50, 0x4b, 0x03, 0x04]);
    const cd = findSig(bytes, [0x50, 0x4b, 0x01, 0x02]);
    expect(lfh).toBeGreaterThanOrEqual(0);
    expect(cd).toBeGreaterThanOrEqual(0);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(lfh + 8, 12, true);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(cd + 10, 12, true);
    return bytes;
  }

  it("openZip refuses instead of yielding raw bytes as if stored", async () => {
    const bytes = await patchedMethodArchive();
    const archive = await openZip(fromBuffer(bytes));
    const entry = archive.entries[0]!;
    await expect(
      pipe(archive.source(entry), collectBytes()),
    ).rejects.toThrow(/compression method/i);
  });

  it("readZipEntries refuses instead of blindly inflating", async () => {
    const bytes = await patchedMethodArchive();
    await expect(async () => {
      for await (const entry of readZipEntries(from([bytes]))) {
        await pipe(entry.source, collectBytes());
      }
    }).rejects.toThrow(/compression method/i);
  });
});

describe("EOCD search window", () => {
  it("finds the ZIP64 locator behind a maximum-length archive comment", () => {
    // A ZIP64 EOCD locator (20 bytes) + EOCD with ZIP64 sentinels +
    // a comment long enough that the locator sits at the very edge of
    // the search window. The old window (EOCD fixed + max comment + 1)
    // had no room for the locator, so valid archives were "truncated".
    const commentLength = 0xffff;
    const tailFull = new Uint8Array(20 + 22 + commentLength);
    const dv = new DataView(tailFull.buffer);

    // ZIP64 EOCD locator
    dv.setUint32(0, 0x07064b50, true); // signature
    dv.setUint32(4, 0, true); // disk with ZIP64 EOCD
    dv.setBigUint64(8, 0x1234n, true); // ZIP64 EOCD offset
    dv.setUint32(16, 1, true); // total disks

    // Standard EOCD with ZIP64 sentinels
    dv.setUint32(20, 0x06054b50, true); // signature
    dv.setUint16(28, 0xffff, true); // entries on disk (sentinel)
    dv.setUint16(30, 0xffff, true); // total entries (sentinel)
    dv.setUint32(32, 0xffffffff, true); // CD size (sentinel)
    dv.setUint32(36, 0xffffffff, true); // CD offset (sentinel)
    dv.setUint16(40, commentLength, true);

    // The reader hands findEOCD the last EOCD_SEARCH_SIZE bytes.
    const tail = tailFull.slice(Math.max(0, tailFull.length - EOCD_SEARCH_SIZE));
    const record = findEOCD(tail);
    expect(record.zip64EocdOffset).toBe(0x1234);
  });
});
