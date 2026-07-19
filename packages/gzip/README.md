# @culvert/gzip

Streaming gzip framing. You bring DEFLATE.

```ts
import { gzip, gunzip } from "@culvert/gzip";
import { pipe } from "@culvert/stream";

await pipe(source, gzip(myDeflator), writeTo("output.gz"));
await pipe(readFile("output.gz"), gunzip(myInflator), writeTo("output"));
```

## Install

```sh
npm install @culvert/gzip
```

## Do you actually need this package?

Most people don't.

If you just need gzip compression or decompression and you're on Node, the platform already handles everything — including concatenated members as a non-spec extension. Wrap it with `@culvert/stream` and move on:

```ts
import { pipe, fromReadableStream, toReadableStream } from "@culvert/stream";

const compress = (source) =>
  fromReadableStream(
    toReadableStream(source).pipeThrough(new CompressionStream("gzip")),
  );

const decompress = (source) =>
  fromReadableStream(
    toReadableStream(source).pipeThrough(new DecompressionStream("gzip")),
  );
```

Ten lines. Platform-native. Zero dependencies. Covers 95% of use cases.

`@culvert/gzip` is for the other 5%:

- **Concatenated member support on non-Node runtimes.** `DecompressionStream("gzip")` in browsers, Cloudflare Workers, Deno, and Bun silently truncates after the first member. If you process log files, HTTP chunked responses, or anything produced by `cat a.gz b.gz`, the platform gives you partial data and no error.
- **CRC-32 policy control.** The platform's CRC behavior on mismatch is inconsistent across runtimes — sometimes it throws before yielding data, sometimes after. You can't recover data from a damaged stream. `@culvert/gzip` offers strict and permissive modes.
- **Consistent error taxonomy.** Platform errors are generic `TypeError` or `Error` with runtime-specific messages. `@culvert/gzip` throws `GzipCorruptionError` with clear descriptions — same taxonomy as `@culvert/zip` and `@culvert/tar`.
- **Header metadata access.** The platform doesn't expose FNAME, FCOMMENT, MTIME, or other header fields. If you need them, you need to parse the header yourself, and this package does that.

If none of those apply, use the platform. Seriously.

## Codec interface

`@culvert/gzip` is gzip **framing**. It owns everything around the DEFLATE payload — header parsing, header building, CRC-32 verification via `@culvert/crc32`, ISIZE validation, concatenated member looping, corruption policy, error taxonomy, abort support. The DEFLATE itself is your problem. You inject a codec; we give you a `Transform`.

### Inflator

```ts
interface InflateResult {
  output: Uint8Array;   // decompressed bytes (may be empty)
  consumed: number;     // input bytes consumed from this chunk
  done: boolean;        // BFINAL seen — DEFLATE stream complete
}

interface Inflator {
  inflate(chunk: Uint8Array): InflateResult;
  reset(): void;
}
```

`consumed` is the key field. It tells the framing layer exactly where the DEFLATE stream ends and the 8-byte footer begins. Without it, concatenated members and streaming CRC verification are impossible.

### Deflator

```ts
interface Deflator {
  deflate(chunk: Uint8Array, final: boolean): Uint8Array;
}
```

Simpler than the inflator — no boundary detection needed. `final: true` signals the DEFLATE stream to flush and emit the BFINAL block.

### Wrapping pako

Pako exposes the zlib `strm.avail_in` field, which is exactly the consumed byte count:

```ts
import Pako from "pako";
import type { Inflator, Deflator } from "@culvert/gzip";

function pakoInflator(): Inflator {
  let inf = new Pako.Inflate({ raw: true });
  return {
    inflate(chunk) {
      inf.push(chunk);
      const consumed = chunk.length - inf.strm.avail_in;
      const output = inf.result ?? new Uint8Array(0);
      return { output, consumed, done: inf.ended };
    },
    reset() {
      inf = new Pako.Inflate({ raw: true });
    },
  };
}

function pakoDeflator(): Deflator {
  const def = new Pako.Deflate({ raw: true });
  return {
    deflate(chunk, final) {
      def.push(chunk, final);
      return def.result ?? new Uint8Array(0);
    },
  };
}
```

Twelve lines. Copy it and move on.

