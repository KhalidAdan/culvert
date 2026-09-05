import { describe, it, expect } from "vitest";
import { pipe, from, collect, collectBytes } from "@culvert/stream";
import { csvParse, csvStringify, CsvSyntaxError } from "./index.js";
import type { CsvParseOptions, CsvRow } from "./index.js";

// ---------------------------------------------------------------------------
// Regression suite from the 2026-09-05 deep review: header-row handling
// under malformed/blank first lines, duplicate header names, and the
// single-empty-field round-trip.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function parseAll<T = string[]>(
  input: string,
  options?: CsvParseOptions,
): Promise<T[]> {
  return pipe(from([enc.encode(input)]), csvParse<T>(options), collect());
}

describe("malformed header row (handler mode)", () => {
  const input = '"id"x,name\n1,alice\n2,bob\n';

  it("a null substitute skips the bad line; the next row becomes the header", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      onMalformed: () => null,
    });
    // Documented semantics: null = skip this line entirely. The file
    // then effectively starts at "1,alice", which becomes the header.
    expect(rows).toEqual([{ "1": "2", alice: "bob" }]);
  });

  it("an array substitute becomes the header, not a data row", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      onMalformed: () => ["id", "name"],
    });
    // Before the fix the substitute was emitted as a data row while the
    // parser kept waiting for a header — mis-keying the whole file and
    // swallowing one data row.
    expect(rows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("a record substitute in header position is rejected loudly", async () => {
    await expect(
      parseAll(input, {
        headers: true,
        onMalformed: () => ({ id: "?" }),
      }),
    ).rejects.toThrow(CsvSyntaxError);
  });
});

describe("blank first line with headers: true", () => {
  const input = "\nid,name\n1,alice\n2,bob\n";

  it("never becomes a zero-column header (strict)", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
    });
    // The blank line is an empty record ({}), the real header row is
    // "id,name". Before the fix headerKeys became [] and every data row
    // errored (strict) or was emptied to {} (permissive).
    expect(rows).toEqual([{}, { id: "1", name: "alice" }, { id: "2", name: "bob" }]);
  });

  it("permissive mode no longer empties every row", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      onMalformed: "permissive",
    });
    expect(rows).toEqual([{}, { id: "1", name: "alice" }, { id: "2", name: "bob" }]);
  });

  it("skipEmptyLines drops the blank line before the header", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      skipEmptyLines: true,
    });
    expect(rows).toEqual([{ id: "1", name: "alice" }, { id: "2", name: "bob" }]);
  });
});

describe("duplicate header names", () => {
  const input = "id,amount,amount\n1,100,200\n";

  it("strict mode throws instead of silently dropping a column", async () => {
    await expect(parseAll(input, { headers: true })).rejects.toThrow(
      /duplicate header/i,
    );
  });

  it("permissive mode keeps last-wins semantics", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      onMalformed: "permissive",
    });
    expect(rows).toEqual([{ id: "1", amount: "200" }]);
  });

  it("duplicate keys in a supplied headers array are a config error", () => {
    expect(() => csvParse({ headers: ["a", "b", "a"] })).toThrow(RangeError);
  });
});

describe("single empty field round-trip", () => {
  it("stringify quotes a lone empty field so it survives parsing", async () => {
    const bytes = await pipe(
      from([[""]] as CsvRow[]),
      csvStringify(),
      collectBytes(),
    );
    expect(dec.decode(bytes)).toBe('""\r\n');

    const rows = await pipe(from([bytes]), csvParse(), collect());
    expect(rows).toEqual([[""]]);
  });

  it("a single-column record with an empty value round-trips", async () => {
    const original = [{ note: "a" }, { note: "" }, { note: "b" }];
    const rows = await pipe(
      from(original as CsvRow[]),
      csvStringify({ headers: true }),
      csvParse({ headers: true }),
      collect(),
    );
    expect(rows).toEqual(original);
  });
});
