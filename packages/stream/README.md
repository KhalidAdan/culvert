# @culvert/stream

Composable streaming primitives for JavaScript. Zero dependencies. TypeScript-first.

```ts
await pipe(source, transform, transform, sink);
```

## Types

```ts
type Source<T> = AsyncIterable<T>;
type Transform<I, O> = (source: Source<I>) => Source<O>;
type Sink<T, R> = (source: Source<T>) => Promise<R>;
```

That's the whole contract. Transforms are async generators. Sinks drive the pipeline by pulling.

## pipe()

Composes a source, zero (lol) or more transforms, and a sink. Returns `Promise<R>` where `R` is inferred from the sink.

**Three promises:**

1. **If any stage fails, everything tears down.** Every tracked iterator gets `.return()` called, outermost first. File handles close. Sockets disconnect.
2. **If the consumer stops early, producers stop.** Whether that's early return, `abortable()`, or the sink throwing.
3. **The error you see is the real one.** Cleanup errors attach as `.suppressedErrors` on the primary error, never mask it.

## Operators

Each one passes the filter: _would a five-line async generator get this wrong?_

```ts
tap(fn)                      // observe without altering — awaits async fn
finalize(fn)                 // guaranteed cleanup on any termination path
abortable(source, signal)    // stop on AbortSignal
batch(n, ms?)                // count/time windowing with correct flush
merge(...sources)            // concurrent interleave with full teardown
concat(...sources)           // sequential with inter-source cleanup
flatMap(fn, { concurrency }) // subsumes concatMap/mergeMap via one knob
buffer(size, strategy?)      // push→pull: "suspend" | "drop" | "slide" | "error"
```

`map`, `filter`, `take`, `scan` are **not included** — they're trivial as inline generators and the language already provides them.

## Sources and sinks

```ts
from([1, 2, 3])        of(1, 2, 3)         empty()

collect()              // → T[]
collectBytes()         // → Uint8Array
```

## Web Streams bridge

```ts
toReadableStream(source); // for Response, fetch
fromReadableStream(readable); // handles Safari's missing async iterator
writeTo(writable); // sink that writes to a WritableStream
```

## The pattern that proves it

ZIP entry pipeline — observe raw bytes, compress, observe compressed bytes, write:

```ts
const crc = new CRC32();
let rawSize = 0,
  compressedSize = 0;

await pipe(
  file.source,
  tap((chunk) => {
    crc.update(chunk);
    rawSize += chunk.length;
  }),
  deflate(),
  tap((chunk) => {
    compressedSize += chunk.length;
  }),
  writeTo(output),
);
```

`crc32` doesn't know about `pipe()`. `tap()` doesn't know about CRC-32. They compose because the interfaces are simple.

## Transform authoring notes

**Resources need `try/finally`.** When `.return()` is called on an async generator, execution jumps to `finally`, skipping code after the `for await` loop.

**Nested `pipe()` blocks outer teardown.** Inner pipelines can't be interrupted by outer cancellation (Promises) — thread `abortable()` through if you need this.

## What's not in v1

| Decision                     | Reasoning                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No typed errors**          | Would make `pipe()` overloads nightmarish (`E1 \| E2 \| E3 \| ...`). Most catch blocks don't branch on error source. Revisit in v2 if demand appears.                 |
| **No sync fast path**        | Async iteration overhead is noise for I/O-bound workloads. Planned optimization: chunk batching (Effect.Stream's approach) — amortizes overhead without changing API. |
| **No `throttle`/`debounce`** | Timing operators for UI streams. Not relevant to data pipelines yet.                                                                                                  |
| **No Node stream bridges**   | Web Streams bridges ship first (Response/fetch). Node bridges come when we have usage to validate against.                                                            |

## Stress test findings

| Scenario                                   | Result                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buffering transform + early consumer       | `finally` runs, post-loop flush skipped. Correct — document `try/finally` pattern.                                                                                                         |
| `flatMap` concurrent sub-source teardown   | `pipe()` tracks direct iterators only. `flatMap` manages its own children. Confirms it as a core operator.                                                                                 |
| Double iterator creation on tracked source | `track()` captures both. Redundant `.return()` on closed iterator is a no-op per spec.                                                                                                     |
| `suppressedErrors` with `for await` sinks  | `for await`'s own cleanup fires before `pipe()`'s teardown. `suppressedErrors` works for manual-iteration sinks. Well-behaved `for await` sinks get correct propagation from the language. |

## Stats

921 lines of source. 725 lines of tests. 54 tests. Zero dependencies.

```
stream
├── crc32    (leaf — no culvert deps)
├── zip      (stream + crc32, implementing)
├── gzip     (stream, planned)
└── tar      (stream, planned)
```

MIT
