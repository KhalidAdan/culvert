import type { Source, Transform, Sink } from "./types.js";

// ---------------------------------------------------------------------------
// track() — wraps an AsyncIterable so we can capture every iterator it creates.
// This is how pipe() knows what to tear down when things go wrong.
// ---------------------------------------------------------------------------

function track<T>(
  iterable: AsyncIterable<T>,
  iterators: AsyncIterator<unknown>[]
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const it = iterable[Symbol.asyncIterator]();
      iterators.push(it);
      return it;
    },
  };
}

// ---------------------------------------------------------------------------
// teardown() — close all tracked iterators, outermost first.
//
// If a primary error exists, it's re-thrown after cleanup. Errors from
// cleanup are attached as .suppressedErrors on the primary (borrowing
// Java's try-with-resources pattern). If there's no primary error but
// cleanup fails, the first cleanup error is thrown.
// ---------------------------------------------------------------------------

async function teardown(
  iterators: AsyncIterator<unknown>[],
  primaryError?: unknown
): Promise<void> {
  const suppressed: unknown[] = [];

  // Walk from outermost to innermost — mirrors the order of creation
  for (let i = iterators.length - 1; i >= 0; i--) {
    try {
      await iterators[i]!.return?.();
    } catch (err) {
      suppressed.push(err);
    }
  }

  if (primaryError !== undefined) {
    if (primaryError instanceof Error && suppressed.length > 0) {
      (primaryError as Error & { suppressedErrors?: unknown[] }).suppressedErrors =
        suppressed;
    }
    throw primaryError;
  }

  if (suppressed.length > 0) {
    throw suppressed[0];
  }
}

// ---------------------------------------------------------------------------
// pipe() — compose a source, zero or more transforms, and a sink.
//
// Returns a promise that resolves with the sink's return value when the
// pipeline drains, or rejects if any stage throws. On any termination
// (success, error, or early return), all tracked iterators are closed.
//
// The overloads exist purely for TypeScript — they let the compiler
// infer the type flowing through each stage and return the sink's
// result type. At runtime it's a single function.
// ---------------------------------------------------------------------------

// prettier-ignore
export function pipe<A, R>(s: Source<A>, sink: Sink<A, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, R>(s: Source<A>, t1: Transform<A, B>, sink: Sink<B, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, C, R>(s: Source<A>, t1: Transform<A, B>, t2: Transform<B, C>, sink: Sink<C, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, C, D, R>(s: Source<A>, t1: Transform<A, B>, t2: Transform<B, C>, t3: Transform<C, D>, sink: Sink<D, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, C, D, E, R>(s: Source<A>, t1: Transform<A, B>, t2: Transform<B, C>, t3: Transform<C, D>, t4: Transform<D, E>, sink: Sink<E, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, C, D, E, F, R>(s: Source<A>, t1: Transform<A, B>, t2: Transform<B, C>, t3: Transform<C, D>, t4: Transform<D, E>, t5: Transform<E, F>, sink: Sink<F, R>): Promise<R>;
// prettier-ignore
export function pipe<A, B, C, D, E, F, G, R>(s: Source<A>, t1: Transform<A, B>, t2: Transform<B, C>, t3: Transform<C, D>, t4: Transform<D, E>, t5: Transform<E, F>, t6: Transform<F, G>, sink: Sink<G, R>): Promise<R>;

// Fallback for longer pipelines — loses intermediate type inference
// prettier-ignore
export function pipe(source: Source<unknown>, ...stages: [...Transform<any, any>[], Sink<any, any>]): Promise<unknown>;

export function pipe(
  source: Source<unknown>,
  ...stages: [...Transform<any, any>[], Sink<any, any>]
): Promise<unknown> {
  // Separate the sink (last argument) from transforms (everything else)
  const sink = stages.pop() as Sink<unknown, unknown>;
  const transforms = stages as Transform<unknown, unknown>[];

  // Track every iterator so we can guarantee cleanup
  const iterators: AsyncIterator<unknown>[] = [];

  // Build the pipeline: each transform wraps the previous source
  let current: AsyncIterable<unknown> = track(source, iterators);
  for (const transform of transforms) {
    current = track(transform(current), iterators);
  }

  // Run — the sink pulls through the entire chain
  const run = async (): Promise<unknown> => {
    let primaryError: unknown;
    let result: unknown;

    try {
      result = await sink(current);
    } catch (err) {
      primaryError = err;
    }

    // Always tear down, regardless of outcome.
    // teardown() re-throws primaryError if set, attaching any
    // suppressed cleanup errors.
    await teardown(iterators, primaryError);

    return result;
  };

  return run();
}
