import { describe, expect, it } from "vitest";
import {
  batch,
  concat,
  finalize,
  flatMap,
  merge,
  tap,
} from "../src/operators.js";
import { pipe } from "../src/pipe.js";
import { collect } from "../src/sinks.js";
import { from } from "../src/sources.js";
import type { Sink, Source } from "../src/types.js";

// Simple sink that consumes everything and returns void — used for side-effect-only tests
const consume: Sink<unknown> = async (source) => {
  for await (const _ of source) { /* drain */ }
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// tap
// ---------------------------------------------------------------------------
describe("tap", () => {
  it("observes every chunk without altering the stream", async () => {
    const observed: number[] = [];
    const result = await pipe(
      from([1, 2, 3]),
      tap((n) => {
        observed.push(n);
      }),
      collect(),
    );
    expect(result).toStrictEqual([1, 2, 3]);
    expect(observed).toStrictEqual([1, 2, 3]);
  });

  it("awaits async side effects", async () => {
    const order: string[] = [];
    await pipe(
      from([1, 2]),
      tap(async (n) => {
        await delay(10);
        order.push(`tap-${n}`);
      }),
      tap((n) => {
        order.push(`sync-${n}`);
      }),
      consume,
    );
    expect(order).toStrictEqual(["tap-1", "sync-1", "tap-2", "sync-2"]);
  });

  it("error in tap propagates", async () => {
    await expect(
      pipe(
        from([1, 2, 3]),
        tap((n) => {
          if (n === 2) throw new Error("tap error");
        }),
        consume,
      ),
    ).rejects.toThrow("tap error");
  });
});

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------
describe("finalize", () => {
  it("runs on normal completion", async () => {
    let finalized = false;
    await pipe(
      from([1, 2, 3]),
      finalize(() => {
        finalized = true;
      }),
      consume,
    );
    expect(finalized).toStrictEqual(true);
  });

  it("runs on error", async () => {
    let finalized = false;
    const failing: Source<number> = (async function* () {
      yield 1;
      throw new Error("boom");
    })();
    await expect(() =>
      pipe(
        failing,
        finalize(() => {
          finalized = true;
        }),
        consume,
      ),
    ).rejects.toThrow("boom");
    expect(finalized).toStrictEqual(true);
  });

  it("runs on early consumer termination", async () => {
    let finalized = false;
    const takeSink: Sink<number> = async (source) => {
      for await (const _ of source) return;
    };
    await pipe(
      from([1, 2, 3, 4, 5]),
      finalize(() => {
        finalized = true;
      }),
      takeSink,
    );
    expect(finalized).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------
describe("batch", () => {
  it("groups items into batches of n", async () => {
    const result = await pipe(from([1, 2, 3, 4, 5]), batch(2), collect());
    expect(result).toStrictEqual([[1, 2], [3, 4], [5]]);
  });

  it("flushes the last incomplete batch", async () => {
    const result = await pipe(from([1, 2, 3]), batch(5), collect());
    expect(result).toStrictEqual([[1, 2, 3]]);
  });

  it("handles exact multiples", async () => {
    const result = await pipe(from([1, 2, 3, 4]), batch(2), collect());
    expect(result).toStrictEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("empty input produces no batches", async () => {
    const result = await pipe(from([]), batch(3), collect());
    expect(result).toStrictEqual([]);
  });

  it("batch of 1 wraps each item", async () => {
    const result = await pipe(from([1, 2, 3]), batch(1), collect());
    expect(result).toStrictEqual([[1], [2], [3]]);
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------
describe("merge", () => {
  it("interleaves items from multiple sources", async () => {
    const a = from([1, 2, 3]);
    const b = from([4, 5, 6]);
    const result = await pipe(merge(a, b), collect());
    expect(result.sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 4, 5, 6]);
  });

  it("single source passes through", async () => {
    const result = await pipe(merge(from([1, 2, 3])), collect());
    expect(result).toStrictEqual([1, 2, 3]);
  });

  it("empty merge produces nothing", async () => {
    const result = await pipe(merge<number>(), collect());
    expect(result).toStrictEqual([]);
  });

  it("tears down all sources when one errors", async () => {
    let bReturned = false;
    const a: Source<number> = (async function* () {
      yield 1;
      throw new Error("a failed");
    })();
    const b: Source<number> = (async function* () {
      try {
        yield 2;
        await delay(100);
        yield 3;
      } finally {
        bReturned = true;
      }
    })();
    await expect(() => pipe(merge(a, b), collect())).rejects.toThrow(
      "a failed",
    );
    expect(bReturned).toStrictEqual(true);
  });

  it("handles sources of different lengths", async () => {
    const short = from([1]);
    const long = from([2, 3, 4, 5]);
    const result = await pipe(merge(short, long), collect());
    expect(result.sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// concat
// ---------------------------------------------------------------------------
describe("concat", () => {
  it("consumes sources sequentially", async () => {
    const result = await pipe(
      concat(from([1, 2]), from([3, 4]), from([5])),
      collect(),
    );
    expect(result).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it("empty sources are skipped", async () => {
    const result = await pipe(
      concat(from([1]), from([]), from([2])),
      collect(),
    );
    expect(result).toStrictEqual([1, 2]);
  });

  it("no sources produces nothing", async () => {
    const result = await pipe(concat<number>(), collect());
    expect(result).toStrictEqual([]);
  });

  it("error in second source propagates", async () => {
    const failing: Source<number> = (async function* () {
      throw new Error("second failed");
    })();
    await expect(() =>
      pipe(concat(from([1, 2]), failing), collect()),
    ).rejects.toThrow("second failed");
  });
});

// ---------------------------------------------------------------------------
// flatMap
// ---------------------------------------------------------------------------
describe("flatMap", () => {
  it("sequential — processes inner sources one at a time", async () => {
    const result = await pipe(
      from([1, 2, 3]),
      flatMap((n) => from([n, n * 10])),
      collect(),
    );
    expect(result).toStrictEqual([1, 10, 2, 20, 3, 30]);
  });

  it("concurrent — processes multiple inner sources", async () => {
    const result = await pipe(
      from([1, 2, 3]),
      flatMap((n) => from([n, n * 10]), { concurrency: 3 }),
      collect(),
    );
    expect(result.sort((a, b) => a - b)).toStrictEqual([1, 2, 3, 10, 20, 30]);
  });

  it("inner source errors propagate", async () => {
    await expect(() =>
      pipe(
        from([1, 2, 3]),
        flatMap((n) => {
          if (n === 2) {
            return (async function* () {
              throw new Error("inner failed");
            })();
          }
          return from([n]);
        }),
        collect(),
      ),
    ).rejects.toThrow("inner failed");
  });

  it("empty inner sources are fine", async () => {
    const result = await pipe(
      from([1, 2, 3]),
      flatMap(() => from([])),
      collect(),
    );
    expect(result).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composition: operators work together
// ---------------------------------------------------------------------------
describe("composition", () => {
  it("tap + batch + collect", async () => {
    let sum = 0;
    const result = await pipe(
      from([1, 2, 3, 4, 5]),
      tap((n) => {
        sum += n;
      }),
      batch(2),
      collect(),
    );
    expect(result).toStrictEqual([[1, 2], [3, 4], [5]]);
    expect(sum).toEqual(15);
  });

  it("concat + flatMap + finalize", async () => {
    const log: string[] = [];
    const result = await pipe(
      concat(from(["a", "b"]), from(["c"])),
      flatMap((letter) => from([letter, letter.toUpperCase()])),
      finalize(() => {
        log.push("done");
      }),
      collect(),
    );
    expect(result).toStrictEqual(["a", "A", "b", "B", "c", "C"]);
    expect(log).toStrictEqual(["done"]);
  });

  it("the ZIP pipeline pattern: observe → transform → observe → collect", async () => {
    let rawSize = 0;
    let transformedSize = 0;

    const data = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
      new Uint8Array([6]),
    ];

    const double: (source: Source<Uint8Array>) => Source<Uint8Array> =
      async function* (source) {
        for await (const chunk of source) {
          const out = new Uint8Array(chunk.length * 2);
          for (let i = 0; i < chunk.length; i++) {
            out[i * 2] = chunk[i]!;
            out[i * 2 + 1] = chunk[i]!;
          }
          yield out;
        }
      };

    const result = await pipe(
      from(data),
      tap((chunk) => {
        rawSize += chunk.length;
      }),
      double,
      tap((chunk) => {
        transformedSize += chunk.length;
      }),
      collect(),
    );

    expect(rawSize).toEqual(6);
    expect(transformedSize).toEqual(12);
    expect(result.length).toEqual(3);
    expect(result[0]).toStrictEqual(new Uint8Array([1, 1, 2, 2, 3, 3]));
  });
});
