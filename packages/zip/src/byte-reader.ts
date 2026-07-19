import type { Source } from "@culvert/stream";
import { ZipCorruptionError } from "./errors.js";

// ---------------------------------------------------------------------------
// StreamingByteReader
//
// Reads structured binary data from a Source<Uint8Array>. Handles the
// fundamental mismatch between "I need exactly N bytes" and "chunks
// arrive in arbitrary sizes."
//
// Maintains an internal buffer of unconsumed bytes. When a read request
// exceeds the buffer, it pulls more chunks from the source until
// satisfied or the source ends.
// ---------------------------------------------------------------------------

export class StreamingByteReader {
  private iterator: AsyncIterator<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(source: Source<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Fill the internal buffer until it has at least `n` bytes. */
  private async fill(n: number): Promise<boolean> {
    while (this.buffer.length < n) {
      if (this.done) return false;

      const { done, value } = await this.iterator.next();
      if (done) {
        this.done = true;
        return this.buffer.length >= n;
      }

      // Append to buffer
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
    return true;
  }

  /** Consume the buffer: return the first `n` bytes and advance. */
  private consume(n: number): Uint8Array {
    const result = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return result;
  }

  /** Read exactly `n` bytes. Throws ZipCorruptionError on truncation. */
  async readBytes(n: number): Promise<Uint8Array> {
    const ok = await this.fill(n);
    if (!ok) {
      throw new ZipCorruptionError(
        `Unexpected end of archive: needed ${n} bytes, have ${this.buffer.length}`,
      );
    }
    return this.consume(n);
  }

  /** Read a Uint16LE from the stream. */
  async readUint16LE(): Promise<number> {
    const bytes = await this.readBytes(2);
    return bytes[0]! | (bytes[1]! << 8);
  }

  /** Read a Uint32LE from the stream. */
  async readUint32LE(): Promise<number> {
    const bytes = await this.readBytes(4);
    return (
      (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>>
      0
    );
  }

  /** Peek at the next 4 bytes without consuming. Returns null if not enough data. */
  async peekUint32LE(): Promise<number | null> {
    const ok = await this.fill(4);
    if (!ok) return null;
    const b = this.buffer;
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  /**
   * Yield exactly `n` bytes as a Source<Uint8Array>, pulling from the
   * underlying source as needed. Used to stream file data without
   * buffering it all.
   */
  readBytesAsSource(n: number): Source<Uint8Array> {
    let remaining = n;
    const self = this;

    return (async function* () {
      while (remaining > 0) {
        // Use whatever's in the buffer first
        if (self.buffer.length > 0) {
          const take = Math.min(self.buffer.length, remaining);
          const chunk = self.consume(take);
          remaining -= chunk.length;
          yield chunk;
        } else if (self.done) {
          throw new ZipCorruptionError(
            `Unexpected end of archive: needed ${remaining} more bytes of file data`,
          );
        } else {
          // Pull one chunk directly from the source
          const { done, value } = await self.iterator.next();
          if (done) {
            self.done = true;
            throw new ZipCorruptionError(
              `Unexpected end of archive: needed ${remaining} more bytes of file data`,
            );
          }
          // If chunk is larger than what we need, consume partially
          if (value.length <= remaining) {
            remaining -= value.length;
            yield value;
          } else {
            yield value.slice(0, remaining);
            // Put the rest back in the buffer
            self.buffer = value.slice(remaining);
            remaining = 0;
          }
        }
      }
    })();
  }

  /** Returns true if there's more data available. */
  async hasMoreData(): Promise<boolean> {
    if (this.buffer.length > 0) return true;
    if (this.done) return false;
    return await this.fill(1);
  }

  /** Clean up the underlying iterator. */
  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}
