import { describe, expect, it } from "vitest";
import { channel } from "../src/channel.js";
import { tap } from "../src/operators.js";
import { pipe } from "../src/pipe.js";
import { collect } from "../src/sinks.js";
import type { Sink, Source } from "../src/types.js";

// Simple sink that consumes everything and returns void
const consume: Sink<unknown> = async (source) => {
  for await (const _ of source) { /* drain */ }
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Basic operation
// ---------------------------------------------------------------------------
describe("channel: basic operation", () => {
  it("single write and read", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.write(42);
      await writer.close();
    })();

    const result = await pipe(source, collect());
    expect(result).toStrictEqual([42]);
  });

  it("multiple writes arrive in order", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.write(1);
      await writer.write(2);
      await writer.write(3);
      await writer.close();
    })();

    const result = await pipe(source, collect());
    expect(result).toStrictEqual([1, 2, 3]);
  });

  it("close with no writes produces empty stream", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.close();
    })();

    const result = await pipe(source, collect());
    expect(result).toStrictEqual([]);
  });

  it("works with Uint8Array (the ZIP use case)", async () => {
    const [writer, source] = channel<Uint8Array>();

    (async () => {
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array([4, 5]));
      await writer.close();
    })();

    const chunks: Uint8Array[] = [];
    for await (const chunk of source) {
      chunks.push(chunk);
    }

    expect(chunks.length).toEqual(2);
    expect(chunks[0]).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(chunks[1]).toStrictEqual(new Uint8Array([4, 5]));
  });
});

