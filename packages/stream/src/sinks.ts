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

// ---------------------------------------------------------------------------
// forEach() — run a function on every chunk, return nothing.
//
// Unlike tap(), this is a sink — it terminates the pipeline.
// Like tap(), it awaits async callbacks to preserve backpressure.
// ---------------------------------------------------------------------------

export function forEach<T>(fn: (chunk: T) => void | Promise<void>): Sink<T> {
  return async (source) => {
    for await (const item of source) {
      await fn(item);
    }
  };
}

// ---------------------------------------------------------------------------
// reduce() — fold all chunks into a single value.
//
// Returns Sink<T, A> where A is the accumulator type.
// ---------------------------------------------------------------------------

export function reduce<T, A>(
  fn: (acc: A, chunk: T) => A | Promise<A>,
  initial: A
): Sink<T, A> {
  return async (source) => {
    let acc = initial;
    for await (const item of source) {
      acc = await fn(acc, item);
    }
    return acc;
  };
}

// ---------------------------------------------------------------------------
// discard() — consume and throw away every chunk.
//
// Useful when the pipeline exists purely for its side effects (e.g.,
// tap() observers). The stream equivalent of piping to /dev/null.
// ---------------------------------------------------------------------------

export function discard<T>(): Sink<T> {
  return async (source) => {
    for await (const _ of source) {
      // intentionally empty
    }
  };
}
