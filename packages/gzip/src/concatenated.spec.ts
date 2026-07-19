import { describe, it, expect } from "vitest";
import { gzip, gunzip } from "./index.js";
import { pipe, collectBytes, from } from "@culvert/stream";
import { createTestDeflator, createTestInflator } from "./test-codec.js";

// Helper: compress a Uint8Array into a single gzip member
async function compressMember(input: Uint8Array): Promise<Uint8Array> {
  return pipe(from([input]), gzip(createTestDeflator()), collectBytes());
}

// Helper: concatenate Uint8Arrays
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

describe("concatenated gzip members", () => {
  it("decompresses two concatenated members", async () => {
    const a = new TextEncoder().encode("first member ");
    const b = new TextEncoder().encode("second member");

    const memberA = await compressMember(a);
    const memberB = await compressMember(b);
    const combined = concat(memberA, memberB);

    const output = await pipe(
      from([combined]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    expect(output).toEqual(concat(a, b));
  });

  it("decompresses three concatenated members", async () => {
    const a = new TextEncoder().encode("one ");
    const b = new TextEncoder().encode("two ");
    const c = new TextEncoder().encode("three");

    const combined = concat(
      await compressMember(a),
      await compressMember(b),
      await compressMember(c),
    );

    const output = await pipe(
      from([combined]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    expect(output).toEqual(concat(a, b, c));
  });

  it("handles empty member between non-empty members", async () => {
    const a = new TextEncoder().encode("before");
    const empty = new Uint8Array(0);
    const b = new TextEncoder().encode("after");

    const combined = concat(
      await compressMember(a),
      await compressMember(empty),
      await compressMember(b),
    );

    const output = await pipe(
      from([combined]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    expect(output).toEqual(concat(a, b));
  });

  it("handles single member (no concatenation)", async () => {
    const input = new TextEncoder().encode("just one");
    const compressed = await compressMember(input);

    const output = await pipe(
      from([compressed]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    expect(output).toEqual(input);
  });

  it("stops at non-gzip trailing bytes", async () => {
    const input = new TextEncoder().encode("data");
    const compressed = await compressMember(input);
    const trailing = new Uint8Array([0x00, 0x00, 0x00]); // not gzip magic
    const combined = concat(compressed, trailing);

    const output = await pipe(
      from([combined]),
      gunzip(createTestInflator()),
      collectBytes(),
    );

    expect(output).toEqual(input);
  });
});
