import type { Source } from "./types.js";

// ---------------------------------------------------------------------------
// channel() — push-to-pull bridge.
//
// Creates a paired [writer, source]. The writer pushes values in;
// the source yields them out. Each write() blocks until the consumer
// pulls the value. No buffer. No queue. One-in, one-out.
//
// This is the bridge between imperative push-based producers
// (callbacks, event emitters, format encoders) and Culvert's pull-based
// Source<T>. It exists because you can't `yield` across function
// boundaries in JavaScript — a generator can only yield from its own
// body, not from a callback running inside it.
//
// The backpressure guarantee: write() returns a promise that resolves
// only when the consumer has pulled the value. If the consumer isn't
// reading, the producer waits. If the producer isn't writing, the
// consumer waits. At any moment, at most one value is in flight.
//
//   import { channel } from "@culvert/stream";
//
//   const [writer, source] = channel<Uint8Array>();
//
//   // Producer (push side — e.g., inside createZip)
//   await writer.write(header);   // blocks until consumer pulls
//   await writer.write(chunk);    // blocks until consumer pulls
//   await writer.close();
//
//   // Consumer (pull side — e.g., new Response(toReadableStream(source)))
//   for await (const chunk of source) { ... }
//
// ---------------------------------------------------------------------------

/**
 * The push side of a channel. Write values in; they emerge from the
 * paired Source<T> when the consumer pulls.
 */
export interface ChannelWriter<T> {
  /** Push a value. Resolves when the consumer has pulled it. */
  write(value: T): Promise<void>;

  /** Signal that no more values will be pushed. */
  close(): Promise<void>;

  /** Signal an error to the consumer. The consumer's next pull rejects. */
  error(err: unknown): void;
}

/**
 * Create a push-to-pull bridge.
 *
 * Returns a [writer, source] pair. The writer pushes values; the source
 * yields them. Backpressure is structural — each write blocks until the
 * consumer pulls.
 */
export function channel<T>(): [ChannelWriter<T>, Source<T>] {
  // The state machine mediates between two participants:
  //
  // - The producer, calling write()/close()/error()
  // - The consumer, calling next() via for-await-of
  //
  // At any moment, either:
  //   1. The producer is waiting (wrote a value, consumer hasn't pulled)
  //   2. The consumer is waiting (pulled, producer hasn't written)
  //   3. Neither is waiting (idle)
  //
  // Both waiting simultaneously is impossible — that's the invariant.

  let done = false;
  let errorValue: unknown = undefined;
  let hasError = false;

  // Producer wrote before consumer pulled — producer is parked here.
  let pendingWrite: {
    value: T;
    resolve: () => void;
  } | null = null;

  // Consumer pulled before producer wrote — consumer is parked here.
  let pendingRead: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (err: unknown) => void;
  } | null = null;

  const writer: ChannelWriter<T> = {
    write(value: T): Promise<void> {
      if (done) {
        return Promise.reject(new Error("Cannot write to closed channel"));
      }

      // Is a consumer already waiting?
      if (pendingRead) {
        // Hand the value directly — zero buffering, zero delay.
        const reader = pendingRead;
        pendingRead = null;
        reader.resolve({ done: false, value });
        return Promise.resolve();
      }

      // No consumer waiting — park until one arrives.
      return new Promise<void>((resolve) => {
        pendingWrite = { value, resolve };
      });
    },

    close(): Promise<void> {
      done = true;

      // If a consumer is waiting, tell it we're done.
      if (pendingRead) {
        const reader = pendingRead;
        pendingRead = null;
        reader.resolve({ done: true, value: undefined });
      }

      return Promise.resolve();
    },

    error(err: unknown): void {
      hasError = true;
      errorValue = err;
      done = true;

      // If a consumer is waiting, reject it.
      if (pendingRead) {
        const reader = pendingRead;
        pendingRead = null;
        reader.reject(err);
      }

      // If a producer is parked in write(), unpark it — its value will
      // never be delivered, but stranding the producer forever is worse.
      // (Mirrors return()'s handling of a parked write.)
      if (pendingWrite) {
        const { resolve } = pendingWrite;
        pendingWrite = null;
        resolve();
      }
    },
  };

  const source: Source<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          // Error takes priority.
          if (hasError) {
            return Promise.reject(errorValue);
          }

          // Is a producer already waiting with a value?
          if (pendingWrite) {
            const { value, resolve } = pendingWrite;
            pendingWrite = null;
            resolve(); // unblock the producer
            return Promise.resolve({ done: false, value });
          }

          // Done and no pending write — stream is over.
          if (done) {
            return Promise.resolve({ done: true, value: undefined });
          }

          // No producer waiting — park until one arrives.
          return new Promise((resolve, reject) => {
            pendingRead = { resolve, reject };
          });
        },

        return(): Promise<IteratorResult<T>> {
          // Consumer is done early — signal the producer to stop.
          done = true;

          if (pendingWrite) {
            const { resolve } = pendingWrite;
            pendingWrite = null;
            resolve(); // unblock the producer (they'll see done=true)
          }

          // An in-flight next() must settle too — the async-iterator
          // protocol says a pending next resolves before return does,
          // and leaving it parked strands whoever awaits it.
          if (pendingRead) {
            const reader = pendingRead;
            pendingRead = null;
            reader.resolve({ done: true, value: undefined });
          }

          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  return [writer, source];
}
