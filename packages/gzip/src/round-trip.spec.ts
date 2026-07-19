import { describe, it, expect } from "vitest";
import { gzip, gunzip } from "./index.js";
import { pipe, collectBytes, from } from "@culvert/stream";
import { createTestDeflator, createTestInflator } from "./test-codec.js";

function roundTrip(
  input: Uint8Array,
  gzipOpts?: Parameters<typeof gzip>[1],
  gunzipOpts?: Parameters<typeof gunzip>[1],
): Promise<Uint8Array> {
  return pipe(
    from([input]),
    gzip(createTestDeflator(), gzipOpts),
    gunzip(createTestInflator(), gunzipOpts),
    collectBytes(),
  );
}

describe("gzip/gunzip round-trip", () => {
  it("round-trips empty input", async () => {
    const input = new Uint8Array(0);
    const output = await roundTrip(input);
    expect(output).toEqual(input);
  });

  it("round-trips 'Hello, world!'", async () => {
    const input = new TextEncoder().encode("Hello, world!");
    const output = await roundTrip(input);
    expect(output).toEqual(input);
  });

  it("round-trips binary data (0x00..0xFF)", async () => {
    const input = new Uint8Array(256);
    for (let i = 0; i < 256; i++) input[i] = i;
    const output = await roundTrip(input);
    expect(output).toEqual(input);
  });

  it("round-trips multi-chunk input", async () => {
    const a = new TextEncoder().encode("chunk one ");
    const b = new TextEncoder().encode("chunk two ");
    const c = new TextEncoder().encode("chunk three");

    const compressed = await pipe(
      from([a, b, c]),
      gzip(createTestDeflator()),
      collectBytes(),
    );
    const decompressed = await pipe(
      from([compressed]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    const expected = new Uint8Array(a.length + b.length + c.length);
    expected.set(a, 0);
    expected.set(b, a.length);
    expected.set(c, a.length + b.length);
    expect(decompressed).toEqual(expected);
  });

  it("round-trips 1 MiB of data", async () => {
    const input = new Uint8Array(1024 * 1024);
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 7 + 13) & 0xff;
    }
    const output = await roundTrip(input);
    expect(output).toEqual(input);
  });
});

describe("gzip header options", () => {
  it("round-trips with filename", async () => {
    const input = new TextEncoder().encode("data");
    const output = await roundTrip(input, { filename: "test.txt" });
    expect(output).toEqual(input);
  });

  it("round-trips with comment", async () => {
    const input = new TextEncoder().encode("data");
    const output = await roundTrip(input, { comment: "a comment" });
    expect(output).toEqual(input);
  });

  it("round-trips with filename and comment", async () => {
    const input = new TextEncoder().encode("data");
    const output = await roundTrip(input, {
      filename: "test.txt",
      comment: "hello",
    });
    expect(output).toEqual(input);
  });

  it("round-trips with custom mtime", async () => {
    const input = new TextEncoder().encode("data");
    const output = await roundTrip(input, {
      mtime: new Date("2024-06-15T00:00:00Z"),
    });
    expect(output).toEqual(input);
  });
});

describe("reproducibility", () => {
  it("same input + same codec + same options = identical output", async () => {
    const input = new TextEncoder().encode("deterministic");
    const a = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );
    const b = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );
    expect(a).toEqual(b);
  });

  it("default mtime is epoch", async () => {
    const input = new TextEncoder().encode("test");
    const a = await pipe(
      from([input]),
      gzip(createTestDeflator()),
      collectBytes(),
    );
    const b = await pipe(
      from([input]),
      gzip(createTestDeflator(), { mtime: new Date(0) }),
      collectBytes(),
    );
    expect(a).toEqual(b);
  });
});
