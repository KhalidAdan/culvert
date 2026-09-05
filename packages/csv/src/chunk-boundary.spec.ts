import { describe, it, expect } from "vitest";
import { pipe, from, collect } from "@culvert/stream";
import { csvParse } from "./index.js";
import type { CsvParseOptions } from "./index.js";

const enc = new TextEncoder();

function parseChunks(
  chunks: (string | Uint8Array)[],
  options?: CsvParseOptions,
): Promise<string[][]> {
  const bytes = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  return pipe(from(bytes), csvParse(options), collect());
}

/** Split a byte buffer into single-byte chunks. */
function byteAtATime(text: string): Uint8Array[] {
  const bytes = enc.encode(text);
  return Array.from(bytes, (b) => Uint8Array.of(b));
}

describe("chunk boundaries", () => {
  it("handles a quote character at a chunk boundary", async () => {
    const rows = await parseChunks(['"al', 'ice",bob\n']);
    expect(rows).toEqual([["alice", "bob"]]);
  });

  it("handles an escaped quote split across chunks", async () => {
    const rows = await parseChunks(['"a"', '"b"\n']);
    expect(rows).toEqual([['a"b']]);
  });

  it("handles CRLF split across chunks in auto mode", async () => {
    const rows = await parseChunks(["a\r", "\nb\r\n"]);
    expect(rows).toEqual([["a"], ["b"]]);
  });

  it("handles CRLF split across chunks in explicit \\r\\n mode", async () => {
    const rows = await parseChunks(["a\r", "\nb\r\n"], { newline: "\r\n" });
    expect(rows).toEqual([["a"], ["b"]]);
  });

  it("treats a trailing CR at EOF as literal in \\r\\n mode", async () => {
    const rows = await parseChunks(["a\r"], { newline: "\r\n" });
    expect(rows).toEqual([["a\r"]]);
  });

  it("treats a trailing CR at EOF as a terminator in auto mode", async () => {
    const rows = await parseChunks(["a\r"]);
    expect(rows).toEqual([["a"]]);
  });

  it("handles a multi-byte UTF-8 character split across chunks", async () => {
    const bytes = enc.encode("héllo,wörld\n"); // é and ö are two bytes each
    const mid = 2; // splits é (0xC3 0xA9) between its two bytes
    const rows = await parseChunks([bytes.slice(0, mid), bytes.slice(mid)]);
    expect(rows).toEqual([["héllo", "wörld"]]);
  });

  it("handles a UTF-8 BOM split across chunks", async () => {
    const bytes = enc.encode("﻿a,b\n"); // BOM is EF BB BF
    const rows = await parseChunks([bytes.slice(0, 1), bytes.slice(1)]);
    expect(rows).toEqual([["a", "b"]]);
  });

  it("handles a quoted newline split across chunks", async () => {
    const rows = await parseChunks(['"a\n', 'b",c\n']);
    expect(rows).toEqual([["a\nb", "c"]]);
  });

  it("parses a whole file fed one byte at a time", async () => {
    const text = 'a,b,c\r\n"x ""y""","new\nline",z\r\n#not-a-comment\r\n';
    const rows = await parseChunks(byteAtATime(text));
    expect(rows).toEqual([
      ["a", "b", "c"],
      ['x "y"', "new\nline", "z"],
      ["#not-a-comment"],
    ]);
  });

  it("ignores empty chunks", async () => {
    const rows = await parseChunks(["a,", "", "b\n"]);
    expect(rows).toEqual([["a", "b"]]);
  });
});
