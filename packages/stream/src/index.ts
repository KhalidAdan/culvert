// Types
export type { Source, Transform, Sink } from "./types.js";

// The core
export { pipe } from "./pipe.js";

// Operators — each earns its place because the naive version has bugs
export {
  tap,
  finalize,
  abortable,
  batch,
  merge,
  concat,
  flatMap,
  buffer,
} from "./operators.js";
export type { FlatMapOptions, BufferStrategy } from "./operators.js";

// Sources — on-ramps to a pipeline
export { from, empty, of } from "./sources.js";

// Sinks — pipeline terminators
export { collect, collectBytes, forEach, reduce, discard } from "./sinks.js";

// Bridges — interop with Web Streams
export { toReadableStream, fromReadableStream, writeTo } from "./bridge.js";
