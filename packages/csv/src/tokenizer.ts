// ---------------------------------------------------------------------------
// CsvTokenizer — a character-driven state machine over decoded text.
//
// Internal to @culvert/csv. Not exported.
//
// The tokenizer is fed decoded string chunks (UTF-8 decoding, including
// multi-byte characters split across chunk boundaries, is the caller's
// job via TextDecoder streaming mode). It buffers at most one row at a
// time; memory is bounded by the longest single row in the input.
//
// Why character-driven and not line-driven: quoted fields may contain
// newlines. "Split on newline, then split on delimiter" silently emits
// wrong row counts. The state machine makes that bug unrepresentable.
//
// States:
//   RowStart      — start of a line; nothing committed for this row
//   FieldStart    — about to read a field (after a delimiter)
//   Unquoted      — inside an unquoted field
//   Quoted        — inside a quoted field (newlines are literal here)
//   QuoteInQuoted — just saw a quote inside a quoted field: either an
//                   escaped quote ("" → ") or the field's closing quote
//   Comment       — inside a comment line; swallow until the terminator
//   Recovery      — handler mode only: a syntax error occurred; swallow
//                   until the terminator, then surface the raw line
// ---------------------------------------------------------------------------

import { CsvSyntaxError } from "./errors.js";

export type MalformedMode = "strict" | "permissive" | "handler";

export interface TokenizerOptions {
  delimiter: string;
  quote: string;
  newline: "auto" | "\n" | "\r\n" | "\r";
  comment: string | undefined;
  trim: boolean;
  mode: MalformedMode;
}

/**
 * One tokenized row. `fields` is null when the row was malformed and
 * the mode is "handler" — `error` and `raw` carry what the handler
 * needs. `raw` is tracked only in handler mode (it costs a growing
 * string per row) and is the row's text without its terminator.
 */
export interface TokenRow {
  fields: string[] | null;
  raw: string;
  error: CsvSyntaxError | null;
}

type State =
  | "RowStart"
  | "FieldStart"
  | "Unquoted"
  | "Quoted"
  | "QuoteInQuoted"
  | "Comment"
  | "Recovery";

export class CsvTokenizer {
  private readonly delimiter: string;
  private readonly quote: string;
  private readonly newline: "auto" | "\n" | "\r\n" | "\r";
  private readonly comment: string | undefined;
  private readonly trim: boolean;
  private readonly mode: MalformedMode;
  private readonly trackRaw: boolean;

  private state: State = "RowStart";
  private field = "";
  private fieldWasQuoted = false;
  private row: string[] = [];
  private rawRow = "";
  private pendingError: CsvSyntaxError | null = null;

  /** 'auto' mode: a \r just terminated a row; swallow one following \n. */
  private skipLF = false;
  /** '\r\n' mode: saw \r, waiting to learn if the next char is \n. */
  private pendingCR = false;

  private rows: TokenRow[] = [];
  private emitted = 0;

  constructor(options: TokenizerOptions) {
    this.delimiter = options.delimiter;
    this.quote = options.quote;
    this.newline = options.newline;
    this.comment = options.comment;
    this.trim = options.trim;
    this.mode = options.mode;
    this.trackRaw = options.mode === "handler";
  }

