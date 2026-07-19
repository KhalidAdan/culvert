import { describe, it, expect } from "vitest";
import { gzip, gunzip } from "./index.js";
import { pipe, collectBytes, from } from "@culvert/stream";
import { GzipCorruptionError } from "./errors.js";
import { HEADER_SIZE, FOOTER_SIZE, GZIP_ID1, GZIP_ID2 } from "./constants.js";
import { createTestDeflator, createTestInflator } from "./test-codec.js";

describe("corruption detection (strict)", () => {
  it("throws on bad magic bytes", async () => {
    const bad = new Uint8Array([0x00, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff]);
    await expect(
      pipe(from([bad]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(GzipCorruptionError);
  });

  it("throws on truncated header", async () => {
    const truncated = new Uint8Array([GZIP_ID1, GZIP_ID2, 0x08]);
    await expect(
      pipe(from([truncated]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(GzipCorruptionError);
  });

  it("throws on bad compression method", async () => {
    const bad = new Uint8Array(HEADER_SIZE);
    bad[0] = GZIP_ID1;
    bad[1] = GZIP_ID2;
    bad[2] = 99;
    await expect(
      pipe(from([bad]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(GzipCorruptionError);
  });

  it("throws on CRC mismatch", async () => {
    const input = new TextEncoder().encode("hello");
    const compressed = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );

    const corrupted = new Uint8Array(compressed);
    corrupted[corrupted.length - FOOTER_SIZE] ^= 0xff;

    await expect(
      pipe(from([corrupted]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(GzipCorruptionError);
  });

  it("throws on ISIZE mismatch", async () => {
    const input = new TextEncoder().encode("hello");
    const compressed = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );

    const corrupted = new Uint8Array(compressed);
    corrupted[corrupted.length - 4] ^= 0xff;

    await expect(
      pipe(from([corrupted]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(GzipCorruptionError);
  });
});

describe("corruption handling (permissive)", () => {
  it("yields data despite CRC mismatch", async () => {
    const input = new TextEncoder().encode("hello");
    const compressed = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );

    const corrupted = new Uint8Array(compressed);
    corrupted[corrupted.length - FOOTER_SIZE] ^= 0xff;

    const output = await pipe(
      from([corrupted]),
      gunzip(createTestInflator(), { crcPolicy: "permissive" }),
      collectBytes(),
    );
    expect(output).toEqual(input);
  });

  it("yields data despite ISIZE mismatch", async () => {
    const input = new TextEncoder().encode("hello");
    const compressed = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );

    const corrupted = new Uint8Array(compressed);
    corrupted[corrupted.length - 4] ^= 0xff;

    const output = await pipe(
      from([corrupted]),
      gunzip(createTestInflator(), { crcPolicy: "permissive" }),
      collectBytes(),
    );
    expect(output).toEqual(input);
  });
});
