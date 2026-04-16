import { describe, expect, it } from "vitest";
import { abortable } from "./operators.js";
import { pipe } from "./pipe.js";
import { collect } from "./sinks.js";
import { from } from "./sources.js";
import type { Sink, Source, Transform } from "./types.js";

// Simple sink that consumes everything and returns void
const consume: Sink<unknown> = async (source) => {
  for await (const _ of source) { /* drain */ }
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function trackableSource<T>(items: T[]) {
  let wasReturned = false;
  const source: Source<T> = (async function* () {
    try {
      for (const item of items) yield item;
    } finally {
      wasReturned = true;
    }
  })();
  return { source, returned: () => wasReturned };
}

function failingSource<T>(items: T[], error: Error): Source<T> {
  return (async function* () {
    for (const item of items) yield item;
    throw error;
  })();
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("pipe: happy path", () => {
  it("source → sink", async () => {
    const result = await pipe(from([1, 2, 3]), collect());
    expect(result).toStrictEqual([1, 2, 3]);
  });

  it("source → transform → sink", async () => {
    const double: Transform<number, number> = async function* (source) {
      for await (const n of source) yield n * 2;
    };
    const result = await pipe(from([1, 2, 3]), double, collect());
    expect(result).toStrictEqual([2, 4, 6]);
  });

  it("source → multiple transforms → sink", async () => {
    const double: Transform<number, number> = async function* (source) {
      for await (const n of source) yield n * 2;
    };
    const toString: Transform<number, string> = async function* (source) {
      for await (const n of source) yield `#${n}`;
    };
    const result = await pipe(from([1, 2, 3]), double, toString, collect());
    expect(result).toStrictEqual(["#2", "#4", "#6"]);
  });

  it("empty source produces empty result", async () => {
    const result = await pipe(from([]), collect());
    expect(result).toStrictEqual([]);
  });

  it("sink return value flows through", async () => {
    const count: Sink<number, number> = async (source) => {
      let n = 0;
      for await (const _ of source) n++;
      return n;
    };
    const result = await pipe(from([1, 2, 3]), count);
    expect(result).toStrictEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Promise #1 — if any stage fails, everything tears down
// ---------------------------------------------------------------------------
describe("pipe: error teardown", () => {
  it("source error rejects the pipeline", async () => {
    const source = failingSource([1, 2], new Error("source failed"));
    await expect(() => pipe(source, collect())).rejects.toThrow(
      "source failed",
    );
  });

  it("transform error tears down upstream", async () => {
    const { source, returned } = trackableSource([1, 2, 3]);
    const failing: Transform<number, number> = async function* (src) {
      for await (const n of src) {
        if (n === 2) throw new Error("transform failed");
        yield n;
      }
    };
    await expect(() => pipe(source, failing, collect())).rejects.toThrow(
      "transform failed",
    );
    expect(returned()).toEqual(true);
  });

  it("sink error tears down all upstream stages", async () => {
    const { source, returned } = trackableSource([1, 2, 3]);
    let transformReturned = false;
    const tracking: Transform<number, number> = async function* (src) {
      try {
        for await (const n of src) yield n;
      } finally {
        transformReturned = true;
      }
    };
    const failingSink: Sink<number> = async (src) => {
      for await (const n of src) {
        if (n === 2) throw new Error("sink failed");
      }
    };
    await expect(() => pipe(source, tracking, failingSink)).rejects.toThrow(
      "sink failed",
    );
    expect(returned()).toEqual(true);
    expect(transformReturned).toEqual(true);
  });

  it("cleanup errors attach as suppressedErrors", async () => {
    // The source's finally block throws during cleanup.
    // The sink manually iterates (no for-await) and throws WITHOUT
    // calling .return() — leaving cleanup to pipe's teardown.
    const source: Source<number> = (async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        throw new Error("cleanup failed");
      }
    })();
    const failingSink: Sink<number> = async (src) => {
      const it = src[Symbol.asyncIterator]();
      await it.next(); // consumes 1
      // Throw without calling it.return() — pipe must clean up
      throw new Error("sink failed");
    };
    try {
      await pipe(source, failingSink);
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toEqual("sink failed");
      expect(Array.isArray(err.suppressedErrors)).toBe(true);
      expect(err.suppressedErrors.length).toEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Promise #2 — if the consumer stops early, producers stop
// ---------------------------------------------------------------------------
describe("pipe: early termination", () => {
  it("sink that returns early closes upstream", async () => {
    const { source, returned } = trackableSource([1, 2, 3, 4, 5]);
    const takeOne: Sink<number, number> = async (src) => {
      for await (const n of src) return n;
      return -1;
    };
    const result = await pipe(source, takeOne);
    expect(result).toEqual(1);
    expect(returned()).toEqual(true);
  });

  it("abortable source stops on signal", async () => {
    const items: number[] = [];
    const controller = new AbortController();
    const infinite: Source<number> = (async function* () {
      let i = 0;
      while (true) {
        yield i++;
        await delay(10);
      }
    })();
    const collectSome: Sink<number> = async (source) => {
      for await (const n of source) {
        items.push(n);
        if (items.length === 3) controller.abort();
      }
    };
    await pipe(abortable(infinite, controller.signal), collectSome);
    expect(items.length >= 3).toBe(true);
    expect(items.length <= 4).toBe(true);
  });

  it("already-aborted signal produces empty stream", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await pipe(
      abortable(from([1, 2, 3]), controller.signal),
      collect(),
    );
    expect(result).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Promise #3 — the error tells you what happened
// ---------------------------------------------------------------------------
describe("pipe: error clarity", () => {
  it("preserves the original error type", async () => {
    class CustomError extends Error {
      code = "CUSTOM";
    }
    try {
      await pipe(failingSource([], new CustomError("custom")), collect());
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err instanceof CustomError).toBe(true);
      expect(err.code).toEqual("CUSTOM");
    }
  });

  it("cleanup-only error surfaces when pipeline succeeds", async () => {
    const source: Source<number> = (async function* () {
      try {
        yield 1;
      } finally {
        throw new Error("cleanup boom");
      }
    })();
    await expect(() => pipe(source, consume)).rejects.toThrow("cleanup boom");
  });
});
