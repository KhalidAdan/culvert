import type { Sink } from "./types.js";

// ---------------------------------------------------------------------------
// collect() — gather all chunks into an array.
//
// Returns Sink<T, T[]>. When used as the last argument to pipe(),
// the pipeline returns Promise<T[]>.
// ---------------------------------------------------------------------------

export function collect<T>(): Sink<T, T[]> {
  return async (source) => {
    const items: T[] = [];
    for await (const item of source) {
      items.push(item);
    }
    return items;
  };
}

// ---------------------------------------------------------------------------
// collectBytes() — concatenate all Uint8Array chunks into one.
//
// The common case for binary pipelines. Pre-allocates the result
// buffer from accumulated length rather than copying on every chunk.
// ---------------------------------------------------------------------------

export function collectBytes(): Sink<Uint8Array, Uint8Array> {
  return async (source) => {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    for await (const chunk of source) {
      chunks.push(chunk);
      totalLength += chunk.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  };
}
