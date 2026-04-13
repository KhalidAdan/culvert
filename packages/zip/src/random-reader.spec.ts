import { describe, expect, it } from "vitest";

import { CRC32 } from "@culvert/crc32";
import type { Source } from "@culvert/stream";

import {
  findEOCD,
  parseCentralDirectory,
  parseLocalHeaderDataOffset,
} from "../src/binary-reader.js";
import {
  CENTRAL_DIR_FIXED_SIZE,
  COMPRESSION_DEFLATE,
  COMPRESSION_STORE,
  EOCD_FIXED_SIZE,
  LOCAL_HEADER_FIXED_SIZE,
  SIG_CENTRAL_DIR,
  SIG_END_OF_CENTRAL_DIR,
  SIG_LOCAL_FILE,
} from "../src/constants.js";
import { ZipCorruptionError } from "../src/errors.js";
import { fromBuffer, openZip } from "../src/random-reader.js";
import { createZip } from "../src/writer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Collect a Source<Uint8Array> into a single Uint8Array. */
async function collectBytes(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Create a Source<Uint8Array> from a string. */
function stringSource(s: string): Source<Uint8Array> {
  const bytes = encoder.encode(s);
  return (async function* () {
    yield bytes;
  })();
}

/** Write a uint32 LE into a buffer. */
function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

/** Write a uint16 LE into a buffer. */
function writeUint16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
}

/**
 * Build a minimal valid ZIP archive by hand (stored, no compression).
 * Useful for unit-testing parsing functions without depending on the writer.
 */
