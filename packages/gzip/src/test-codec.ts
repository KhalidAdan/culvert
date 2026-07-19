// ---------------------------------------------------------------------------
// Test codec — NOT exported, NOT production-grade.
//
// Wraps pako for testing the framing layer. Uses platform
// DecompressionStream for inflate if pako is unavailable.
// ---------------------------------------------------------------------------

import Pako from "pako";
import type { Inflator, Deflator } from "./types.js";

interface PakoInflateLike {
  push(data: Uint8Array | ArrayBuffer): boolean;
  result: Uint8Array | undefined;
  ended: boolean;
  strm: { avail_in: number };
}

interface PakoDeflateLike {
  push(data: Uint8Array | ArrayBuffer, final: boolean): boolean;
  result: Uint8Array | undefined;
}

/**
 * Test inflator backed by pako.
 */
export function createTestInflator(): Inflator {
  let inf: PakoInflateLike = new Pako.Inflate({ raw: true }) as unknown as PakoInflateLike;

  return {
    inflate(chunk: Uint8Array) {
      inf.push(chunk);
      const consumed = chunk.length - inf.strm.avail_in;
      const output = inf.result ?? new Uint8Array(0);
      return { output, consumed, done: inf.ended };
    },
    reset() {
      inf = new Pako.Inflate({ raw: true }) as unknown as PakoInflateLike;
    },
  };
}

/**
 * Test deflator backed by pako.
 */
export function createTestDeflator(): Deflator {
  const def: PakoDeflateLike = new Pako.Deflate({ raw: true }) as unknown as PakoDeflateLike;

  return {
    deflate(chunk: Uint8Array, final: boolean) {
      def.push(chunk, final);
      return def.result ?? new Uint8Array(0);
    },
  };
}
