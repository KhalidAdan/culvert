// Types
export type { Sink, Source, Transform } from "./types.js";

// The core
export { pipe } from "./pipe.js";

// Operators — each earns its place because the naive version has bugs
export {
  abortable,
  batch,
  buffer,
  concat,
  finalize,
  flatMap,
  merge,
  tap,
} from "./operators.js";
export type { BufferStrategy, FlatMapOptions } from "./operators.js";

// Sources — on-ramps to a pipeline
export { empty, from, of } from "./sources.js";

// Sinks — pipeline terminators
export { collect, collectBytes } from "./sinks.js";

// Bridges — interop with Web Streams
export { fromReadableStream, toReadableStream, writeTo } from "./bridge.js";

export { channel } from "./channel.js";
export type { ChannelWriter } from "./channel.js";
