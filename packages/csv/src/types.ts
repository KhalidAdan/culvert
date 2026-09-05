import type { CsvSyntaxError } from "./errors.js";

/**
 * A parsed CSV row: positional fields (`headers: false`) or a record
 * keyed by header names (`headers: true` or `headers: string[]`).
 *
 * Every value is a string. CSV has no type system; coercion is the
 * user's job, expressed in a `map` operator where it's visible.
 */
export type CsvRow = string[] | Record<string, string>;

export interface CsvParseOptions {
  /**
   * Header handling.
   *
   * - `false` (default) — emit `string[]` per row.
   * - `true` — consume the first row as headers, emit `Record<string, string>`.
   * - `string[]` — use the supplied headers, no first-row consumption.
   */
  headers?: boolean | string[];

  /** Field delimiter. Single character. Default `','`. */
  delimiter?: string;

  /** Quote character. Single character. Default `'"'`. */
  quote?: string;

  /**
   * Line terminator. `'auto'` (default) accepts `\r\n`, `\n`, and `\r`
   * anywhere in the input — real-world files mix them. An explicit
   * terminator is exact: other newline characters become field data.
   */
  newline?: "auto" | "\n" | "\r\n" | "\r";

  /**
   * Skip lines beginning with this character. Single character.
   * Only recognized at the start of a line; inside a quoted field it
   * is literal. Default: no comment handling.
   */
  comment?: string;

  /** Trim leading/trailing whitespace from unquoted fields. Default `false`. */
  trim?: boolean;

  /** Skip zero-field rows (blank lines). Default `false` — blank lines yield empty arrays / objects. */
  skipEmptyLines?: boolean;

  /**
   * Malformed-input policy. Strict default + named modes + function
   * escape hatch — same recipe as tar's `pathPolicy`.
   *
   * - `'strict'` (default) — throw `CsvSyntaxError`.
   * - `'permissive'` — emit a best-effort row.
   * - Function form — receives the error and the raw line; returns a
   *   substitute row, or `null` to skip the line.
   */
  onMalformed?:
    | "strict"
    | "permissive"
    | ((err: CsvSyntaxError, rawLine: string) => CsvRow | null);

  /** Abort the parse. Surfaces as `CsvAbortError`. */
  signal?: AbortSignal;
}

export interface CsvStringifyOptions {
  /**
   * Header handling.
   *
   * - `false` (default) — input is `string[][]`; no header row emitted.
   * - `true` — input is `Record<string, string>`; the first record's
   *   keys are emitted as the header row.
   * - `string[]` — input is `Record<string, string>`; the supplied
   *   headers are emitted and records are projected onto them (missing
   *   keys emit empty strings, extra keys are dropped).
   */
  headers?: boolean | string[];

  /** Field delimiter. Single character. Default `','`. */
  delimiter?: string;

  /** Quote character. Single character. Default `'"'`. */
  quote?: string;

  /**
   * Line terminator. Default `'\r\n'` (RFC 4180). The parser is liberal
   * in what it accepts; the stringifier is conservative in what it emits.
   */
  newline?: "\n" | "\r\n";

  /**
   * - `'minimal'` (default) — quote only when a field contains the
   *   delimiter, the quote character, or a newline.
   * - `'all'` — quote every field.
   *
   * There is deliberately no `'none'`: it would have to corrupt data
   * or throw at runtime, both worse than understanding quoting.
   */
  quoting?: "minimal" | "all";

  /** Abort the stringify. Surfaces as `CsvAbortError`. */
  signal?: AbortSignal;
}
