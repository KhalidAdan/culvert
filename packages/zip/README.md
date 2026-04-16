# @culvert/zip

Streaming ZIP writer and reader. Constant memory. Predictable
backpressure. Works in Node, Deno, Bun, Cloudflare Workers, and
browsers.

## Install

```sh
npm install @culvert/zip
```

## Writing

```ts
import { createZip } from "@culvert/zip";
import { toReadableStream } from "@culvert/stream";

const zip = createZip(async (archive) => {
  await archive.addFile({
    name: "report.csv",
    source: fetchReportRows(),     // any Source<Uint8Array>
  });

  await archive.addFile({
    name: "photo.jpg",
    source: readFileAsStream("./photo.jpg"),
    compression: "store",          // already compressed
  });
});

// Hand it to any Web Streams consumer
return new Response(toReadableStream(zip), {
  headers: { "Content-Type": "application/zip" },
});
```

The callback pattern guarantees the central directory is written after
your last `addFile`. No `close()` to forget. Errors inside the callback
propagate through the pipeline and reject the archive source.

### Compression

`compression: "deflate"` (default) uses platform `CompressionStream`.
`compression: "store"` is zero-overhead passthrough — ideal for
pre-compressed data (JPEG, MP4, M4B).

### BYOC — Bring Your Own Compressor

```ts
await archive.addFile({
  name: "data.bin",
  source,
  compress: myBrotliTransform(),   // Transform<Uint8Array, Uint8Array>
  compressionMethod: 99,           // ZIP method number
});
```

### Cancellation

Per-file and per-archive `AbortSignal` both supported:

```ts
const zip = createZip(
  async (archive) => {
    await archive.addFile({ name: "slow.csv", source, signal: perFileSignal });
  },
  { signal: archiveSignal },
);
```

## Reading

Two readers for two I/O models. Pick the one that matches your input.

### Forward-only: `readZipEntries`

For inputs you can't seek (fetch bodies, pipes, stdin):

```ts
import { readZipEntries } from "@culvert/zip";
import { pipe, collectBytes } from "@culvert/stream";

for await (const entry of readZipEntries(zipSource)) {
  console.log(entry.name);
  const data = await pipe(entry.source, collectBytes());
  // entry.compressedSize, entry.uncompressedSize, entry.crc32
  // are available after the source is consumed.
}
```

CRC-32 is verified automatically. Skipping an entry silently drains
it — skipping isn't free, it's consumption by another name.

### Random-access: `openZip`

For seekable inputs (Blob, File, fs.FileHandle):

```ts
import { openZip, fromBlob } from "@culvert/zip";
import { pipe, collectBytes } from "@culvert/stream";

// Browser: from a File or Blob
const archive = await openZip(fromBlob(file));

console.log(archive.entries);            // all metadata, no I/O
const entry = archive.entry("page-437.jpg");
const data = await pipe(archive.source(entry), collectBytes());

await archive.close();
```

Two seeks to open: one to find the EOCD, one for the central directory.
Then each file is one header read plus chunked data reads. No scanning,
no buffering.

### Node.js seekable

```ts
import { open } from "node:fs/promises";
import type { ZipSeekable } from "@culvert/zip";

const handle = await open("archive.zip");
const stat = await handle.stat();

const seekable: ZipSeekable = {
  size: stat.size,
  read: async (offset, length) => {
    const buf = new Uint8Array(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  },
  close: () => handle.close(),
};

const archive = await openZip(seekable);
```

## ZIP64

Supported in both the writer and the random-access reader. The writer
automatically emits ZIP64 structures when any value exceeds 32-bit
limits (file > 4 GiB, archive > 4 GiB, or > 65,534 entries). The
random-access reader transparently handles ZIP64 extra fields and the
ZIP64 EOCD record.

Practical ceiling: **2^53 bytes (≈ 8 PiB) per field**, the JavaScript
Number.MAX_SAFE_INTEGER. Beyond that, reads throw
`ZipCorruptionError`. If you have a ≥ 8 PiB ZIP archive, please get in
touch.

The forward reader does not support ZIP64. Use `openZip` for large
archives.

## What's not included

- **Encryption.** ZIP's legacy crypto is broken; WinZip/AES is nonstandard
  and minefield-adjacent. If you need it, use a dedicated
  security-reviewed package. Never shipping in this package.
- **Data descriptors (writer).** The writer uses collect-then-write
  (compress to memory, then emit header + data). This keeps peak memory
  at `max(compressed_file_size) + metadata`, never `archive_size`.
  Data descriptors would enable true O(1) per-file memory; that's v2.
- **Split archives.** Multi-disk ZIPs are historical. Not supported.
- **Filesystem walking.** No recursive directory add, no glob, no
  permission handling. Those are I/O concerns; this is a format codec.

## Errors

Three named classes, all extending `Error`:

- `ZipCorruptionError` — CRC mismatch, malformed header, truncated
  archive, ZIP64 sentinels without matching extra fields. The data is
  wrong.
- `ZipAbortError` — an `AbortSignal` fired during writing.
- `ZipEntryError` — invalid entry name, missing source, or other input
  validation failure. The caller's data is wrong.

## Related packages

```
stream
├── crc32          (leaf — no culvert deps)
├── zip            ← you are here  (stream + crc32)
└── ...
```

## License

MIT. See [LICENSE](./LICENSE).
