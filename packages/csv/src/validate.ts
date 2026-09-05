// Shared option validation for csvParse and csvStringify. Bad options
// are programming errors, not data errors — they throw RangeError, not
// a Csv* error class.

export function validateDialect(dialect: {
  delimiter: string;
  quote: string;
  comment?: string | undefined;
}): void {
  const { delimiter, quote, comment } = dialect;

  if (delimiter.length !== 1) {
    throw new RangeError(
      `delimiter must be a single character, got ${JSON.stringify(delimiter)}`,
    );
  }
  if (quote.length !== 1) {
    throw new RangeError(
      `quote must be a single character, got ${JSON.stringify(quote)}`,
    );
  }
  if (delimiter === quote) {
    throw new RangeError("delimiter and quote must differ");
  }
  for (const [name, value] of [
    ["delimiter", delimiter],
    ["quote", quote],
  ] as const) {
    if (value === "\n" || value === "\r") {
      throw new RangeError(`${name} must not be a newline character`);
    }
  }
  if (comment !== undefined) {
    if (comment.length !== 1) {
      throw new RangeError(
        `comment must be a single character, got ${JSON.stringify(comment)}`,
      );
    }
    if (comment === delimiter || comment === quote) {
      throw new RangeError("comment must differ from delimiter and quote");
    }
    if (comment === "\n" || comment === "\r") {
      throw new RangeError("comment must not be a newline character");
    }
  }
}