## Compress

```ts
import { gzip } from "@culvert/gzip";

await pipe(source, gzip(myDeflator), writeTo("data.json.gz"));
```

With options:

```ts
await pipe(
  source,
  gzip(myDeflator, {
    filename: "data.json",        // stored in gzip header (FNAME)
    mtime: new Date(),            // stored in gzip header; defaults to epoch
    comment: "nightly export",    // stored in gzip header (FCOMMENT)
    signal: AbortSignal.timeout(5000),
  }),
  writeTo("data.json.gz"),
);
```

`mtime` defaults to Unix epoch (`new Date(0)`) for reproducible output. Two compressions of the same input with the same deflator and options produce byte-identical gzip.

## Decompress

```ts
import { gunzip } from "@culvert/gzip";

await pipe(readFile("data.json.gz"), gunzip(myInflator), writeTo("data.json"));
```

With abort:

```ts
await pipe(compressedSource, gunzip(myInflator, { signal }), writeTo("output"));
```

## Concatenated members

RFC 1952 §2.2 explicitly allows multiple gzip members in a single stream. This package handles them on every runtime — not just Node.

```ts
// Works on browsers, Cloudflare Workers, Deno, Bun
await pipe(
  readFile("combined.gz"), // cat a.gz b.gz > combined.gz
  gunzip(myInflator),
  writeTo("combined.txt"),
);
```

Log rotation pipelines, HTTP chunked responses, and `cat`-produced archives all decompress correctly. The platform does not.

## Compose with tar

```ts
import { createTar, EPOCH } from "@culvert/tar";
import { gzip } from "@culvert/gzip";

await pipe(
  createTar(async (tar) => {
    await tar.addFile({
      name: "report.csv",
      source,
      size,
      lastModified: EPOCH,
    });
  }),
  gzip(myDeflator),
  writeTo("archive.tar.gz"),
);
```

## CRC policy

`strict` (default) throws `GzipCorruptionError` on CRC-32 or ISIZE mismatch. `permissive` ignores mismatches and yields the decompressed data anyway — useful for recovering data from damaged streams.

```ts
await pipe(
  damagedSource,
  gunzip(myInflator, { crcPolicy: "permissive" }),
  writeTo("recovered.txt"),
);
```

## Errors

Two named error classes, same taxonomy as `@culvert/zip` and `@culvert/tar`:

- **`GzipCorruptionError`** — the gzip stream is malformed or corrupt. Covers: bad magic bytes, unsupported compression method, reserved FLG bits, CRC-32 mismatch (strict mode), ISIZE mismatch (strict mode), truncated header, truncated footer, truncated compressed data, invalid DEFLATE data (if the codec throws).
- **`GzipAbortError`** — an `AbortSignal` fired. The operation was cancelled.

```ts
import { GzipCorruptionError, GzipAbortError } from "@culvert/gzip";

try {
  await pipe(source, gunzip(myInflator), collectBytes());
} catch (err) {
  if (err instanceof GzipCorruptionError) {
    // bad magic, bad CRC, truncated stream, invalid DEFLATE
  }
  if (err instanceof GzipAbortError) {
    // AbortSignal fired
  }
}
```

## API surface

Four runtime exports:

```ts
gzip(deflator, options?)    → Transform<Uint8Array, Uint8Array>
gunzip(inflator, options?)  → Transform<Uint8Array, Uint8Array>
GzipCorruptionError
GzipAbortError
```

Five type exports (for implementors):

```ts
Inflator
InflateResult
Deflator
GzipOptions
GunzipOptions
```

That's the whole package.

## Related packages

```
@culvert/gzip
├── @culvert/stream   (pipe, Source, Transform)
└── @culvert/crc32    (CRC-32 for footer verification)
```

Two Culvert dependencies. Zero external dependencies. No platform DEFLATE dependency — the user provides it via the codec interface.

```
stream
├── crc32          (leaf — no culvert deps)
├── zip            (stream + crc32)
├── tar            (stream)
├── gzip           ← you are here  (stream + crc32)
├── csv            (stream — not yet)
└── archive        (stream + zip + tar — not yet)
```

## License

MIT. See [LICENSE](./LICENSE).
