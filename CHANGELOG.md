# Changelog

All notable changes to the culvert packages, newest first. Versions are
per-package; each release lists every package it touches.

## Unreleased

### @culvert/gzip 0.4.0

- **Added:** `onHeader` in `GunzipOptions` — a per-member observer that
  surfaces each gzip member's parsed header metadata (`filename`,
  `comment`, `mtime`, raw `extra`, `xfl`, `os`) with a 0-based member
  index. Called after the header is parsed and, in strict mode,
  FHCRC-verified — never for a header the policy rejected — and before
  any of that member's data is yielded. New exported type: `GzipHeader`.
- **Added:** FNAME/FCOMMENT fields are capped at 65,535 bytes (the
  fields carry no declared length — an unbounded-read vector in hostile
  streams); exceeding the cap throws `GzipCorruptionError`, with or
  without a callback registered.

## 2026-09-05 — the hardening release

A 21-agent deep review of the whole library found 37 issues; every one
was fixed, each behind a regression test that failed against the old
code. The suite grew from 395 to 439 tests, and CI now runs the build
and full suite on Node 20/22/24.

**Runtime floor:** all packages now declare `engines: node >= 20.12`.
CI's first run proved Node 18 never actually worked for `@culvert/zip`'s
platform deflate — `CompressionStream("deflate-raw")` landed in Node
21.2 and was backported to 20.12.

**Packaging (all packages):** exports maps gained a `default`
condition, so `require()` works on Node ≥ 20.17 via require(ESM)
instead of throwing `ERR_PACKAGE_PATH_NOT_EXPORTED`. Malformed `main`
fields fixed. Inter-package dependencies are now caret ranges instead
of `*`.

### @culvert/stream 0.2.0

- **Fixed:** `buffer()` deadlocked the pipeline when the consumer
  stopped early while the producer was parked on a full "suspend"
  buffer.
- **Fixed:** `abortable()` could not interrupt a pull parked on an idle
  source — aborting a quiet channel or silent socket hung forever. The
  pull is now raced against the signal.
- **Fixed:** `channel()`'s iterator `return()` left an in-flight
  `next()` unsettled forever; `error()` left a parked `write()`
  stranded.
- **Fixed:** concurrent `flatMap()` stalled ready inner values while
  awaiting the outer source; the outer pull now participates in the
  same race.
- **Fixed:** the Safari `fromReadableStream()` fallback never cancelled
  the underlying stream on early termination, leaking connections.
- **Docs:** `abortable()`'s end-don't-throw semantics are documented;
  the README's flagship example now compiles as written.

### @culvert/zip 0.2.0

- **Fixed:** breaking out of a deflated entry's source hung forever
  (the transform now cancels its readable instead of awaiting a blocked
  pump).
- **Fixed:** partially consuming an entry in `readZipEntries()`
  silently dropped every entry after it; unread bytes are now drained
  at the byte level.
- **Changed:** unknown compression methods (bzip2, LZMA, Zstd, AES…)
  now throw `ZipCorruptionError` by name in both readers instead of
  being passed through as if stored / blindly inflated.
- **Changed:** streamed archives that defer sizes to data descriptors
  get a clear "use openZip()" error instead of a bogus CRC mismatch.
- **Fixed:** corrupt DEFLATE data surfaces as `ZipCorruptionError`
  instead of a platform `TypeError`.
- **Fixed:** the EOCD search window had no room for the ZIP64 locator
  behind a maximum-length archive comment.
- Requires Node ≥ 20.12 (see above; this was already true in practice).

### @culvert/tar 0.2.0

- **Fixed:** every GNU-format archive (`tar --format=gnu`, the default
  on many Linux systems) was rejected — the magic comparison expected
  an impossible two-space value.
- **Fixed:** a crafted PAX `size=1.5` record hung the reader in an
  unbounded empty-chunk loop (memory-exhaustion DoS). PAX sizes must be
  integers, matching the writer.
- **Fixed:** space-padded octal fields (POSIX-legal, emitted by
  historic tar tools) parsed as 0, rejecting valid archives.
- **Added:** PAX extended-header data is capped at 1 MiB — the declared
  size is attacker-controlled and was buffered wholesale.
- **Fixed:** rejecting a data-bearing non-file entry (GNU `L`/`K`,
  vendor typeflags) via a function path policy desynced the stream.
- **Docs:** the path policy validates entry *names*; link targets pass
  through verbatim and extractors must validate them — now stated
  plainly.

### @culvert/gzip 0.3.0

First publish of the BYOC redesign (the npm 0.1.0 was a thin
`DecompressionStream` wrapper; the codec-injection architecture with
`consumed`-byte accounting and concatenated-member support replaces it
entirely), plus this release's fixes:

- **Fixed:** compressing a source that yields zero chunks (a 0-byte
  file read) produced an invalid gzip file with no DEFLATE stream.
- **Fixed:** a source error after a member boundary was swallowed and
  reported as clean EOF — silent truncation on network failures.
- **Added:** FHCRC header checksums are verified under strict
  `crcPolicy`.
- **Fixed:** out-of-range `mtime` values clamp to 0 (RFC 1952 "no
  timestamp") instead of wrapping modulo 2^32.
- **Changed:** a throwing codec is wrapped in `GzipCorruptionError`.
- **Docs:** every README example compiles; the pako recipe is now truly
  streaming (constant memory) and checks pako errors.

### @culvert/csv 0.1.0

First publish. Streaming CSV parser and stringifier: character-driven
tokenizer (quoted newlines and escaped quotes are structural), three
header modes, strict/permissive/function `onMalformed` policy, UTF-8
with BOM handling, RFC 4180 CRLF + minimal quoting defaults.

### @culvert/crc32 0.1.3

- No code changes — engines/packaging metadata only.
