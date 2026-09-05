import type { Transform } from "@culvert/stream";
import { ZipCorruptionError } from "./errors.js";

// ---------------------------------------------------------------------------
// deflateRaw() — platform-provided raw deflate as a Transform.
//
// Uses CompressionStream("deflate-raw") which is available in:
//   - All modern browsers (Chrome 80+, Firefox 113+, Safari 16.4+)
//   - Node.js 18+ (via web streams compat)
//   - Deno, Bun, Cloudflare Workers
//
// The "raw" variant is what ZIP needs — no zlib header, no gzip wrapper.
// If the platform doesn't support "deflate-raw", the caller should use
// the BYOC escape hatch with a custom transform.
//
// Teardown note: when the consumer stops early, the background pump is
// likely parked in writer.write() against a full readable queue. The
// readable must be CANCELLED (which errors the writable and unparks the
// pump) — releasing the lock and awaiting the pump deadlocks forever.
// ---------------------------------------------------------------------------

// Structural writer type: the platform types CompressionStream's writer
// as BufferSource, which Uint8Array satisfies at runtime but TypeScript's
// ArrayBufferLike variance rejects.
interface ByteWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

function pumpInto(
  source: AsyncIterable<Uint8Array>,
  writer: ByteWriter,
  onError: (err: unknown) => void,
): Promise<void> {
  return (async () => {
    try {
      for await (const chunk of source) {
        await writer.write(chunk);
      }
      await writer.close();
    } catch (err) {
      onError(err);
      try {
        await writer.abort(err);
      } catch {
        // Stream may already be errored; the original error wins.
      }
    }
  })();
}

export function deflateRaw(): Transform<Uint8Array, Uint8Array> {
  return async function* (source) {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    let pumpError: { err: unknown } | null = null;
    const pump = pumpInto(source, writer as unknown as ByteWriter, (err) => {
      pumpError = { err };
    });

    let finished = false;
    try {
      while (true) {
        let result: { done: boolean; value?: Uint8Array };
        try {
          result = await reader.read();
        } catch (err) {
          // The pump's failure is the source's own error — surface that.
          throw pumpError !== null ? (pumpError as { err: unknown }).err : err;
        }
        if (result.done) break;
        yield result.value!;
      }
      finished = true;
    } finally {
      if (!finished) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation failures don't outrank the original exit reason.
        }
      } else {
        reader.releaseLock();
      }
      await pump;
    }
  };
}

// ---------------------------------------------------------------------------
// inflateRaw() — platform-provided raw inflate as a Transform.
//
// A decompressor rejecting its input is archive corruption: the platform
// error (an engine-specific TypeError) is wrapped in ZipCorruptionError
// so callers can catch the taxonomy the README promises. Errors from the
// source itself pass through unwrapped.
// ---------------------------------------------------------------------------

export function inflateRaw(): Transform<Uint8Array, Uint8Array> {
  return async function* (source) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    let pumpError: { err: unknown } | null = null;
    const pump = pumpInto(source, writer as unknown as ByteWriter, (err) => {
      pumpError = { err };
    });

    let finished = false;
    try {
      while (true) {
        let result: { done: boolean; value?: Uint8Array };
        try {
          result = await reader.read();
        } catch (err) {
          if (pumpError !== null) throw (pumpError as { err: unknown }).err;
          throw new ZipCorruptionError(
            `DEFLATE data is corrupt: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (result.done) break;
        yield result.value!;
      }
      finished = true;
    } finally {
      if (!finished) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation failures don't outrank the original exit reason.
        }
      } else {
        reader.releaseLock();
      }
      await pump;
    }
  };
}

// ---------------------------------------------------------------------------
// identityTransform() — passthrough for "store" compression.
// ---------------------------------------------------------------------------

export function identityTransform(): Transform<Uint8Array, Uint8Array> {
  return async function* (source) {
    for await (const chunk of source) {
      yield chunk;
    }
  };
}
