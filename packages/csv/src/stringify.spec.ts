import { describe, it, expect } from "vitest";
import { pipe, from, collectBytes } from "@culvert/stream";
import { csvStringify, CsvWriteError, CsvAbortError } from "./index.js";
import type { CsvRow, CsvStringifyOptions } from "./index.js";

async function stringifyAll(
  rows: CsvRow[],
  options?: CsvStringifyOptions,
): Promise<string> {
  const bytes = await pipe(from(rows), csvStringify(options), collectBytes());
  return new TextDecoder().decode(bytes);
}

describe("array mode", () => {
  it("emits rows with CRLF terminators by default", async () => {
    const out = await stringifyAll([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(out).toBe("a,b\r\n1,2\r\n");
  });

  it("supports \\n terminators", async () => {
    const out = await stringifyAll([["a", "b"]], { newline: "\n" });
    expect(out).toBe("a,b\n");
  });

  it("emits nothing for an empty source", async () => {
    expect(await stringifyAll([])).toBe("");
  });

  it("rejects record rows with CsvWriteError", async () => {
    await expect(stringifyAll([{ a: "1" }])).rejects.toThrow(CsvWriteError);
  });
});

describe("quoting", () => {
  it("minimal: quotes only when the field needs it", async () => {
    const out = await stringifyAll([["plain", "has,comma", 'has"quote', "has\nnewline", "has\rcr"]]);
    expect(out).toBe('plain,"has,comma","has""quote","has\nnewline","has\rcr"\r\n');
  });

  it("all: quotes every field", async () => {
    const out = await stringifyAll([["a", "b"]], { quoting: "all" });
    expect(out).toBe('"a","b"\r\n');
  });

  it("respects custom delimiter and quote", async () => {
    const out = await stringifyAll([["a;x", "b"]], {
      delimiter: ";",
      quote: "'",
    });
    expect(out).toBe("'a;x';b\r\n");
  });

  it("doubles the custom quote character", async () => {
    const out = await stringifyAll([["it's"]], { quote: "'" });
    expect(out).toBe("'it''s'\r\n");
  });
});

describe("header modes", () => {
  it("headers: true emits the first record's keys", async () => {
    const out = await stringifyAll(
      [
        { id: "1", name: "alice" },
        { id: "2", name: "bob" },
      ],
      { headers: true },
    );
    expect(out).toBe("id,name\r\n1,alice\r\n2,bob\r\n");
  });

  it("projects later records onto the first record's key set", async () => {
    const out = await stringifyAll(
      [
        { id: "1", name: "alice" },
        { name: "bob", extra: "dropped" },
      ],
      { headers: true },
    );
    expect(out).toBe("id,name\r\n1,alice\r\n,bob\r\n");
  });

  it("headers: string[] emits the supplied header row", async () => {
    const out = await stringifyAll([{ name: "alice", id: "1" }], {
      headers: ["id", "name"],
    });
    expect(out).toBe("id,name\r\n1,alice\r\n");
  });

  it("emits nothing for an empty source, not even the header", async () => {
    expect(await stringifyAll([], { headers: ["id"] })).toBe("");
  });

  it("rejects array rows with CsvWriteError", async () => {
    await expect(
      stringifyAll([["a"]], { headers: true }),
    ).rejects.toThrow(CsvWriteError);
  });
});

describe("value coercion", () => {
  it("emits empty strings for null and undefined", async () => {
    const out = await stringifyAll([
      ["a", null as unknown as string, undefined as unknown as string],
    ]);
    expect(out).toBe("a,,\r\n");
  });

  it("stringifies non-string values predictably", async () => {
    const out = await stringifyAll([[1 as unknown as string, "b"]]);
    expect(out).toBe("1,b\r\n");
  });
});

describe("abort", () => {
  it("throws CsvAbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      stringifyAll([["a"]], { signal: controller.signal }),
    ).rejects.toThrow(CsvAbortError);
  });
});
