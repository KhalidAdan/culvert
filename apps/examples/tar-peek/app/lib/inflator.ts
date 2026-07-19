import Pako from "pako";
import type { Inflator } from "@culvert/gzip";

/**
 * Pako-backed raw DEFLATE codec for @culvert/gzip's BYOC interface.
 * Straight from the @culvert/gzip README: pako exposes zlib's
 * `strm.avail_in`, which is exactly the consumed-byte count the
 * framing layer needs to find the member boundary.
 *
 * @types/pako doesn't declare `strm` or `ended`, but both exist at
 * runtime on every pako 2.x Inflate instance.
 */
interface PakoInflateLike {
  push(data: Uint8Array | ArrayBuffer): boolean;
  result: Uint8Array | undefined;
  ended: boolean;
  strm: { avail_in: number };
}

export function pakoInflator(): Inflator {
  let inf = new Pako.Inflate({ raw: true }) as unknown as PakoInflateLike;
  return {
    inflate(chunk) {
      inf.push(chunk);
      const consumed = chunk.length - inf.strm.avail_in;
      const output = inf.result ?? new Uint8Array(0);
      return { output, consumed, done: inf.ended };
    },
    reset() {
      inf = new Pako.Inflate({ raw: true }) as unknown as PakoInflateLike;
    },
  };
}
