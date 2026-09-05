import { describe, it, expect } from "vitest";
import { pipe, from, collect, collectBytes } from "@culvert/stream";
import { csvParse, csvStringify } from "./index.js";
import type { CsvRow } from "./index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("round-trips", () => {
  it("headers-true round-trip reproduces canonical input exactly", async () => {
    const input = "id,name\r\n1,alice\r\n2,bob\r\n";
    const rows = await pipe(
      from([enc.encode(input)]),
      csvParse({ headers: true }),
      collect(),
    );
    const out = await pipe(
      from(rows),
      csvStringify({ headers: true }),
      collectBytes(),
    );
    expect(dec.decode(out)).toBe(input);
  });

  it("array-mode round-trip is byte-identical for canonical input", async () => {
    const input = 'a,b,c\r\n"x,1","y""2",z\r\n';
    const rows = await pipe(from([enc.encode(input)]), csvParse(), collect());
    const out = await pipe(from(rows), csvStringify(), collectBytes());
    expect(dec.decode(out)).toBe(input);
  });

  it("preserves quoted newlines through a round-trip", async () => {
    const original: CsvRow[] = [
      ["name", "bio"],
      ["Alice", "Loves\nhiking and chess"],
      ["Bob", "Line one\r\nline two"],
    ];
    const bytes = await pipe(from(original), csvStringify(), collectBytes());
    const rows = await pipe(from([bytes]), csvParse(), collect());
    expect(rows).toEqual(original);
  });

  it("preserves quotes and delimiters through a round-trip", async () => {
    const original: CsvRow[] = [['He said "hi", twice', "b\rc", '"']];
    const bytes = await pipe(from(original), csvStringify(), collectBytes());
    const rows = await pipe(from([bytes]), csvParse(), collect());
    expect(rows).toEqual(original);
  });

  it("stringify output pipes directly into parse", async () => {
    const original = [
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ];
    const rows = await pipe(
      from(original),
      csvStringify({ headers: true }),
      csvParse({ headers: true }),
      collect(),
    );
    expect(rows).toEqual(original);
  });
});

describe("stress", () => {
  it("handles a single row of 100k columns", async () => {
    const width = 100_000;
    const input = Array.from({ length: width }, (_, i) => `f${i}`).join(",");
    const rows = await pipe(
      from([enc.encode(input + "\n")]),
      csvParse(),
      collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(width);
    expect(rows[0]![width - 1]).toBe(`f${width - 1}`);
  });

  it("streams 100k small rows with bounded per-row work", async () => {
    const count = 100_000;
    async function* source(): AsyncGenerator<Uint8Array> {
      // Emit in 1000-row chunks to exercise chunk boundaries.
      for (let i = 0; i < count; i += 1000) {
        let text = "";
        for (let j = i; j < i + 1000; j++) {
          text += `${j},name${j},active\n`;
        }
        yield enc.encode(text);
      }
    }
    let seen = 0;
    let last: string[] | undefined;
    for await (const row of csvParse()(source())) {
      seen++;
      last = row as string[];
    }
    expect(seen).toBe(count);
    expect(last).toEqual([`${count - 1}`, `name${count - 1}`, "active"]);
  });
});
