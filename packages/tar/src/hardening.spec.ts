import { collectBytes, from, pipe } from "@culvert/stream";
import { describe, expect, it } from "vitest";
import {
  CHKSUM_OFFSET,
  MAGIC_OFFSET,
  SIZE_OFFSET,
} from "./constants.js";
import { TarCorruptionError } from "./errors.js";
import { readTarEntries } from "./reader.js";
import {
  computeChecksum,
  encodeUstarHeader,
  parseOctal,
  writeChecksum,
} from "./ustar.js";
import { createTar, EPOCH } from "./writer.js";

// ---------------------------------------------------------------------------
// Hostile-input hardening suite from the 2026-09-05 deep review. The
// reader faces attacker-controlled bytes; these lock in: GNU magic
// acceptance, PAX size validation (fractional values used to hang the
// reader forever), the PAX buffering cap, space-padded octal fields,
// and stream sync after path-policy rejections.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function fixChecksum(block: Uint8Array): void {
  writeChecksum(block, computeChecksum(block));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Pad data to a whole number of 512-byte blocks. */
function padded(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512);
  out.set(data);
  return out;
}

/** A PAX record: "<len> <kv>\n" where len counts the whole record. */
function paxRecord(kv: string): Uint8Array {
  let len = kv.length + 3;
  while (String(len).length + 1 + kv.length + 1 !== len) {
    len = String(len).length + 1 + kv.length + 1;
  }
  return enc.encode(`${len} ${kv}\n`);
}

function header(
  fields: Partial<Parameters<typeof encodeUstarHeader>[0]> & {
    name: string;
    typeflag: string;
    size: number;
  },
): Uint8Array {
  const h = encodeUstarHeader({
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtimeSeconds: 0,
    ...fields,
  });
  fixChecksum(h);
  return h;
}

const END = new Uint8Array(1024); // two zero blocks

async function readAll(
  bytes: Uint8Array,
  options?: Parameters<typeof readTarEntries>[1],
): Promise<Array<{ name: string; content?: string }>> {
  const out: Array<{ name: string; content?: string }> = [];
  for await (const e of readTarEntries(from([bytes]), options)) {
    if (e.kind === "file") {
      const data = await pipe(e.source, collectBytes());
      out.push({ name: e.name, content: dec.decode(data) });
    } else {
      out.push({ name: e.name });
    }
  }
  return out;
}

describe("GNU format acceptance", () => {
  it("strict accepts an archive with GNU 'ustar ' magic", async () => {
    // `tar --format=gnu` (the default on typical Linux) stores
    // 'u','s','t','a','r',' ' in the 6-byte magic field.
    const bytes = await pipe(
      createTar(async (a) => {
        await a.addFile({
          name: "x",
          source: from([enc.encode("hi")]),
          size: 2,
          lastModified: EPOCH,
        });
      }),
      collectBytes(),
    );
    const head = bytes.subarray(0, 512);
    head.set([0x75, 0x73, 0x74, 0x61, 0x72, 0x20], MAGIC_OFFSET); // "ustar "
    fixChecksum(head);

    expect(await readAll(bytes)).toEqual([{ name: "x", content: "hi" }]);
  });
});

describe("hostile PAX size values", () => {
  function paxThenFile(sizeRecord: string): Uint8Array {
    const record = paxRecord(sizeRecord);
    return concatBytes(
      header({ name: "./PaxHeaders/x", typeflag: "x", size: record.length }),
      padded(record),
      header({ name: "x", typeflag: "0", size: 1 }),
      padded(enc.encode("A")),
      END,
    );
  }

  it(
    "a fractional PAX size throws instead of hanging the reader forever",
    { timeout: 2000 },
    async () => {
      // Before the fix, size=1.5 passed validation and the entry source
      // yielded empty chunks in an unbounded loop — a DoS from a few
      // hundred bytes of input.
      await expect(readAll(paxThenFile("size=1.5"))).rejects.toThrow(
        TarCorruptionError,
      );
      await expect(readAll(paxThenFile("size=1.5"))).rejects.toThrow(/size/i);
    },
  );

  it("a valid integer PAX size still overrides", async () => {
    // Override size from a wrong header value (2) down to 1.
    const record = paxRecord("size=1");
    const bytes = concatBytes(
      header({ name: "./PaxHeaders/x", typeflag: "x", size: record.length }),
      padded(record),
      header({ name: "x", typeflag: "0", size: 1 }),
      padded(enc.encode("A")),
      END,
    );
    expect(await readAll(bytes)).toEqual([{ name: "x", content: "A" }]);
  });
});

describe("PAX extended header buffering cap", () => {
  it("rejects an extended header with an absurd declared size", async () => {
    // A declared multi-MiB PAX data section would be buffered wholesale
    // into memory before parsing — attacker-controlled OOM. The reader
    // caps it and names the cap.
    const bytes = concatBytes(
      header({ name: "./PaxHeaders/x", typeflag: "x", size: 8 * 1024 * 1024 }),
      END,
    );
    await expect(readAll(bytes)).rejects.toThrow(/extended header.*large/i);
  });
});

describe("space-padded octal fields", () => {
  it("parseOctal accepts POSIX leading spaces", () => {
    const buf = enc.encode("  5643\0 ");
    expect(parseOctal(buf, 0, 8)).toBe(0o5643);
  });

  it("reads an archive whose size field is space-padded", async () => {
    const bytes = concatBytes(
      header({ name: "x", typeflag: "0", size: 5 }),
      padded(enc.encode("hello")),
      END,
    );
    const head = bytes.subarray(0, 512);
    // Rewrite the 12-byte size field as "          5\0" (leading spaces).
    const sizeField = enc.encode("          5\0");
    head.set(sizeField, SIZE_OFFSET);
    fixChecksum(head);

    expect(await readAll(bytes)).toEqual([{ name: "x", content: "hello" }]);
  });

  it("reads an archive whose checksum field is space-padded", async () => {
    const bytes = concatBytes(
      header({ name: "x", typeflag: "0", size: 2 }),
      padded(enc.encode("ok")),
      END,
    );
    const head = bytes.subarray(0, 512);
    // Re-encode the stored checksum as "  NNNN\0 " — the historic
    // space-padded form POSIX permits and old tar tools emit.
    const value = computeChecksum(head).toString(8).padStart(4, "0");
    head.set(enc.encode(`  ${value}\0 `), CHKSUM_OFFSET);

    expect(await readAll(bytes)).toEqual([{ name: "x", content: "ok" }]);
  });
});

describe("path-policy rejection stream sync", () => {
  it(
    "rejecting a data-bearing non-file entry skips its data",
    { timeout: 2000 },
    async () => {
      // A GNU-longname-shaped entry (typeflag 'L') carries a data
      // section. Rejecting it via a function policy used to leave the
      // data unread, so the next "header" was the entry's data bytes —
      // a spurious corruption error, or worse, a forged entry.
      const linkData = new Uint8Array(512);
      linkData.set(enc.encode("some/long/name"));
      const bytes = concatBytes(
        header({ name: "././@LongLink", typeflag: "L", size: 512 }),
        linkData,
        header({ name: "ok.txt", typeflag: "0", size: 2 }),
        padded(enc.encode("hi")),
        END,
      );

      const rows = await readAll(bytes, {
        pathPolicy: (name: string) =>
          name === "ok.txt" ? name : new Error("outside allowlist"),
      });
      expect(rows).toEqual([{ name: "ok.txt", content: "hi" }]);
    },
  );
});
