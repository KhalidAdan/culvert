# Culvert

**The missing standard library for streaming in JavaScript.**

Quiet. Infrastructural. Essential.

```ts
pipe(source, transform, transform, sink)
```

If you understand that line, you understand Culvert.

## Packages

| Package | Purpose |
|---|---|
| [`@culvert/stream`](./packages/stream) | Source/Transform/Sink + `pipe()` + 8 operators + `channel()` |
| [`@culvert/zip`](./packages/zip) | Streaming ZIP writer + forward reader + random-access reader with ZIP64 |
| [`@culvert/crc32`](./packages/crc32) | IEEE 802.3 CRC-32 — streaming-native, zero dependencies |

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
├── gzip           (stream — not yet)
├── tar            (stream — not yet)
└── archive        (stream + zip + tar — not yet)
```

This graph stays clean and acyclic. If it doesn't, we've lost the plot.

## Status

**v1.5 — shipped.** Stream, crc32, and zip are in production use by the
audiobook downloader pipeline that started this project. Random-access
ZIP reading — with ZIP64 support — quietly landed for the comic reader
use case.

**Next:** `@culvert/gzip`, once real usage of the current three packages
signals it's time. Not before.

## License

MIT. See [LICENSE](./LICENSE).
