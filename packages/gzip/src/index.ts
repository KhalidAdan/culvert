// ---------------------------------------------------------------------------
// @culvert/gzip — public API
//
// 10 exports. Two functions, six types, two errors.
// Everything else is internal.
// ---------------------------------------------------------------------------

// --- Functions ---
export { gzip } from "./gzip.js";
export { gunzip } from "./gunzip.js";

// --- Codec interfaces (for implementors) ---
export type { Inflator, InflateResult, Deflator } from "./types.js";

// --- Options ---
export type { GzipOptions, GunzipOptions, GzipHeader } from "./types.js";

// --- Errors ---
export { GzipCorruptionError } from "./errors.js";
export { GzipAbortError } from "./errors.js";
