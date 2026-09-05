import { abortable, type Source, type Transform } from "@culvert/stream";
import { CsvAbortError, CsvWriteError } from "./errors.js";
import type { CsvRow, CsvStringifyOptions } from "./types.js";
import { validateDialect } from "./validate.js";

/**
 * Streaming CSV stringifier.
 *
 * A `Transform<CsvRow, Uint8Array>`. Output starts with the first row —
 * the full result set is never held in memory.
 *
 * Defaults are conservative where the parser is liberal: `\r\n`
 * terminators (RFC 4180, universally accepted) and minimal quoting.
 *
 * @example
 * ```ts
 * await pipe(
 *   database.query("SELECT id, name FROM users"),
 *   csvStringify({ headers: true }),
 *   writeTo(httpResponse),
 * );
 * ```
 */
export function csvStringify(
  options: CsvStringifyOptions = {},
): Transform<CsvRow, Uint8Array> {
  const {
    headers = false,
    delimiter = ",",
    quote = '"',
    newline = "\r\n",
    quoting = "minimal",
    signal,
  } = options;

  validateDialect({ delimiter, quote });

  const objectMode = headers === true || Array.isArray(headers);
  const quoteAll = quoting === "all";
  const escaped = quote + quote;

  function formatField(value: string): string {
    const needsQuotes =
      quoteAll ||
      value.includes(delimiter) ||
      value.includes(quote) ||
      value.includes("\n") ||
      value.includes("\r");
    if (!needsQuotes) return value;
    return quote + value.split(quote).join(escaped) + quote;
  }

  function formatRow(fields: readonly unknown[]): string {
    let line = "";
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) line += delimiter;
      const value = fields[i];
      line += formatField(value === null || value === undefined ? "" : String(value));
    }
    return line + newline;
  }

  return async function* (source: Source<CsvRow>) {
    if (signal?.aborted) throw new CsvAbortError();
    const tracked = signal ? abortable(source, signal) : source;

    const encoder = new TextEncoder();
    let headerKeys: string[] | null = Array.isArray(headers)
      ? [...headers]
      : null;
    let headerEmitted = false;

    for await (const row of tracked) {
      if (signal?.aborted) throw new CsvAbortError();

      if (!objectMode) {
        if (!Array.isArray(row)) {
          throw new CsvWriteError(
            "headers: false expects string[] rows; got a record — set headers to true or a string[]",
          );
        }
        yield encoder.encode(formatRow(row));
        continue;
      }

      if (Array.isArray(row)) {
        throw new CsvWriteError(
          "headers mode expects Record<string, string> rows; got an array — set headers: false",
        );
      }

      if (!headerEmitted) {
        // headers: true derives the header row from the first record's
        // keys; headers: string[] was supplied up front. Either way the
        // header is emitted lazily so an empty source emits nothing.
        headerKeys ??= Object.keys(row);
        yield encoder.encode(formatRow(headerKeys));
        headerEmitted = true;
      }

      // Project onto the header key set: missing keys emit empty
      // strings, extra keys are dropped.
      const keys = headerKeys!;
      const projected: string[] = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        const value = row[keys[i]!];
        projected[i] = value === null || value === undefined ? "" : String(value);
      }
      yield encoder.encode(formatRow(projected));
    }
  };
}