function buildMinimalZip(
  files: Array<{ name: string; data: Uint8Array }>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  const cdEntries: Array<{
    name: Uint8Array;
    crc32: number;
    size: number;
    offset: number;
  }> = [];
  let offset = 0;

  // --- Local file headers + data ---
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = new CRC32();
    crc.update(file.data);
    const crcValue = crc.digest();

    // Local file header
    const lfh = new Uint8Array(LOCAL_HEADER_FIXED_SIZE + nameBytes.length);
    writeUint32LE(lfh, 0, SIG_LOCAL_FILE);
    writeUint16LE(lfh, 4, 20); // version needed
    writeUint16LE(lfh, 6, 0x0800); // flags: UTF-8
    writeUint16LE(lfh, 8, COMPRESSION_STORE); // store
    writeUint16LE(lfh, 10, 0); // mod time
    writeUint16LE(lfh, 12, 0); // mod date
    writeUint32LE(lfh, 14, crcValue); // CRC-32
    writeUint32LE(lfh, 18, file.data.length); // compressed size
    writeUint32LE(lfh, 22, file.data.length); // uncompressed size
    writeUint16LE(lfh, 26, nameBytes.length); // filename length
    writeUint16LE(lfh, 28, 0); // extra field length
    lfh.set(nameBytes, 30);

    cdEntries.push({
      name: nameBytes,
      crc32: crcValue,
      size: file.data.length,
      offset,
    });

    parts.push(lfh);
    parts.push(file.data);
    offset += lfh.length + file.data.length;
  }

  const cdOffset = offset;

  // --- Central directory entries ---
  for (const entry of cdEntries) {
    const cd = new Uint8Array(CENTRAL_DIR_FIXED_SIZE + entry.name.length);
    writeUint32LE(cd, 0, SIG_CENTRAL_DIR);
    writeUint16LE(cd, 4, 30); // version made by
    writeUint16LE(cd, 6, 20); // version needed
    writeUint16LE(cd, 8, 0x0800); // flags: UTF-8
    writeUint16LE(cd, 10, COMPRESSION_STORE);
    writeUint16LE(cd, 12, 0); // mod time
    writeUint16LE(cd, 14, 0); // mod date
    writeUint32LE(cd, 16, entry.crc32);
    writeUint32LE(cd, 20, entry.size); // compressed
    writeUint32LE(cd, 24, entry.size); // uncompressed
    writeUint16LE(cd, 28, entry.name.length); // name length
    writeUint16LE(cd, 30, 0); // extra length
    writeUint16LE(cd, 32, 0); // comment length
    writeUint16LE(cd, 34, 0); // disk start
    writeUint16LE(cd, 36, 0); // internal attrs
    writeUint32LE(cd, 38, 0); // external attrs
    writeUint32LE(cd, 42, entry.offset); // local header offset
    cd.set(entry.name, 46);

    parts.push(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdOffset;

  // --- EOCD ---
  const eocd = new Uint8Array(EOCD_FIXED_SIZE);
  writeUint32LE(eocd, 0, SIG_END_OF_CENTRAL_DIR);
  writeUint16LE(eocd, 4, 0); // disk number
  writeUint16LE(eocd, 6, 0); // disk with CD
  writeUint16LE(eocd, 8, cdEntries.length); // entries on disk
  writeUint16LE(eocd, 10, cdEntries.length); // total entries
  writeUint32LE(eocd, 12, cdSize); // CD size
  writeUint32LE(eocd, 16, cdOffset); // CD offset
  writeUint16LE(eocd, 20, 0); // comment length
  parts.push(eocd);

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

// ===========================================================================
// Unit tests: binary parsing
// ===========================================================================

describe("findEOCD", () => {
  it("finds EOCD in the last 22 bytes (no comment)", () => {
    const eocd = new Uint8Array(EOCD_FIXED_SIZE);
    writeUint32LE(eocd, 0, SIG_END_OF_CENTRAL_DIR);
    writeUint16LE(eocd, 10, 3); // 3 entries
    writeUint32LE(eocd, 12, 200); // CD size
    writeUint32LE(eocd, 16, 1000); // CD offset
    writeUint16LE(eocd, 20, 0); // no comment

    const result = findEOCD(eocd);
    expect(result.entryCount).toStrictEqual(3);
    expect(result.centralDirectorySize).toStrictEqual(200);
    expect(result.centralDirectoryOffset).toStrictEqual(1000);
  });

  it("finds EOCD preceded by garbage bytes", () => {
    const garbage = new Uint8Array(100);
    for (let i = 0; i < garbage.length; i++) garbage[i] = i & 0xff;

    const eocd = new Uint8Array(EOCD_FIXED_SIZE);
    writeUint32LE(eocd, 0, SIG_END_OF_CENTRAL_DIR);
    writeUint16LE(eocd, 10, 5);
    writeUint32LE(eocd, 12, 500);
    writeUint32LE(eocd, 16, 2000);
    writeUint16LE(eocd, 20, 0);

    const tail = new Uint8Array(garbage.length + eocd.length);
    tail.set(garbage);
    tail.set(eocd, garbage.length);

    const result = findEOCD(tail);
    expect(result.entryCount).toStrictEqual(5);
    expect(result.centralDirectoryOffset).toStrictEqual(2000);
  });

  it("finds EOCD with a trailing comment", () => {
    const comment = encoder.encode("Test ZIP comment");
    const eocd = new Uint8Array(EOCD_FIXED_SIZE + comment.length);
    writeUint32LE(eocd, 0, SIG_END_OF_CENTRAL_DIR);
    writeUint16LE(eocd, 10, 1);
    writeUint32LE(eocd, 12, 100);
    writeUint32LE(eocd, 16, 500);
    writeUint16LE(eocd, 20, comment.length);
    eocd.set(comment, EOCD_FIXED_SIZE);

    const result = findEOCD(eocd);
    expect(result.entryCount).toStrictEqual(1);
  });

  it("throws on empty buffer", () => {
    expect(() => findEOCD(new Uint8Array(0))).throws(ZipCorruptionError);
  });

  it("throws when no EOCD signature present", () => {
    const junk = new Uint8Array(100);
    expect(() => findEOCD(junk)).throws(ZipCorruptionError);
  });

  it("rejects false-positive signature with inconsistent comment length", () => {
    // Craft a buffer where the signature appears but comment length
    // would extend past the end of the buffer
    const buf = new Uint8Array(EOCD_FIXED_SIZE);
    writeUint32LE(buf, 0, SIG_END_OF_CENTRAL_DIR);
    writeUint16LE(buf, 20, 999); // comment length > remaining bytes

    expect(() => findEOCD(buf)).throws(ZipCorruptionError);
  });
});

describe("parseCentralDirectory", () => {
  it("parses a single entry", () => {
    const name = encoder.encode("hello.txt");
    const cd = new Uint8Array(CENTRAL_DIR_FIXED_SIZE + name.length);

    writeUint32LE(cd, 0, SIG_CENTRAL_DIR);
    writeUint16LE(cd, 10, COMPRESSION_STORE);
    writeUint32LE(cd, 16, 0xcbf43926); // CRC
    writeUint32LE(cd, 20, 100); // compressed
    writeUint32LE(cd, 24, 100); // uncompressed
    writeUint16LE(cd, 28, name.length);
    writeUint16LE(cd, 30, 0); // extra
    writeUint16LE(cd, 32, 0); // comment
    writeUint32LE(cd, 42, 0); // local header offset
    cd.set(name, CENTRAL_DIR_FIXED_SIZE);

    const entries = parseCentralDirectory(cd);
    expect(entries.length).toStrictEqual(1);
    expect(entries[0]!.name).toStrictEqual("hello.txt");
    expect(entries[0]!.crc32).toStrictEqual(0xcbf43926);
    expect(entries[0]!.compressedSize).toStrictEqual(100);
    expect(entries[0]!.uncompressedSize).toStrictEqual(100);
    expect(entries[0]!.compressionMethod).toStrictEqual(COMPRESSION_STORE);
  });

  it("parses multiple entries", () => {
    const files = ["a.txt", "b.txt", "c.txt"];
    const parts: Uint8Array[] = [];

    for (const file of files) {
      const name = encoder.encode(file);
      const cd = new Uint8Array(CENTRAL_DIR_FIXED_SIZE + name.length);
      writeUint32LE(cd, 0, SIG_CENTRAL_DIR);
      writeUint16LE(cd, 28, name.length);
      writeUint16LE(cd, 30, 0);
      writeUint16LE(cd, 32, 0);
      cd.set(name, CENTRAL_DIR_FIXED_SIZE);
      parts.push(cd);
    }

    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      buf.set(p, offset);
      offset += p.length;
    }

    const entries = parseCentralDirectory(buf);
    expect(entries.length).toStrictEqual(3);
    expect(entries[0]!.name).toStrictEqual("a.txt");
    expect(entries[1]!.name).toStrictEqual("b.txt");
    expect(entries[2]!.name).toStrictEqual("c.txt");
  });

  it("throws on invalid signature", () => {
    const buf = new Uint8Array(CENTRAL_DIR_FIXED_SIZE);
    writeUint32LE(buf, 0, 0xdeadbeef);
    expect(() => parseCentralDirectory(buf)).throws(ZipCorruptionError);
  });

  it("parses empty central directory", () => {
    const entries = parseCentralDirectory(new Uint8Array(0));
    expect(entries.length).toStrictEqual(0);
  });
});

describe("parseLocalHeaderDataOffset", () => {
  it("calculates offset with no extra field", () => {
    const header = new Uint8Array(LOCAL_HEADER_FIXED_SIZE);
    writeUint16LE(header, 26, 9); // name = "hello.txt" (9 bytes)
    writeUint16LE(header, 28, 0); // no extra

    const dataOffset = parseLocalHeaderDataOffset(header, 1000);
    // 1000 + 30 + 9 + 0 = 1039
    expect(dataOffset).toStrictEqual(1039);
  });

  it("accounts for extra field length", () => {
    const header = new Uint8Array(LOCAL_HEADER_FIXED_SIZE);
    writeUint16LE(header, 26, 5); // 5-byte name
    writeUint16LE(header, 28, 20); // 20-byte extra field

    const dataOffset = parseLocalHeaderDataOffset(header, 500);
    // 500 + 30 + 5 + 20 = 555
    expect(dataOffset).toStrictEqual(555);
  });
});

// ===========================================================================
// Integration tests: round-trip via writer → random reader
// ===========================================================================

describe("openZip", () => {
  it("opens a hand-crafted ZIP and lists entries", async () => {
    const zipBytes = buildMinimalZip([
      { name: "hello.txt", data: encoder.encode("Hello!") },
      { name: "world.txt", data: encoder.encode("World!") },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entries.length).toStrictEqual(2);
    expect(archive.entries[0]!.name).toStrictEqual("hello.txt");
    expect(archive.entries[1]!.name).toStrictEqual("world.txt");

    await archive.close();
  });

  it("reads stored file data correctly", async () => {
    const content = "The quick brown fox jumps over the lazy dog";
    const zipBytes = buildMinimalZip([
      { name: "fox.txt", data: encoder.encode(content) },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));
    const entry = archive.entry("fox.txt");
    expect(entry).toBeDefined();

    const data = await collectBytes(archive.source(entry));
    expect(decoder.decode(data)).toStrictEqual(content);

    await archive.close();
  });

  it("looks up entries by name (O(1))", async () => {
    const zipBytes = buildMinimalZip([
      { name: "a.txt", data: encoder.encode("A") },
      { name: "b.txt", data: encoder.encode("B") },
      { name: "c.txt", data: encoder.encode("C") },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entry("b.txt")?.name).toStrictEqual("b.txt");
    expect(archive.entry("a.txt")?.name).toStrictEqual("a.txt");
    expect(archive.entry("c.txt")?.name).toStrictEqual("c.txt");
    expect(archive.entry("nope.txt")).toStrictEqual(undefined);

    await archive.close();
  });

  it("verifies CRC-32 on read", async () => {
    const zipBytes = buildMinimalZip([
      { name: "test.txt", data: encoder.encode("test data") },
    ]);

    // Corrupt the file data (byte right after the local header + name)
    const nameLen = "test.txt".length;
    const dataStart = LOCAL_HEADER_FIXED_SIZE + nameLen;
    zipBytes[dataStart] = zipBytes[dataStart]! ^ 0xff; // flip bits

    const archive = await openZip(fromBuffer(zipBytes));
    const entry = archive.entry("test.txt");
    expect(entry).toBeDefined();

    await expect(
      async () => await collectBytes(archive.source(entry)),
    ).rejects.toThrow(ZipCorruptionError);
    await archive.close();
  });

  it("reads the same entry multiple times (fresh source each call)", async () => {
    const content = "reusable content";
    const zipBytes = buildMinimalZip([
      { name: "reuse.txt", data: encoder.encode(content) },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));
    const entry = archive.entry("reuse.txt")!;

    const first = decoder.decode(await collectBytes(archive.source(entry)));
    const second = decoder.decode(await collectBytes(archive.source(entry)));

    expect(first).toStrictEqual(content);
    expect(second).toStrictEqual(content);

    await archive.close();
  });

  it("handles an archive with no files", async () => {
    const zipBytes = buildMinimalZip([]);
    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entries.length).toStrictEqual(0);
    expect(archive.entry("anything")).toStrictEqual(undefined);

    await archive.close();
  });

  it("preserves entry metadata", async () => {
    const data = encoder.encode("metadata test");
    const crc = new CRC32();
    crc.update(data);
    const expectedCrc = crc.digest();

    const zipBytes = buildMinimalZip([{ name: "meta.txt", data }]);

    const archive = await openZip(fromBuffer(zipBytes));
    const entry = archive.entry("meta.txt")!;

    expect(entry.compressionMethod).toStrictEqual(COMPRESSION_STORE);
    expect(entry.crc32).toStrictEqual(expectedCrc);
    expect(entry.compressedSize).toStrictEqual(data.length);
    expect(entry.uncompressedSize).toStrictEqual(data.length);

    await archive.close();
  });

  it("handles files with longer names and content", async () => {
    const longName = "path/to/deeply/nested/directory/structure/file.txt";
    const longContent = "x".repeat(100_000);
    const zipBytes = buildMinimalZip([
      { name: longName, data: encoder.encode(longContent) },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));
    const entry = archive.entry(longName)!;
    expect(entry).toBeDefined();

    const data = await collectBytes(archive.source(entry));
    expect(data.length).toStrictEqual(100_000);
    expect(decoder.decode(data)).toStrictEqual(longContent);

    await archive.close();
  });

  it("throws on empty file", async () => {
    await expect(
      async () => await openZip(fromBuffer(new Uint8Array(0))),
    ).rejects.toThrow(ZipCorruptionError);
  });

  it("throws on non-ZIP data", async () => {
    const junk = new Uint8Array(1000);
    for (let i = 0; i < junk.length; i++) junk[i] = i & 0xff;

    await expect(async () => await openZip(fromBuffer(junk))).rejects.toThrow(
      ZipCorruptionError,
    );
  });
});

// ===========================================================================
// Round-trip: writer → random reader (requires full @culvert/stream)
//
// These tests verify that archives produced by createZip() can be
// opened and read by the random-access reader. They exercise the
// real compression pipeline (deflateRaw via CompressionStream).
// ===========================================================================

describe("round-trip: createZip → openZip", () => {
  it("reads a stored file written by createZip", async () => {
    const content = "Hello from the writer!";

    const zipSource = createZip(async (archive) => {
      await archive.addFile({
        name: "greeting.txt",
        source: stringSource(content),
        compression: "store",
      });
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entries.length).toStrictEqual(1);
    expect(archive.entries[0]!.name).toStrictEqual("greeting.txt");

    const data = await collectBytes(archive.source(archive.entries[0]!));
    expect(decoder.decode(data)).toStrictEqual(content);

    await archive.close();
  });

  it("reads a deflated file written by createZip", async () => {
    const content = "Deflate me! ".repeat(1000);

    const zipSource = createZip(async (archive) => {
      await archive.addFile({
        name: "compressed.txt",
        source: stringSource(content),
        compression: "deflate",
      });
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    const entry = archive.entry("compressed.txt")!;
    expect(entry).toBeDefined();
    expect(entry.compressionMethod).toStrictEqual(COMPRESSION_DEFLATE);

    // Compressed should be smaller than original
    expect(entry.compressedSize < entry.uncompressedSize).toStrictEqual(true);

    const data = await collectBytes(archive.source(entry));
    expect(decoder.decode(data)).toStrictEqual(content);

    await archive.close();
  });

  it("reads multiple files with mixed compression", async () => {
    const files = [
      {
        name: "stored.txt",
        content: "I am stored",
        compression: "store" as const,
      },
      {
        name: "deflated.txt",
        content: "I am deflated! ".repeat(500),
        compression: "deflate" as const,
      },
      {
        name: "also-stored.bin",
        content: "\x00\x01\x02\x03\x04",
        compression: "store" as const,
      },
    ];

    const zipSource = createZip(async (archive) => {
      for (const file of files) {
        await archive.addFile({
          name: file.name,
          source: stringSource(file.content),
          compression: file.compression,
        });
      }
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entries.length).toStrictEqual(3);

    for (const file of files) {
      const entry = archive.entry(file.name)!;
      expect(entry).toBeDefined();

      const data = await collectBytes(archive.source(entry));
      expect(decoder.decode(data)).toStrictEqual(file.content);
    }

    await archive.close();
  });

  it("reads entries out of order (random access)", async () => {
    const zipSource = createZip(async (archive) => {
      await archive.addFile({
        name: "first.txt",
        source: stringSource("I am first"),
        compression: "store",
      });
      await archive.addFile({
        name: "second.txt",
        source: stringSource("I am second"),
        compression: "store",
      });
      await archive.addFile({
        name: "third.txt",
        source: stringSource("I am third"),
        compression: "store",
      });
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    // Read in reverse order — this is the whole point of random access
    const third = await collectBytes(
      archive.source(archive.entry("third.txt")!),
    );
    expect(decoder.decode(third)).toStrictEqual("I am third");

    const first = await collectBytes(
      archive.source(archive.entry("first.txt")!),
    );
    expect(decoder.decode(first)).toStrictEqual("I am first");

    const second = await collectBytes(
      archive.source(archive.entry("second.txt")!),
    );
    expect(decoder.decode(second)).toStrictEqual("I am second");

    await archive.close();
  });

  it("handles a file with a comment", async () => {
    const zipSource = createZip(async (archive) => {
      await archive.addFile({
        name: "commented.txt",
        source: stringSource("Has a comment"),
        compression: "store",
        comment: "This is a file comment",
      });
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    const entry = archive.entry("commented.txt")!;
    expect(entry).toBeDefined();
    expect(entry.comment).toStrictEqual("This is a file comment");

    await archive.close();
  });

  it("handles an empty archive from createZip", async () => {
    const zipSource = createZip(async (_archive) => {
      // No files added
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    expect(archive.entries.length).toStrictEqual(0);

    await archive.close();
  });
});

// ===========================================================================
// Resource cleanup
// ===========================================================================

describe("close", () => {
  it("calls seekable.close() when present", async () => {
    let closed = false;
    const zipBytes = buildMinimalZip([
      { name: "test.txt", data: encoder.encode("test") },
    ]);

    const seekable = {
      ...fromBuffer(zipBytes),
      close: async () => {
        closed = true;
      },
    };

    const archive = await openZip(seekable);
    expect(closed).toStrictEqual(false);

    await archive.close();
    expect(closed).toStrictEqual(true);
  });

  it("does not throw when seekable has no close()", async () => {
    const zipBytes = buildMinimalZip([
      { name: "test.txt", data: encoder.encode("test") },
    ]);

    const archive = await openZip(fromBuffer(zipBytes));
    // fromBuffer returns no close() — this should not throw
    await archive.close();
  });
});

// ===========================================================================
// CBZ simulation — the use case that motivated this reader
// ===========================================================================

describe("CBZ simulation", () => {
  it("opens a multi-page comic and reads pages out of order", async () => {
    // Simulate a small CBZ with numbered pages
    const pages: Array<{ name: string; content: string }> = [];
    for (let i = 1; i <= 20; i++) {
      const num = String(i).padStart(3, "0");
      pages.push({
        name: `page-${num}.jpg`,
        content: `[image data for page ${i}]`,
      });
    }

    const zipSource = createZip(async (archive) => {
      for (const page of pages) {
        await archive.addFile({
          name: page.name,
          source: stringSource(page.content),
          compression: "store",
        });
      }
    });

    const zipBytes = await collectBytes(zipSource);
    const archive = await openZip(fromBuffer(zipBytes));

    // Verify we have all 20 pages
    expect(archive.entries.length).toStrictEqual(20);

    // Jump to page 15 directly — no scanning
    const page15 = archive.entry("page-015.jpg")!;
    expect(page15).toBeDefined();
    const data15 = await collectBytes(archive.source(page15));
    expect(decoder.decode(data15)).toStrictEqual("[image data for page 15]");

    // Jump back to page 3
    const page3 = archive.entry("page-003.jpg")!;
    const data3 = await collectBytes(archive.source(page3));
    expect(decoder.decode(data3)).toStrictEqual("[image data for page 3]");

    // Jump forward to page 20
    const page20 = archive.entry("page-020.jpg")!;
    const data20 = await collectBytes(archive.source(page20));
    expect(decoder.decode(data20)).toStrictEqual("[image data for page 20]");

    // Read page 1
    const page1 = archive.entry("page-001.jpg")!;
    const data1 = await collectBytes(archive.source(page1));
    expect(decoder.decode(data1)).toStrictEqual("[image data for page 1]");

    await archive.close();
  });
});
