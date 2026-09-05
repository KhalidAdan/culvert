import { describe, it, expect, vi } from "vitest";
import { pipe, from, collect } from "@culvert/stream";
import { csvParse, csvStringify, CsvSyntaxError, CsvAbortError } from "./index.js";
import type { CsvParseOptions, CsvRow } from "./index.js";

const enc = new TextEncoder();

function parseAll<T = string[]>(
  input: string | Uint8Array[],
  options?: CsvParseOptions,
): Promise<T[]> {
  const chunks = typeof input === "string" ? [enc.encode(input)] : input;
  return pipe(from(chunks), csvParse<T>(options), collect());
}

describe("unbalanced quote", () => {
  const input = '"abc\nnever closed';

  it("strict throws CsvSyntaxError", async () => {
    await expect(parseAll(input)).rejects.toThrow(CsvSyntaxError);
    await expect(parseAll(input)).rejects.toThrow(/unterminated/i);
  });

  it("permissive emits the accumulated content", async () => {
    const rows = await parseAll(input, { onMalformed: "permissive" });
    // The newline is legally inside the open quote — one row.
    expect(rows).toEqual([["abc\nnever closed"]]);
  });

  it("function form receives the error and raw text", async () => {
    const handler = vi.fn(
      (_err: CsvSyntaxError, _raw: string): CsvRow => ["substitute"],
    );
    const rows = await parseAll(input, { onMalformed: handler });
    expect(rows).toEqual([["substitute"]]);
    expect(handler).toHaveBeenCalledOnce();
    const [err, raw] = handler.mock.calls[0]!;
    expect(err).toBeInstanceOf(CsvSyntaxError);
    expect(raw).toBe('"abc\nnever closed');
  });
});

describe("data after closing quote", () => {
  const input = '"foo"bar,baz\nok,fine\n';

  it("strict throws CsvSyntaxError", async () => {
    await expect(parseAll(input)).rejects.toThrow(CsvSyntaxError);
    await expect(parseAll(input)).rejects.toThrow(/after closing quote/i);
  });

  it("permissive appends literally and keeps tokenizing", async () => {
    const rows = await parseAll(input, { onMalformed: "permissive" });
    expect(rows).toEqual([
      ["foobar", "baz"],
      ["ok", "fine"],
    ]);
  });

  it("function form recovers at the next newline", async () => {
    const seen: string[] = [];
    const rows = await parseAll(input, {
      onMalformed: (_err, raw) => {
        seen.push(raw);
        return null; // skip the malformed line
      },
    });
    expect(seen).toEqual(['"foo"bar,baz']);
    expect(rows).toEqual([["ok", "fine"]]);
  });
});

describe("header length mismatch", () => {
  const input = "a,b\n1,2,3\n4\n5,6\n";

  it("strict throws CsvSyntaxError", async () => {
    await expect(parseAll(input, { headers: true })).rejects.toThrow(
      CsvSyntaxError,
    );
    await expect(parseAll(input, { headers: true })).rejects.toThrow(
      /has 3 fields; expected 2/,
    );
  });

  it("permissive truncates extras and fills missing", async () => {
    const rows = await parseAll<Record<string, string>>(input, {
      headers: true,
      onMalformed: "permissive",
    });
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "4", b: "" },
      { a: "5", b: "6" },
    ]);
  });

  it("function form decides per row", async () => {
    const rows = await parseAll<CsvRow>(input, {
      headers: true,
      onMalformed: (err, raw) => {
        expect(err).toBeInstanceOf(CsvSyntaxError);
        return raw === "4" ? { a: "4", b: "patched" } : null;
      },
    });
    // "1,2,3" is malformed and the handler returned null for it — skipped.
    expect(rows).toEqual([
      { a: "4", b: "patched" },
      { a: "5", b: "6" },
    ]);
  });
});

describe("encoding", () => {
  it("invalid UTF-8 throws CsvSyntaxError", async () => {
    await expect(parseAll([Uint8Array.of(0xff, 0x41)])).rejects.toThrow(
      CsvSyntaxError,
    );
    await expect(parseAll([Uint8Array.of(0xff, 0x41)])).rejects.toThrow(
      /not valid UTF-8/,
    );
  });

  it("a multi-byte character truncated at EOF throws CsvSyntaxError", async () => {
    const bytes = enc.encode("aé").slice(0, 2); // 'a' + first byte of é
    await expect(parseAll([bytes])).rejects.toThrow(CsvSyntaxError);
  });
});

describe("option validation", () => {
  it("rejects multi-character delimiter", () => {
    expect(() => csvParse({ delimiter: "ab" })).toThrow(RangeError);
  });

  it("rejects delimiter equal to quote", () => {
    expect(() => csvParse({ delimiter: '"', quote: '"' })).toThrow(RangeError);
  });

  it("rejects newline characters as delimiters", () => {
    expect(() => csvParse({ delimiter: "\n" })).toThrow(RangeError);
  });

  it("rejects multi-character comment", () => {
    expect(() => csvParse({ comment: "//" })).toThrow(RangeError);
  });

  it("applies the same validation to csvStringify", () => {
    expect(() => csvStringify({ delimiter: "ab" })).toThrow(RangeError);
  });
});

describe("abort", () => {
  it("throws CsvAbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseAll("a,b\n", { signal: controller.signal }),
    ).rejects.toThrow(CsvAbortError);
  });

  it("throws CsvAbortError when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    async function* source(): AsyncGenerator<Uint8Array> {
      yield enc.encode("a,b\n");
      controller.abort();
      yield enc.encode("c,d\n");
      yield enc.encode("e,f\n");
    }
    await expect(
      pipe(source(), csvParse({ signal: controller.signal }), collect()),
    ).rejects.toThrow(CsvAbortError);
  });
});
