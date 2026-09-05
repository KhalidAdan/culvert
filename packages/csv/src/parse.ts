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
 * const rows = await pipe(
 *   response.body!,
 *   csvParse({ headers: true }),
 *   collect(),
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
  if (Array.isArray(headers)) {
    const dup = findDuplicate(headers);
    if (dup !== null) {
      throw new RangeError(
        `headers array contains duplicate key ${JSON.stringify(dup)}`,
      );
    }
  }

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
          if (substitute === null) continue;
          if (awaitingHeaderRow) {
            // The substitute stands in for the header row. Anything but
            // an array of keys is incoherent there — fail loudly rather
            // than mis-keying the whole file.
            if (!Array.isArray(substitute)) {
              throw new CsvSyntaxError(
                "onMalformed returned a record for the header row; " +
                  "a header substitute must be a string[] of keys",
              );
            }
            headerKeys = substitute;
            awaitingHeaderRow = false;
            continue;
          }
          yield substitute as T;
          continue;
        }

        const fields = token.fields;

        // Zero-field rows (blank lines) are never a header and never a
        // length mismatch: a blank first line used to become a
        // zero-column header set, silently emptying every row.
        if (fields.length === 0) {
          if (skipEmptyLines) continue;
          yield (wantObjects ? {} : fields) as T;
          continue;
        }

        if (awaitingHeaderRow) {
          rejectDuplicateHeaders(fields, mode, rowNumber);
          headerKeys = fields;
          awaitingHeaderRow = false;
          continue;
        }

        if (!wantObjects) {
          yield fields as T;
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

function findDuplicate(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/**
 * Duplicate header names make record projection silently drop every
 * earlier duplicate column (last assignment wins). The strict default
 * is loud about data loss; permissive and handler modes keep the
 * last-wins behavior deliberately.
 */
function rejectDuplicateHeaders(
  keys: readonly string[],
  mode: MalformedMode,
  rowNumber: number,
): void {
  if (mode !== "strict") return;
  const dup = findDuplicate(keys);
  if (dup !== null) {
    throw new CsvSyntaxError(
      `Duplicate header name ${JSON.stringify(dup)} in row ${rowNumber}: ` +
        `projection would silently drop a column. ` +
        `Use onMalformed: "permissive" for last-wins, or supply headers: string[].`,
    );
  }
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