  /** Feed a chunk of decoded text. Completed rows accumulate for drain(). */
  write(text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.processChar(text[i]!);
    }
  }

  /** Take all completed rows accumulated since the last drain. */
  drain(): TokenRow[] {
    const out = this.rows;
    this.rows = [];
    return out;
  }

  /** Signal EOF. Emits any final partial row; drain() afterwards. */
  end(): void {
    if (this.pendingCR) {
      // A trailing \r in '\r\n' mode never got its \n — it was literal.
      this.pendingCR = false;
      if (this.trackRaw) this.rawRow += "\r";
      this.literal("\r");
    }

    switch (this.state) {
      case "RowStart":
      case "Comment":
        break;
      case "FieldStart":
      case "Unquoted":
      case "QuoteInQuoted":
        // QuoteInQuoted at EOF is a closing quote at end of input — legal.
        this.commitField();
        this.emitRow();
        break;
      case "Quoted": {
        const err = new CsvSyntaxError(
          `Unterminated quoted field at end of input (row ${this.currentRowNumber()})`,
        );
        if (this.mode === "strict") throw err;
        if (this.mode === "permissive") {
          this.commitField();
          this.emitRow();
        } else {
          this.emitMalformed(err);
        }
        break;
      }
      case "Recovery":
        this.emitMalformed(this.pendingError!);
        break;
    }
    this.state = "RowStart";
  }

  // -------------------------------------------------------------------------

  private currentRowNumber(): number {
    return this.emitted + 1;
  }

  private processChar(c: string): void {
    if (this.skipLF) {
      this.skipLF = false;
      if (c === "\n") return; // second half of \r\n — swallowed
    }

    if (this.pendingCR) {
      this.pendingCR = false;
      if (c === "\n") {
        this.terminateRow();
        return;
      }
      // The held \r was literal data after all.
      if (this.trackRaw) this.rawRow += "\r";
      this.literal("\r");
      // Fall through and process c normally (pendingCR is cleared).
      this.processChar(c);
      return;
    }

    // Inside a quoted field, newlines and delimiters are literal.
    if (this.state === "Quoted") {
      if (this.trackRaw) this.rawRow += c;
      if (c === this.quote) {
        this.state = "QuoteInQuoted";
      } else {
        this.field += c;
      }
      return;
    }

    // Row terminators (outside quoted fields).
    switch (this.newline) {
      case "auto":
        if (c === "\n") {
          this.terminateRow();
          return;
        }
        if (c === "\r") {
          this.terminateRow();
          this.skipLF = true;
          return;
        }
        break;
      case "\n":
        if (c === "\n") {
          this.terminateRow();
          return;
        }
        break;
      case "\r":
        if (c === "\r") {
          this.terminateRow();
          return;
        }
        break;
      case "\r\n":
        if (c === "\r") {
          this.pendingCR = true;
          return;
        }
        break;
    }

    if (this.trackRaw) this.rawRow += c;
    this.dispatch(c);
  }

  /** Append a character as literal data, bypassing terminator checks. */
  private literal(c: string): void {
    if (this.state === "Quoted") {
      this.field += c;
      return;
    }
    this.dispatch(c);
  }

  /** Handle a non-terminator character in the current state. */
  private dispatch(c: string): void {
    switch (this.state) {
      case "RowStart":
        if (this.comment !== undefined && c === this.comment) {
          this.state = "Comment";
          this.rawRow = "";
          return;
        }
        this.state = "FieldStart";
        this.dispatch(c);
        return;

      case "FieldStart":
        if (c === this.quote) {
          this.state = "Quoted";
          this.fieldWasQuoted = true;
        } else if (c === this.delimiter) {
          this.commitField();
        } else {
          this.field += c;
          this.state = "Unquoted";
        }
        return;

      case "Unquoted":
        if (c === this.delimiter) {
          this.commitField();
          this.state = "FieldStart";
        } else {
          // Includes quote characters: a quote inside an unquoted field
          // is literal, matching the common lenient behavior.
          this.field += c;
        }
        return;

      case "QuoteInQuoted":
        if (c === this.quote) {
          // Escaped quote: "" → literal "
          this.field += this.quote;
          this.state = "Quoted";
        } else if (c === this.delimiter) {
          this.commitField();
          this.state = "FieldStart";
        } else {
          this.malformed(
            new CsvSyntaxError(
              `Unexpected ${JSON.stringify(c)} after closing quote (row ${this.currentRowNumber()})`,
            ),
            c,
          );
        }
        return;

      case "Comment":
      case "Recovery":
        // Swallow. Recovery raw already accumulated in processChar.
        return;

      case "Quoted":
        // Unreachable — handled in processChar before terminator logic.
        return;
    }
  }

  private malformed(err: CsvSyntaxError, c: string): void {
    if (this.mode === "strict") throw err;
    if (this.mode === "permissive") {
      // Best effort: treat the offending character literally and keep
      // tokenizing the rest of the row as unquoted content.
      this.field += c;
      this.state = "Unquoted";
      return;
    }
    // Handler mode: swallow to the end of the line, then surface the
    // raw text for the user's onMalformed function.
    this.pendingError = err;
    this.state = "Recovery";
  }

  private terminateRow(): void {
    switch (this.state) {
      case "Comment":
        this.state = "RowStart";
        this.rawRow = "";
        return;
      case "Recovery":
        this.emitMalformed(this.pendingError!);
        this.state = "RowStart";
        return;
      case "RowStart":
        this.emitRow(); // blank line → zero-field row
        return;
      default:
        // FieldStart, Unquoted, QuoteInQuoted all have a field to commit.
        this.commitField();
        this.emitRow();
        this.state = "RowStart";
        return;
    }
  }

  private commitField(): void {
    let value = this.field;
    if (this.trim && !this.fieldWasQuoted) value = value.trim();
    this.row.push(value);
    this.field = "";
    this.fieldWasQuoted = false;
  }

  private emitRow(): void {
    this.rows.push({
      fields: this.row,
      raw: this.trackRaw ? this.rawRow : "",
      error: null,
    });
    this.row = [];
    this.rawRow = "";
    this.emitted++;
    this.state = "RowStart";
  }

  private emitMalformed(error: CsvSyntaxError): void {
    this.rows.push({ fields: null, raw: this.rawRow, error });
    this.row = [];
    this.field = "";
    this.fieldWasQuoted = false;
    this.rawRow = "";
    this.pendingError = null;
    this.emitted++;
  }
}
