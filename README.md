# Culvert

**The missing standard library for streaming in JavaScript.**

Quiet. Infrastructural. Essential.

```ts
pipe(source, transform, transform, sink);
```

If you understand that line, you understand Culvert.

## Packages

| Package                                | Purpose                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| [`@culvert/stream`](./packages/stream) | Source/Transform/Sink + `pipe()` + 8 operators + `channel()`             |
| [`@culvert/zip`](./packages/zip)       | Streaming ZIP writer + forward reader + random-access reader with ZIP64  |
| [`@culvert/tar`](./packages/tar)       | Streaming tar reader and writer — ustar + PAX, strict path policy      |
| [`@culvert/gzip`](./packages/gzip)     | Streaming gzip framing — BYOC DEFLATE codec, CRC-32 verified, concatenated members |
| [`@culvert/crc32`](./packages/crc32)   | IEEE 802.3 CRC-32 — streaming-native, zero dependencies                   |
| [`@culvert/csv`](./packages/csv)       | Streaming CSV parser and stringifier — RFC 4180 + real-world dialects, strict-by-default |

All packages are ESM with TypeScript declarations, and run on Node ≥ 18,
Deno, Bun, Cloudflare Workers, and browsers. On Node ≥ 20.17 (all
current LTS lines) `require()` works too, via require(ESM); older
CommonJS consumers should use dynamic `import()`.

## Design bet

Node streams are notoriously painful. Web Streams have their own performance
and usability problems. Async iterators are the language's own answer but
lack the composition primitives you actually need. Culvert picks the
async-iterator foundation and adds the handful of primitives that make
it trustworthy: guaranteed teardown, structural backpressure, clean
composition with a tiny operator set.

Everything downstream is proof the foundation works. `@culvert/zip` is
fiddly, stateful, and full of edge cases — if `@culvert/stream`'s
source/transform/sink model holds up there, it holds anywhere.

## Dependency graph

```
stream
├── crc32          (leaf — no culvert deps)
├── zip            (stream + crc32)
├── tar            (stream)
├── gzip           (stream + crc32)
├── csv            (stream)
└── archive        (stream + zip + tar — not yet)
```

This graph stays clean and acyclic. If it doesn't, we've lost the plot.

## Status

**v2 — shipped.** Stream, crc32, zip, tar, gzip, and csv are in.

**Next:** nothing committed. On the radar: `@culvert/bytes` (waiting
for a byte-reader API the three private copies actually agree on) and
`@culvert/archive` (waiting for real friction).

## License

MIT. See [LICENSE](./LICENSE).
