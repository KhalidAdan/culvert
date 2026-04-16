import { describe, expect, it } from "vitest";
import { fromReadableStream, toReadableStream } from "./bridge.js";
import { tap } from "./operators.js";
import { pipe } from "./pipe.js";
import { collect, collectBytes } from "./sinks.js";
import { from } from "./sources.js";

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------
describe("collect", () => {
  it("gathers all items into an array", async () => {
    const result = await pipe(from([1, 2, 3]), collect());
    expect(result).toStrictEqual([1, 2, 3]);
  });
});

describe("collectBytes", () => {
  it("concatenates Uint8Arrays into one", async () => {
    const chunks = [
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    ];
    const result = await pipe(from(chunks), collectBytes());
    expect(result).toStrictEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(result.length).toEqual(6);
  });

  it("handles empty input", async () => {
    const result = await pipe(from([]), collectBytes());
    expect(result).toStrictEqual(new Uint8Array(0));
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------
describe("toReadableStream", () => {
  it("wraps a Source as a ReadableStream", async () => {
    const readable = toReadableStream(from([1, 2, 3]));
    const reader = readable.getReader();
    const items: number[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      items.push(value);
    }
    expect(items).toStrictEqual([1, 2, 3]);
  });

  it("cancel calls iterator.return()", async () => {
    let returned = false;
    const source = (async function* () {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        returned = true;
      }
    })();
    const readable = toReadableStream(source);
    const reader = readable.getReader();
    await reader.read();
    await reader.cancel();
    expect(returned).toEqual(true);
  });
});

describe("fromReadableStream", () => {
  it("wraps a ReadableStream as a Source", async () => {
    const readable = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });
    const result = await pipe(fromReadableStream(readable), collect());
    expect(result).toStrictEqual([1, 2, 3]);
  });
});

describe("bridge round-trip", () => {
  it("data survives Source → ReadableStream → Source", async () => {
    const original = [10, 20, 30];
    const readable = toReadableStream(from(original));
    const result = await pipe(fromReadableStream(readable), collect());
    expect(result).toStrictEqual(original);
  });

  it("transforms work on bridged streams", async () => {
    const readable = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.enqueue(2);
        controller.enqueue(3);
        controller.close();
      },
    });
    const observed: number[] = [];
    const result = await pipe(
      fromReadableStream(readable),
      tap((n) => {
        observed.push(n);
      }),
      collect(),
    );
    expect(result).toStrictEqual([1, 2, 3]);
    expect(observed).toStrictEqual([1, 2, 3]);
  });
});
