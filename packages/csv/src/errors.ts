// ---------------------------------------------------------------------------
// Named error classes for @culvert/csv.
//
// Same shape as @culvert/zip and @culvert/tar: callers can catch specific
// failure modes without parsing error messages.
// ---------------------------------------------------------------------------

/**
 * Input is malformed CSV.
 *
 * Parser-emitted: unbalanced quotes, unexpected characters after a
 * closing quote, invalid UTF-8, row length mismatch against headers.
 * Thrown in strict mode; passed to the function form of `onMalformed`.
 */
export class CsvSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

/**
 * Caller's input to the stringifier was bad.
 *
 * Stringifier-emitted: a row whose shape doesn't match the header mode
 * (an array where a record is expected, or vice versa). Reserved for
 * strict-projection options in v2.
 */
export class CsvWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvWriteError";
  }
}

/**
 * An AbortSignal fired during parse or stringify.
 */
export class CsvAbortError extends Error {
  constructor(message: string = "CSV operation aborted") {
    super(message);
    this.name = "CsvAbortError";
  }
}
