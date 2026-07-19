// ---------------------------------------------------------------------------
// ByteReader — exact-byte-count reads from a chunked async source.
//
// Internal to @culvert/gzip. Not exported.
//
// The key method is pushBack(): after the codec says "I consumed N
// of your M bytes," the framing layer pushes the remaining M-N bytes
// back into the reader. The next read starts from those bytes.
// ---------------------------------------------------------------------------

import { GzipCorruptionError } from "./errors.js";

export interface ByteReader {
  /** Pull the next chunk. Returns null at EOF. */
  pull(): Promise<Uint8Array | null>;
  /** Read exactly `n` bytes, spanning chunks if needed. */
  readExact(n: number): Promise<Uint8Array>;
  /** Peek at the next `n` bytes without consuming. Returns null if EOF. */
  peekBytes(n: number): Promise<Uint8Array | null>;
  /** Return unconsumed bytes to the front of the stream. */
  pushBack(chunk: Uint8Array): void;
}

export function createByteReader(
  source: AsyncIterable<Uint8Array>,
): ByteReader {
  const iter = source[Symbol.asyncIterator]();
  let buffer: Uint8Array | null = null;
  let bufferOffset = 0;

  // Stack of pushed-back chunks (LIFO — last pushBack is read first)
  const pushBackStack: Uint8Array[] = [];

  async function pullRaw(): Promise<Uint8Array | null> {
    // Drain pushback stack first
    if (pushBackStack.length > 0) {
      return pushBackStack.pop()!;
    }

    // Then drain current buffer
    if (buffer !== null && bufferOffset < buffer.length) {
      const remaining = buffer.subarray(bufferOffset);
      buffer = null;
      bufferOffset = 0;
      return remaining;
    }

    // Then pull from source
    buffer = null;
    bufferOffset = 0;
    const result = await iter.next();
    if (result.done) return null;
    return result.value;
  }

  async function pull(): Promise<Uint8Array | null> {
    const chunk = await pullRaw();
    if (chunk === null) return null;
    if (chunk.length === 0) return pull(); // skip empty chunks
    return chunk;
  }

  async function readExact(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0);

    const parts: Uint8Array[] = [];
    let remaining = n;

    while (remaining > 0) {
      const chunk = await pull();
      if (chunk === null) {
        throw new GzipCorruptionError(
          `Unexpected end of gzip stream: needed ${remaining} more bytes`,
        );
      }

      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        // Take what we need, push back the rest
        parts.push(chunk.subarray(0, remaining));
        pushBackStack.push(chunk.subarray(remaining));
        remaining = 0;
      }
    }

    // Fast path: single chunk, no copy needed
    if (parts.length === 1) return parts[0]!;

    // Concat
    const result = new Uint8Array(n);
    let offset = 0;
    for (const p of parts) {
      result.set(p, offset);
      offset += p.length;
    }
    return result;
  }

  async function peekBytes(n: number): Promise<Uint8Array | null> {
    try {
      const bytes = await readExact(n);
      pushBackStack.push(bytes);
      return bytes;
    } catch {
      // EOF before n bytes — not an error for peek, just means no data
      return null;
    }
  }

  function pushBack(chunk: Uint8Array): void {
    if (chunk.length > 0) {
      pushBackStack.push(chunk);
    }
  }

  return { pull, readExact, peekBytes, pushBack };
}
