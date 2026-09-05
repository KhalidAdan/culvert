import { abortable, type Source, type Transform } from "@culvert/stream";
import { CsvAbortError, CsvSyntaxError } from "./errors.js";
import { CsvTokenizer, type MalformedMode, type TokenRow } from "./tokenizer.js";
import type { CsvParseOptions, CsvRow } from "./types.js";
import { validateDialect } from "./validate.js";

/**
 * Streaming CSV parser.
 *
 * A `Transform<Uint8Array, T>` — a peer of `filter` and `map`, not a
 * special parsing stage. UTF-8 only; multi-byte characters and quote
 * characters split across chunk boundaries are handled. Memory is
 * bounded by the longest single row in the input.
 *
 * Every emitted value is a string — CSV has no type system, and
 * pretending otherwise loses leading zeros on zip codes. The generic
 * parameter types the row's *keys*; coercion belongs in a user `map`
 * operator where it's visible.
 *
 * @example
 * ```ts
 * await pipe(
 *   fetchBody(),
 *   csvParse({ headers: true }),
 *   filter(row => row.status === "active"),
 *   writeTo(database),
 * );
 * ```
 */
export function csvParse<T = CsvRow>(
  options: CsvParseOptions = {},
): Transform<Uint8Array, T> {
  const {
    headers = false,
    delimiter = ",",
    quote = '"',
    newline = "auto",
    comment,
    trim = false,
    skipEmptyLines = false,
    onMalformed = "strict",
    signal,
  } = options;

  validateDialect({ delimiter, quote, comment });

  const handler = typeof onMalformed === "function" ? onMalformed : null;
  const mode: MalformedMode =
    typeof onMalformed === "function" ? "handler" : onMalformed;
  const wantObjects = headers === true || Array.isArray(headers);

  return async function* (source: Source<Uint8Array>) {
    if (signal?.aborted) throw new CsvAbortError();
    const tracked = signal ? abortable(source, signal) : source;

    // fatal: true → invalid UTF-8 throws instead of emitting U+FFFD.
    // A leading BOM is stripped by default (ignoreBOM defaults false).
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const tokenizer = new CsvTokenizer({
      delimiter,
      quote,
      newline,
      comment,
      trim,
      mode,
    });

    let headerKeys: string[] | null = Array.isArray(headers)
      ? [...headers]
      : null;
    let awaitingHeaderRow = headers === true;
    let rowNumber = 0;

    function* handleRows(rows: TokenRow[]): Generator<T> {
      for (const token of rows) {
        rowNumber++;

        if (token.fields === null) {
          // Tokenizer-level malformed row (handler mode only).
          const substitute = handler!(token.error!, token.raw);
          if (substitute !== null) yield substitute as T;
          continue;
        }

        const fields = token.fields;

        if (skipEmptyLines && fields.length === 0) continue;

        if (awaitingHeaderRow) {
          headerKeys = fields;
          awaitingHeaderRow = false;
          continue;
        }

        if (!wantObjects) {
          yield fields as T;
          continue;
        }

        // Record mode.
        if (fields.length === 0) {
          // Blank line: yields an empty object, not a length mismatch.
          yield {} as T;
          continue;
        }

        const keys = headerKeys!;
        if (fields.length !== keys.length) {
          const err = new CsvSyntaxError(
            `Row ${rowNumber} has ${fields.length} fields; expected ${keys.length}`,
          );
          if (mode === "strict") throw err;
          if (handler) {
            const substitute = handler(
              err,
              token.raw !== "" ? token.raw : fields.join(delimiter),
            );
            if (substitute !== null) yield substitute as T;
            continue;
          }
          // Permissive: truncate extras, fill missing with empty strings.
        }

        const record: Record<string, string> = {};
        for (let i = 0; i < keys.length; i++) {
          record[keys[i]!] = fields[i] ?? "";
        }
        yield record as T;
      }
    }

    for await (const chunk of tracked) {
      if (signal?.aborted) throw new CsvAbortError();
      tokenizer.write(decodeChunk(decoder, chunk, true));
      yield* handleRows(tokenizer.drain());
    }
    if (signal?.aborted) throw new CsvAbortError();

    tokenizer.write(decodeChunk(decoder, undefined, false));
    tokenizer.end();
    yield* handleRows(tokenizer.drain());
  };
}

function decodeChunk(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  stream: boolean,
): string {
  try {
    return decoder.decode(chunk, { stream });
  } catch {
    throw new CsvSyntaxError("Input is not valid UTF-8");
  }
}
