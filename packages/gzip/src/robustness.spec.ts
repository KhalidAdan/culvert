import { describe, it, expect } from "vitest";
import { collectBytes, from, pipe } from "@culvert/stream";
import type { Source } from "@culvert/stream";
import { CRC32 } from "@culvert/crc32";
import { gzip, gunzip, GzipCorruptionError } from "./index.js";
import { buildGzipHeader } from "./header.js";
import { createTestDeflator, createTestInflator } from "./test-codec.js";

// ---------------------------------------------------------------------------
// Regression suite from the 2026-09-05 deep review: invalid output for
// zero-chunk sources, swallowed source errors, unverified FHCRC, and
// MTIME wrap-around.
// ---------------------------------------------------------------------------

const encode = (s: string) => new TextEncoder().encode(s);

async function gzipBytes(chunks: Uint8Array[]): Promise<Uint8Array> {
  return pipe(from(chunks), gzip(createTestDeflator()), collectBytes());
}

describe("zero-chunk sources", () => {
  it("gzip of a source that yields no chunks produces a valid gzip file", async () => {
    // A 0-byte file read yields zero chunks — different from one empty
    // chunk. The output must still contain an (empty) DEFLATE stream.
    const bytes = await gzipBytes([]);
    expect(bytes.length).toBeGreaterThan(18); // header + footer + final block

    const decompressed = await pipe(
      from([bytes]),
      gunzip(createTestInflator()),
      collectBytes(),
    );
    expect(decompressed.length).toBe(0);
  });

  it("matches the one-empty-chunk output", async () => {
    const zeroChunks = await gzipBytes([]);
    const oneEmptyChunk = await gzipBytes([new Uint8Array(0)]);
    expect(zeroChunks).toEqual(oneEmptyChunk);
  });
});

describe("source error propagation", () => {
  it("a source failure after a member boundary surfaces, not silent success", async () => {
    const member = await gzipBytes([encode("first member")]);

    const failing: Source<Uint8Array> = (async function* () {
      yield member;
      throw new Error("NETWORK FAILURE mid-stream");
    })();

    // Before the fix, peekBytes swallowed the error and gunzip reported
    // clean EOF — the caller shipped truncated output believing it whole.
    await expect(
      pipe(failing, gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow("NETWORK FAILURE mid-stream");
  });
});

describe("FHCRC header checksum", () => {
  /** Build a member whose header carries a (correct or corrupted) FHCRC. */
  async function memberWithFhcrc(corrupt: boolean): Promise<Uint8Array> {
    const plain = await gzipBytes([encode("checked header")]);
    const body = plain.slice(10); // DEFLATE stream + footer

    const header = new Uint8Array(12);
    header.set(plain.slice(0, 10));
    header[3] = 0x02; // FLG: FHCRC only

    const crc = new CRC32();
    crc.update(header.slice(0, 10));
    const crc16 = crc.digest() & 0xffff;
    header[10] = crc16 & 0xff;
    header[11] = (crc16 >> 8) & 0xff;

    if (corrupt) {
      // Corrupt a header byte AFTER computing the checksum, so the
      // stored FHCRC no longer matches.
      header[9] = 0x03;
    }

    return new Uint8Array([...header, ...body]);
  }

  it("accepts a member with a correct header CRC", async () => {
    const bytes = await memberWithFhcrc(false);
    const out = await pipe(
      from([bytes]),
      gunzip(createTestInflator()),
      collectBytes(),
    );
    expect(new TextDecoder().decode(out)).toBe("checked header");
  });

  it("strict mode rejects a corrupted header that carries FHCRC", async () => {
    const bytes = await memberWithFhcrc(true);
    await expect(
      pipe(from([bytes]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(/header CRC/i);
  });

  it("permissive mode tolerates a corrupted header CRC", async () => {
    const bytes = await memberWithFhcrc(true);
    const out = await pipe(
      from([bytes]),
      gunzip(createTestInflator(), { crcPolicy: "permissive" }),
      collectBytes(),
    );
    expect(new TextDecoder().decode(out)).toBe("checked header");
  });
});

describe("MTIME encoding", () => {
  function mtimeField(date: Date): number {
    const header = buildGzipHeader({ mtime: date });
    return (
      (header[4]! | (header[5]! << 8) | (header[6]! << 16) | (header[7]! << 24)) >>>
      0
    );
  }

  it("encodes an in-range date as Unix seconds", () => {
    const date = new Date(Date.UTC(2024, 0, 1));
    expect(mtimeField(date)).toBe(Math.floor(date.getTime() / 1000));
  });

  it("clamps pre-1970 dates to 0 (no timestamp) instead of wrapping", () => {
    expect(mtimeField(new Date(Date.UTC(1960, 0, 1)))).toBe(0);
  });

  it("clamps post-2106 dates to 0 instead of wrapping", () => {
    expect(mtimeField(new Date(Date.UTC(2200, 0, 1)))).toBe(0);
  });
});