// ---------------------------------------------------------------------------
// Backpressure
// ---------------------------------------------------------------------------
describe("channel: backpressure", () => {
  it("write blocks until consumer pulls", async () => {
    const [writer, source] = channel<number>();
    const events: string[] = [];

    (async () => {
      events.push("write-1-start");
      await writer.write(1);
      events.push("write-1-done");

      events.push("write-2-start");
      await writer.write(2);
      events.push("write-2-done");

      await writer.close();
    })();

    for await (const n of source) {
      events.push(`read-${n}`);
      await delay(20);
    }

    // When the consumer is already waiting (pendingRead), write() resolves
    // immediately — the handoff is synchronous. The real backpressure proof:
    // write-2 can START (the producer calls write(2)), but it can't FINISH
    // until the consumer processes item 1 and pulls again.
    const write2Done = events.indexOf("write-2-done");
    const read1 = events.indexOf("read-1");
    expect(write2Done).toBeGreaterThan(read1);
  });

  it("slow consumer causes producer to wait, not buffer", async () => {
    const [writer, source] = channel<number>();
    const start = Date.now();
    const producerTimestamps: number[] = [];

    (async () => {
      for (let i = 0; i < 5; i++) {
        await writer.write(i);
        producerTimestamps.push(Date.now() - start);
      }
      await writer.close();
    })();

    for await (const _ of source) {
      await delay(30);
    }

    const spread =
      producerTimestamps[producerTimestamps.length - 1]! -
      producerTimestamps[0]!;
    expect(spread).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------------------
// Consumer stops early
// ---------------------------------------------------------------------------
describe("channel: early termination", () => {
  it("break in for-await stops the producer", async () => {
    const [writer, source] = channel<number>();
    let producerWrites = 0;

    (async () => {
      try {
        for (let i = 0; i < 100; i++) {
          await writer.write(i);
          producerWrites++;
        }
      } catch {
        // write may reject after channel closes
      }
      await writer.close();
    })();

    let consumed = 0;
    for await (const _ of source) {
      consumed++;
      if (consumed >= 3) break;
    }

    await delay(10);

    expect(consumed).toEqual(3);
    expect(producerWrites).toBeLessThan(10);
  });

  it("pipe teardown closes the channel", async () => {
    const [writer, source] = channel<number>();
    let producerFinished = false;

    (async () => {
      try {
        for (let i = 0; i < 100; i++) {
          await writer.write(i);
        }
      } catch {
        // expected
      }
      producerFinished = true;
    })();

    const takeOne: Sink<number, number> = async (src) => {
      for await (const n of src) return n;
      return -1;
    };

    const result = await pipe(source, takeOne);
    expect(result).toEqual(0);

    await delay(10);
    expect(producerFinished).toEqual(true);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------
describe("channel: errors", () => {
  it("writer.error rejects the consumer", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.write(1);
      writer.error(new Error("producer failed"));
    })();

    await expect(async () => {
      for await (const _ of source) {
      }
    }).rejects.toThrow("producer failed");
  });

  it("writer.error while consumer is waiting rejects immediately", async () => {
    const [writer, source] = channel<number>();

    setTimeout(() => {
      writer.error(new Error("delayed failure"));
    }, 20);

    await expect(async () => {
      for await (const _ of source) {
      }
    }).rejects.toThrow("delayed failure");
  });

  it("write after close rejects", async () => {
    const [writer] = channel<number>();
    await writer.close();
    await expect(async () => {
      await writer.write(1);
    }).rejects.toThrow("Cannot write to closed channel");
  });

  it("error propagates through pipe", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.write(1);
      await writer.write(2);
      writer.error(new Error("mid-stream failure"));
    })();

    const items: number[] = [];
    await expect(async () => {
      await pipe(
        source,
        tap((n) => {
          items.push(n);
        }),
        consume,
      );
    }).rejects.toThrow("mid-stream failure");

    expect(items).toStrictEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Composability with pipe
// ---------------------------------------------------------------------------
describe("channel: pipe composability", () => {
  it("channel source works with transforms", async () => {
    const [writer, source] = channel<number>();

    (async () => {
      await writer.write(1);
      await writer.write(2);
      await writer.write(3);
      await writer.close();
    })();

    const double = async function* (src: Source<number>) {
      for await (const n of src) {
        yield n * 2;
      }
    };

    const result = await pipe(source, double, collect());
    expect(result).toStrictEqual([2, 4, 6]);
  });

  it("the createZip pattern: callback pushes, consumer pulls", async () => {
    function createFakeZip(
      callback: (
        addChunk: (data: Uint8Array) => Promise<void>,
      ) => Promise<void>,
    ): Source<Uint8Array> {
      const [writer, source] = channel<Uint8Array>();

      (async () => {
        try {
          await callback((data) => writer.write(data));
          await writer.close();
        } catch (err) {
          writer.error(err);
        }
      })();

      return source;
    }

    const encode = (s: string) => new TextEncoder().encode(s);

    const zip = createFakeZip(async (addChunk) => {
      await addChunk(encode("[HEADER:a.txt]"));
      await addChunk(encode("file-a-data"));
      await addChunk(encode("[HEADER:b.txt]"));
      await addChunk(encode("file-b-data"));
      await addChunk(encode("[CENTRAL_DIR]"));
    });

    const decoder = new TextDecoder();
    const parts: string[] = [];

    for await (const chunk of zip) {
      parts.push(decoder.decode(chunk));
    }

    expect(parts).toStrictEqual([
      "[HEADER:a.txt]",
      "file-a-data",
      "[HEADER:b.txt]",
      "file-b-data",
      "[CENTRAL_DIR]",
    ]);
  });

  it("nested pipe through channel preserves backpressure", async () => {
    const [writer, source] = channel<Uint8Array>();

    (async () => {
      try {
        const fileData = [
          new Uint8Array([1, 2, 3]),
          new Uint8Array([4, 5, 6]),
          new Uint8Array([7, 8, 9]),
        ];

        const writeTo: Sink<Uint8Array> = async (src) => {
          for await (const chunk of src) {
            await writer.write(chunk);
          }
        };

        let totalSize = 0;
        await pipe(
          (async function* () {
            for (const d of fileData) yield d;
          })(),
          tap((chunk) => {
            totalSize += chunk.length;
          }),
          writeTo,
        );

        expect(totalSize).toBe(9);
        await writer.close();
      } catch (err) {
        writer.error(err);
      }
    })();

    const result = await pipe(source, collect());
    expect(result.length).toBe(3);
    expect(result[0]).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(result[2]).toStrictEqual(new Uint8Array([7, 8, 9]));
  });
});
