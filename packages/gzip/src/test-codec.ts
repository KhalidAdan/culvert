// ---------------------------------------------------------------------------
// Test codec — NOT exported. Wraps pako for testing the framing layer.
//
// This is the same wrapper the README documents. It is truly streaming:
// pako's onData hook hands back each output block as it is produced,
// instead of relying on `.result`, which pako only populates after the
// WHOLE stream has been pushed (buffering everything in memory). It
// also surfaces pako errors instead of swallowing them.
// ---------------------------------------------------------------------------

import Pako from "pako";
import type { Inflator, Deflator } from "./types.js";

interface PakoStreamLike {
  onData: (chunk: Uint8Array) => void;
  onEnd: (status: number) => void;
  ended: boolean;
  err: number;
  msg: string;
  strm: { avail_in: number };
}

interface PakoInflateLike extends PakoStreamLike {
  push(data: Uint8Array | ArrayBuffer): boolean;
}

interface PakoDeflateLike extends PakoStreamLike {
  push(data: Uint8Array | ArrayBuffer, final: boolean): boolean;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Streaming inflator backed by pako.
 */
export function createTestInflator(): Inflator {
  let chunks: Uint8Array[] = [];

  function make(): PakoInflateLike {
    const inf = new Pako.Inflate({ raw: true }) as unknown as PakoInflateLike;
    inf.onData = (chunk) => {
      chunks.push(chunk);
    };
    inf.onEnd = () => {}; // output flows through onData, not .result
    return inf;
  }

  let inf = make();

  return {
    inflate(chunk: Uint8Array) {
      inf.push(chunk);
      if (inf.err) {
        throw new Error(`pako inflate error ${inf.err}: ${inf.msg}`);
      }
      const consumed = chunk.length - inf.strm.avail_in;
      const output = concat(chunks);
      chunks = [];
      return { output, consumed, done: inf.ended };
    },
    reset() {
      chunks = [];
      inf = make();
    },
  };
}

/**
 * Streaming deflator backed by pako.
 */
export function createTestDeflator(): Deflator {
  let chunks: Uint8Array[] = [];

  const def = new Pako.Deflate({ raw: true }) as unknown as PakoDeflateLike;
  def.onData = (chunk) => {
    chunks.push(chunk);
  };
  def.onEnd = () => {};

  return {
    deflate(chunk: Uint8Array, final: boolean) {
      def.push(chunk, final);
      if (def.err) {
        throw new Error(`pako deflate error ${def.err}: ${def.msg}`);
      }
      const output = concat(chunks);
      chunks = [];
      return output;
    },
  };
}
