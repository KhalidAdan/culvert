import type { Source } from "./types.js";

// ---------------------------------------------------------------------------
// from() — create a Source from common data types.
//
// Accepts arrays, sync iterables, async iterables, and single values.
// This is the on-ramp to a Culvert pipeline.
// ---------------------------------------------------------------------------

export function from<T>(input: AsyncIterable<T>): Source<T>;
export function from<T>(input: Iterable<T>): Source<T>;
export function from<T>(input: Iterable<T> | AsyncIterable<T>): Source<T> {
  // Already async iterable — return as-is
  if (Symbol.asyncIterator in input) {
    return input as AsyncIterable<T>;
  }

  // Sync iterable — wrap in async generator
  return (async function* () {
    for (const item of input as Iterable<T>) {
      yield item;
    }
  })();
}

// ---------------------------------------------------------------------------
// empty() — a source that immediately completes with no items.
// ---------------------------------------------------------------------------

export function empty<T = never>(): Source<T> {
  return (async function* () {
    // nothing
  })();
}

// ---------------------------------------------------------------------------
// of() — a source that emits the given values and completes.
// ---------------------------------------------------------------------------

export function of<T>(...values: T[]): Source<T> {
  return (async function* () {
    for (const value of values) {
      yield value;
    }
  })();
}
