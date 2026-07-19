import { describe, it, expect } from "vitest";
import { gzip, gunzip } from "./index.js";
import { pipe, collectBytes, from } from "@culvert/stream";
import type { Inflator, Deflator } from "./types.js";
import { FOOTER_SIZE } from "./constants.js";

describe("codec interface", () => {
  it("CRC is computed on uncompressed data regardless of codec", async () => {
    const input = new TextEncoder().encode("CRC check");

    // Identity "codec" — no actual compression
    const identityDeflator: Deflator = {
      deflate(chunk, _final) {
        return chunk;
      },
    };

    const identityInflator: Inflator = {
      inflate(chunk) {
        return { output: chunk, consumed: chunk.length, done: true };
      },
      reset() {},
    };

    const compressed = await pipe(
      from([input]),
      gzip(identityDeflator),
      collectBytes(),
    );

    // Split so the gzip footer is in its own chunk; the identity
    // inflator doesn't understand DEFLATE boundaries and would
    // otherwise consume the footer bytes.
    const body = compressed.subarray(0, compressed.length - FOOTER_SIZE);
    const footer = compressed.subarray(compressed.length - FOOTER_SIZE);

    const decompressed = await pipe(
      from([body, footer]),
      gunzip(identityInflator),
      collectBytes(),
    );

    expect(decompressed).toEqual(input);
  });

  it("inflator.reset() is called between concatenated members", async () => {
    const input = new TextEncoder().encode("data");

    // Deflator that just passes through
    const identityDeflator: Deflator = {
      deflate(chunk, _final) {
        return chunk;
      },
    };

    // Compress two members
    const memberA = await pipe(
      from([input]),
      gzip(identityDeflator),
      collectBytes(),
    );
    const memberB = await pipe(
      from([input]),
      gzip(identityDeflator),
      collectBytes(),
    );

    // Split each member so its footer is in a separate chunk;
    // otherwise the identity inflator consumes footer bytes.
    const chunks: Uint8Array[] = [
      memberA.subarray(0, memberA.length - FOOTER_SIZE),
      memberA.subarray(memberA.length - FOOTER_SIZE),
      memberB.subarray(0, memberB.length - FOOTER_SIZE),
      memberB.subarray(memberB.length - FOOTER_SIZE),
    ];

    // Inflator that tracks reset calls
    let resetCount = 0;
    const trackingInflator: Inflator = {
      inflate(chunk) {
        return { output: chunk, consumed: chunk.length, done: true };
      },
      reset() {
        resetCount++;
      },
    };

    await pipe(from(chunks), gunzip(trackingInflator), collectBytes());

    // reset() called after first member, and after second member
    expect(resetCount).toBe(2);
  });
});
