// ---------------------------------------------------------------------------
// @culvert/gzip — public API
//
// 9 exports. Two functions, five types, two errors.
// Everything else is internal.
// ---------------------------------------------------------------------------

// --- Functions ---
export { gzip } from "./gzip.js";
export { gunzip } from "./gunzip.js";

// --- Codec interfaces (for implementors) ---
export type { Inflator, InflateResult, Deflator } from "./types.js";

// --- Options ---
export type { GzipOptions, GunzipOptions } from "./types.js";

// --- Errors ---
export { GzipCorruptionError } from "./errors.js";
export { GzipAbortError } from "./errors.js";
