import { describe, it, expect, vi } from "vitest";
import { pipe } from "./pipe.js";
import { abortable, buffer, flatMap } from "./operators.js";
import { collect } from "./sinks.js";
import { channel } from "./channel.js";
import { fromReadableStream } from "./bridge.js";
import type { Source } from "./types.js";

// ---------------------------------------------------------------------------
// Regression suite for the teardown/early-termination bug cluster found in
// the 2026-09-05 deep review. Every test here hung or dangled forever
// before the fixes. Each carries a watchdog timeout so a regression fails
// fast instead of hanging the suite.
// ---------------------------------------------------------------------------

/** A source that yields the given items, then parks forever (idle). */
function idleAfter<T>(items: T[]): Source<T> {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (i < items.length) {
            return Promise.resolve({ done: false, value: items[i++]! });
          }
          return new Promise(() => {}); // parked forever
        },
        return(): Promise<IteratorResult<T>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

describe("channel teardown", () => {
  it("return() settles a parked next() with done", { timeout: 2000 }, async () => {
    const [, source] = channel<number>();
    const it = source[Symbol.asyncIterator]();

    const parked = it.next(); // producer is quiet — this parks
    await it.return!();

    const result = await parked;
    expect(result.done).toBe(true);
  });

  it("error() unparks a parked write()", { timeout: 2000 }, async () => {
    const [writer, source] = channel<number>();

    const parkedWrite = writer.write(1); // no consumer — parks
    writer.error(new Error("boom"));

    // The parked write must settle so the producer isn't stranded.
    await parkedWrite;

    // And the consumer sees the error.
    const it = source[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow("boom");
  });
});

describe("buffer teardown", () => {
  it(
    "early consumer break with a full suspend buffer terminates",
    { timeout: 2000 },
    async () => {
      // Fast source fills the buffer; producer parks on the suspend
      // promise; consumer takes one item and breaks. Before the fix the
      // generator's finally awaited producerDone forever.
      async function* fast(): AsyncGenerator<number> {
        for (let i = 0; i < 100; i++) yield i;
      }

      const buffered = buffer<number>(4, "suspend")(fast());
      const seen: number[] = [];
      for await (const item of buffered) {
        seen.push(item);
        // Give the producer time to refill the buffer and park on the
        // suspend promise before we break — that's the hang scenario.
        await new Promise((r) => setTimeout(r, 20));
        if (seen.length === 2) break;
      }
      expect(seen).toEqual([0, 1]);
    },
  );

  it("downstream error settles the pipeline", { timeout: 2000 }, async () => {
    async function* fast(): AsyncGenerator<number> {
      for (let i = 0; i < 100; i++) yield i;
    }
    await expect(
      pipe(fast(), buffer(2, "suspend"), async (source: Source<number>) => {
        for await (const item of source) {
          await new Promise((r) => setTimeout(r, 20)); // let producer park
          if (item === 1) throw new Error("sink failure");
        }
      }),
    ).rejects.toThrow("sink failure");
  });
});

describe("abortable responsiveness", () => {
  it("abort interrupts a pull parked on an idle source", { timeout: 2000 }, async () => {
    const controller = new AbortController();

    const consumed = pipe(
      abortable(idleAfter([1, 2]), controller.signal),
      collect(),
    );

    // Let the two items flow, then abort while the source is parked.
    setTimeout(() => controller.abort(), 50);

    // Before the fix this promise never settled.
    const result = await consumed;
    expect(result).toEqual([1, 2]);
  });

  it("abort on a channel source with a quiet producer unblocks", { timeout: 2000 }, async () => {
    const controller = new AbortController();
    const [, source] = channel<number>();

    setTimeout(() => controller.abort(), 20);
    const result = await pipe(abortable(source, controller.signal), collect());
    expect(result).toEqual([]);
  });
});

describe("flatMap liveness", () => {
  it(
    "ready inner values flow while the outer source is slow",
    { timeout: 2000 },
    async () => {
      // Outer yields two items then parks forever. Inner "a" completes
      // immediately (opening a slot); inner "b" has values ready. Before
      // the fix, the freed slot's blocking outer pull starved b's values.
      async function* inner(name: string): AsyncGenerator<string> {
        if (name === "a") return; // completes with no values
        yield `${name}1`;
        yield `${name}2`;
      }

      const out = flatMap((name: string) => inner(name), { concurrency: 2 })(
        idleAfter(["a", "b"]),
      );

      const seen: string[] = [];
      for await (const value of out) {
        seen.push(value);
        if (seen.length === 2) break;
      }
      expect(seen).toEqual(["b1", "b2"]);
    },
  );
});

describe("fromReadableStream fallback teardown", () => {
  it(
    "cancels the underlying stream when the consumer stops early",
    { timeout: 2000 },
    async () => {
      const cancel = vi.fn(() => Promise.resolve());
      let reads = 0;
      // A mock without Symbol.asyncIterator, forcing the Safari fallback.
      const fakeStream = {
        getReader() {
          return {
            read: () => Promise.resolve({ done: false, value: reads++ }),
            cancel,
            releaseLock: () => {},
          };
        },
      } as unknown as ReadableStream<number>;

      const source = fromReadableStream(fakeStream);
      for await (const value of source) {
        if (value >= 1) break;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});
