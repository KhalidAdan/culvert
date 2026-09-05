import { describe, it, expect } from "vitest";
import { pipe, from, collect } from "@culvert/stream";
import { csvParse } from "./index.js";
import type { CsvParseOptions } from "./index.js";

const enc = new TextEncoder();

function parseAll<T = string[]>(
  input: string | Uint8Array[],
  options?: CsvParseOptions,
): Promise<T[]> {
  const chunks =
    typeof input === "string" ? [enc.encode(input)] : input;
  return pipe(from(chunks), csvParse<T>(options), collect());
}

describe("dialects", () => {
  it("parses RFC 4180 canonical form (comma, double-quote, CRLF)", async () => {
    const rows = await parseAll('a,b,c\r\n1,2,3\r\n"x","y","z"\r\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["x", "y", "z"],
    ]);
  });

  it("parses TSV", async () => {
    const rows = await parseAll("a\tb\n1\t2\n", { delimiter: "\t" });
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses semicolon delimiter (Excel European locale)", async () => {
    const rows = await parseAll("a;b\n1;2\n", { delimiter: ";" });
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses LF-only newlines", async () => {
    const rows = await parseAll("a,b\n1,2\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses lone-CR newlines (legacy Mac)", async () => {
    const rows = await parseAll("a,b\r1,2\r");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses mixed CRLF and LF in one file", async () => {
    const rows = await parseAll("a\r\nb\nc\r\nd\n");
    expect(rows).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  it("parses single-quote quoted fields", async () => {
    const rows = await parseAll("'a,x',b\n", { quote: "'" });
    expect(rows).toEqual([["a,x", "b"]]);
  });

  it("explicit newline: '\\n' treats CR as literal data", async () => {
    const rows = await parseAll("a\r\nb\n", { newline: "\n" });
    expect(rows).toEqual([["a\r"], ["b"]]);
  });

  it("explicit newline: '\\r\\n' treats lone LF as literal data", async () => {
    const rows = await parseAll("a\nb\r\nc\r\n", { newline: "\r\n" });
    expect(rows).toEqual([["a\nb"], ["c"]]);
  });
});

describe("quoting", () => {
  it("decodes doubled quotes inside quoted fields", async () => {
    const rows = await parseAll('"He said ""hello"""\n');
    expect(rows).toEqual([['He said "hello"']]);
  });

  it("parses an empty quoted field", async () => {
    const rows = await parseAll('""\n');
    expect(rows).toEqual([[""]]);
  });

  it("parses quoted-empty then data", async () => {
    const rows = await parseAll('"",hello\n"","",hello\n');
    expect(rows).toEqual([
      ["", "hello"],
      ["", "", "hello"],
    ]);
  });

  it("preserves newlines inside quoted fields", async () => {
    const rows = await parseAll('"Loves\nhiking",chess\n"a\r\nb",c\n');
    expect(rows).toEqual([
      ["Loves\nhiking", "chess"],
      ["a\r\nb", "c"],
    ]);
  });

  it("treats a quote inside an unquoted field as literal", async () => {
    const rows = await parseAll('ab"c,d\n');
    expect(rows).toEqual([['ab"c', "d"]]);
  });

  it("accepts a closing quote at end of input without a trailing newline", async () => {
    const rows = await parseAll('a,"b"');
    expect(rows).toEqual([["a", "b"]]);
  });
});

describe("headers", () => {
  it("headers: true consumes the first row as keys", async () => {
    const rows = await parseAll<Record<string, string>>(
      "id,name\n1,alice\n2,bob\n",
      { headers: true },
    );
    expect(rows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("headers: string[] supplies keys without consuming a row", async () => {
    const rows = await parseAll<Record<string, string>>("1,alice\n", {
      headers: ["id", "name"],
    });
    expect(rows).toEqual([{ id: "1", name: "alice" }]);
  });

  it("header-only input emits zero rows", async () => {
    const rows = await parseAll("id,name\n", { headers: true });
    expect(rows).toEqual([]);
  });

  it("generic parameter types the row keys", async () => {
    interface UserRow {
      id: string;
      name: string;
    }
    const rows = await parseAll<UserRow>("1,alice\n", {
      headers: ["id", "name"],
    });
    expect(rows[0]!.name).toBe("alice");
  });
});

describe("edge shapes", () => {
  it("empty input emits zero rows", async () => {
    expect(await parseAll("")).toEqual([]);
  });

  it("a single trailing newline does not produce an empty row", async () => {
    expect(await parseAll("a\n")).toEqual([["a"]]);
  });

  it("input without a trailing newline emits the final row", async () => {
    expect(await parseAll("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("a trailing delimiter produces a trailing empty field", async () => {
    expect(await parseAll("a,b,\n")).toEqual([["a", "b", ""]]);
  });

  it("blank lines yield empty arrays by default", async () => {
    expect(await parseAll("a\n\nb\n")).toEqual([["a"], [], ["b"]]);
  });

  it("blank lines yield empty objects in record mode", async () => {
    const rows = await parseAll<Record<string, string>>("id\n\n1\n", {
      headers: true,
    });
    expect(rows).toEqual([{}, { id: "1" }]);
  });

  it("skipEmptyLines drops blank lines", async () => {
    expect(await parseAll("a\n\n\nb\n", { skipEmptyLines: true })).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("strips a UTF-8 BOM", async () => {
    expect(await parseAll("﻿a,b\n")).toEqual([["a", "b"]]);
  });
});

describe("trim", () => {
  it("trims unquoted fields only", async () => {
    const rows = await parseAll('a , "c ", d \n', { trim: true });
    // Field 2 starts with a space, so its quotes are literal (unquoted),
    // then trimmed. Field boundaries: [a][ "c "][ d ].
    expect(rows).toEqual([["a", '"c "', "d"]]);
  });

  it("does not trim inside quoted fields", async () => {
    const rows = await parseAll('" a ",b\n', { trim: true });
    expect(rows).toEqual([[" a ", "b"]]);
  });
});

describe("comments", () => {
  it("skips comment lines", async () => {
    const rows = await parseAll("# heading\na,b\n# middle\nc,d\n", {
      comment: "#",
    });
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("treats the comment character inside a quoted field as literal", async () => {
    const rows = await parseAll('"a#b",c\n', { comment: "#" });
    expect(rows).toEqual([["a#b", "c"]]);
  });

  it("treats the comment character mid-row as literal", async () => {
    const rows = await parseAll("a,#b\n", { comment: "#" });
    expect(rows).toEqual([["a", "#b"]]);
  });

  it("handles a comment on the final line without a newline", async () => {
    const rows = await parseAll("a,b\n# trailing", { comment: "#" });
    expect(rows).toEqual([["a", "b"]]);
  });
});
