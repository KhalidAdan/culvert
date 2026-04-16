# @culvert/crc32

IEEE 802.3 CRC-32. Streaming-native. Zero dependencies.

```ts
import { CRC32 } from "@culvert/crc32";

const crc = new CRC32();
crc.update(new TextEncoder().encode("123456789"));
crc.digest(); // 0xCBF43926
```

## Why this exists

Node doesn't ship a CRC-32 module. `node:crypto` covers cryptographic
hashes; CRC-32 isn't one. `node:zlib` uses CRC-32 internally for gzip
but doesn't expose it to userland. The npm ecosystem answer is a
handful of packages (`crc-32`, `crc`, `node-crc`) with slightly
different APIs, return types (some return signed integers), and
streaming semantics.

`@culvert/crc32` exists because there should be one correct,
zero-dependency, streaming-native implementation.

## What CRC-32 does

CRC-32 produces a 32-bit fingerprint of any blob of data. Change one
bit and the fingerprint changes. Every Ethernet frame, every PNG,
every ZIP, every gzip stream uses this exact algorithm to verify data
wasn't corrupted in transit or on disk.

**It is not a cryptographic hash.** No collision resistance, no
preimage resistance, trivial to forge. It detects accidental errors
— flipped bits from noisy channels, bad sectors, cosmic rays hitting
RAM — not intentional tampering.

## API

```ts
class CRC32 {
  update(data: Uint8Array): void;   // feed a chunk; call as many times as needed
  digest(): number;                  // finalized unsigned 32-bit value
  reset(): void;                     // reuse the instance for a new computation
}
```

Three methods. One class. Four bytes of state. Call `update()`
repeatedly, then `digest()` once. Streaming equivalence is guaranteed:
splitting the input at any chunk boundary produces the same digest.

## Specification

Canonical test vector: the ASCII string `"123456789"` produces
`0xCBF43926`. This value was established by Ross Williams'
1993 "Painless Guide to CRC Error Detection Algorithms" and is
universally adopted. The full parameterization (Ross Williams /
Rocksoft Model):

| Parameter | Value |
|---|---|
| Width | 32 |
| Polynomial | 0x04C11DB7 |
| Init | 0xFFFFFFFF |
| RefIn | true |
| RefOut | true |
| XorOut | 0xFFFFFFFF |
| Check | 0xCBF43926 |
| Residue | 0xDEBB20E3 |

Greg Cook's CRC RevEng catalogue names this variant **CRC-32/ISO-HDLC**
with aliases CRC-32, CRC-32/ADCCP, CRC-32/V-42, CRC-32/XZ, and PKZIP.

## Design decisions

**Unsigned return.** `digest()` returns a regular JavaScript `number`
that is always in the range `[0, 0xFFFFFFFF]`. Many npm CRC
implementations return signed 32-bit values, which is a footgun when
you try to format them as hex or compare them. We apply `>>> 0` before
returning.

**`Uint8Array` only.** We don't accept strings, ArrayBuffers, or Node
Buffers. If you have a string, encode it. If you have a Buffer, it's
already a `Uint8Array` subclass. This is the lowest-common-denominator
binary type that works in Node and the browser.

**No Web Crypto, no streaming hash API mimicry.** `@culvert/crc32`
intentionally does not implement `SubtleCrypto`-style async digest.
CRC-32 is cheap enough that the async ceremony isn't worth it, and
streaming is handled structurally through the `update`/`digest` pair.

## Related packages

`@culvert/crc32` is a leaf in the Culvert dependency graph:

```
stream
├── crc32     ← you are here (no culvert deps)
├── zip       (stream + crc32)
└── ...
```

## License

MIT. See [LICENSE](./LICENSE).
