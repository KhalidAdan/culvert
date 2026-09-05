# @culvert/tar

**Streaming tar reader and writer for JavaScript.**

ustar with PAX extensions. Constant memory. Strict-by-default path
validation. Works in Node and the browser.

```ts
import { createTar, readTarEntries, EPOCH } from "@culvert/tar";
import { pipe, from, collectBytes, writeTo } from "@culvert/stream";
```

## Why

Most tar libraries on npm buffer the entire archive in memory or wrap
Node streams in ways that don't translate to the browser. `@culvert/tar`
treats tar as what it is: a stream format. Each entry is a
`Source<Uint8Array>` you can pipe anywhere — to a file, an HTTP
response body, IndexedDB, S3.

## Writing

```ts
import { createTar, EPOCH } from "@culvert/tar";
import { pipe, of, writeTo } from "@culvert/stream";

const archive = createTar(async (tar) => {
  await tar.addDirectory({
    name: "src/",
    lastModified: EPOCH,
  });
  await tar.addFile({
    name: "src/hello.txt",
    source: of(new TextEncoder().encode("hello")),
    size: 5,
    lastModified: EPOCH,
  });
  await tar.addSymlink({
    name: "src/latest",
    target: "hello.txt",
    lastModified: EPOCH,
  });
});

await pipe(archive, writeTo(outputStream));
```

The callback runs to completion before the end-of-archive marker is
written — no `close()` to forget. Backpressure flows naturally:
`writer.write()` blocks until the consumer pulls.

### `lastModified` is required, and `EPOCH` exists for a reason

Tar embeds a modification time in every entry. Defaulting it to
`new Date()` would make the same inputs produce different archives —
content hashes change, caches miss, snapshot tests flake.

Pass a deterministic timestamp:

- A file's actual mtime (`fs.stat().mtime`)
- A commit time
- `EPOCH` (Unix epoch zero) for fully reproducible builds

### Why `size` is required

Tar's header comes before the file data, and the size lives in the
header. We can't patch a header that's already been streamed
downstream — see `culvert-tar-scope.md` for the full explanation.

In practice you almost always have it:

- Browser: `File.size` and `Blob.size` are free
- Node: `fs.stat().size` is one cheap syscall
- HTTP: `Content-Length`, usually present

If your source genuinely doesn't know its size, buffer it first to
measure.

### Modification timestamps

Default precision is `'seconds'` — mtimes truncate to whole seconds
before being written, producing pure ustar entries. This matches GNU
tar's default and is right for the common case.

For sub-second precision (millisecond, the limit of JS's `Date`):

```ts
createTar(callback, { mtimePrecision: "subsecond" });
```

This emits a PAX extended header per entry. Each entry gains ~1 KiB
of overhead; gzip compresses this well, but uncompressed archives
carry it in full.

Reach for `'subsecond'` when round-tripping archives whose precision
must be preserved, or when downstream tooling cares about millisecond
mtimes. Otherwise, the default is the right choice.

### Path policy

Tar archives with `..` or absolute paths have been used to overwrite
arbitrary files since the format was invented. The writer rejects
them by default:

```ts
createTar(callback);                                    // strict (default)
createTar(callback, { pathPolicy: "permissive" });      // pass through
createTar(callback, {
  pathPolicy: (name) =>
    name.startsWith("./") ? name.slice(2) : name,       // transform
});
```

## Reading

```ts
import { readTarEntries } from "@culvert/tar";
import { pipe, collectBytes } from "@culvert/stream";

for await (const entry of readTarEntries(tarSource)) {
  if (entry.kind === "file" && entry.name.endsWith(".csv")) {
    const data = await pipe(entry.source, collectBytes());
    // process data
  }
  // Other entries: their `source` (if any) goes unconsumed.
  // The reader auto-drains them before yielding the next entry.
}
```

The entry is a discriminated union on `kind`:

- `'file'` — has `source: Source<Uint8Array>` and `size`
- `'directory'` — no payload
- `'symlink'` — has `target`
- `'hardlink'` — has `target`
- `'unknown'` — typeflag we don't know about; carries `typeflag`,
  `name`, `size` so you can log or report it

PAX `'x'` and `'g'` headers are consumed internally and never surface.

### Path policy on read

Same shape as the writer; the reader is where extraction-time path
attacks ("zip slip" / "tar slip") against entry *names* get caught.

```ts
readTarEntries(source);                                  // strict (default)
readTarEntries(source, { pathPolicy: "permissive" });    // inspection
readTarEntries(source, {
  pathPolicy: (name) =>
    name.startsWith("../") ? new Error("escaped") : name,
});
```

In strict mode, a hostile path halts iteration with
`TarCorruptionError`. The function form lets you skip individual
entries (return `Error`) without aborting the whole archive.

**The policy validates entry names only — link `target` values are
passed through verbatim.** Symlink targets legitimately contain `..`
and absolute paths in benign archives, so the reader cannot reject
them for you. If you *materialize* links during extraction, you are
the extraction layer: resolve each symlink/hardlink `target` against
your extraction root and refuse targets that escape it, or the classic
symlink-then-write-through-it tar-slip still applies. (This package
ships no extractor, so reading alone is safe.)

Note: a PAX `'x'` extended header immediately preceding a skipped
entry is consumed and discarded with that entry. It does not carry
forward to the next entry — this is spec-correct behavior, but worth
knowing if you're inspecting archives entry-by-entry.

### Checksum policy

```ts
readTarEntries(source);                                    // strict (default)
readTarEntries(source, { checksumPolicy: "permissive" });  // recovery mode
```

Strict mode validates the ustar header checksum on every block.
Permissive skips the check — useful for recovering data from a
damaged archive.

## What's not included (v1)

- **Concatenated archives** — `cat a.tar b.tar | readTarEntries` reads
  only the first archive. Split the input yourself if needed.
- **Missing end markers** — archives that don't terminate with the
  1024-byte zero marker are rejected. Use a tool that emits valid end
  markers, or pipe through `gtar`.
- **Non-UTF-8 charsets** — PAX `charset=ISO-8859-1` and similar are
  rejected. Real-world archives in non-UTF-8 charsets are vanishingly
  rare in 2026.
- **Sparse files** — GNU tar's sparse extension is non-standard and
  rare. Not supported.
- **Extended attributes (xattrs)** — SCHILY-extended PAX records are
  not parsed.

## Errors

Three named classes, all extending `Error`:

- `TarCorruptionError` — archive content is malformed or hostile.
- `TarAbortError` — an `AbortSignal` fired during read or write.
- `TarEntryError` — caller's input was bad (size mismatch, hostile
  path under strict writer policy, missing required field).

## Filename encoding

Filenames are UTF-8. Multibyte characters may push otherwise-short
names over the 100-byte ustar limit and trigger a PAX extended
header. The archive remains valid; older readers without PAX support
will see the entry under a fallback name.

## Related packages

```
stream
├── crc32   (leaf — no culvert deps)
├── zip     (stream + crc32)
└── tar     ← you are here  (stream)
```

## License

MIT. See [LICENSE](./LICENSE).
