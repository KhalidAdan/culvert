import { describe, it, expect, vi } from "vitest";
import { collectBytes, from, pipe } from "@culvert/stream";
import type { Source } from "@culvert/stream";
import { CRC32 } from "@culvert/crc32";
import { gzip, gunzip, GzipCorruptionError } from "./index.js";
import type { GzipHeader } from "./index.js";
import { createTestDeflator, createTestInflator } from "./test-codec.js";

// ---------------------------------------------------------------------------
// onHeader — per-member header metadata observer.
//
// Contract under test (written BEFORE the implementation):
//  1. Round-trip: metadata written by gzip() surfaces in gunzip()'s
//     onHeader, including Latin-1 characters.
//  2. Absent fields are null; MTIME 0 is null ("no timestamp", which is
//     also the writer's reproducibility default).
//  3. Concatenated streams: one call per member, 0-based memberIndex,
//     each call ordered BEFORE that member's data is yielded.
//  4. Verification ordering: in strict mode a header that fails its own
//     FHCRC never reaches the callback; permissive mode still surfaces it.
//  5. Hostile input: FNAME/FCOMMENT have no declared length — a field
//     longer than 65,535 bytes without its NUL terminator is rejected,
//     with or without a callback registered.
//  6. FEXTRA payloads pass through verbatim; callback exceptions
//     propagate and tear the pipeline down.
//  7. No callback → no behavior change.
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

async function gzipBytes(
  data: Uint8Array,
  options?: Parameters<typeof gzip>[1],
): Promise<Uint8Array> {
  return pipe(from([data]), gzip(createTestDeflator(), options), collectBytes());
}

async function collectHeaders(
  bytes: Uint8Array,
  extra?: Parameters<typeof gunzip>[1],
): Promise<Array<{ header: GzipHeader; index: number }>> {
  const seen: Array<{ header: GzipHeader; index: number }> = [];
  await pipe(
    from([bytes]),
    gunzip(createTestInflator(), {
      ...extra,
      onHeader: (header, index) => seen.push({ header, index }),
    }),
    collectBytes(),
  );
  return seen;
}

describe("metadata round-trip", () => {
  it("surfaces filename, comment, and mtime written by gzip()", async () => {
    const mtime = new Date(1_700_000_000 * 1000);
    const bytes = await gzipBytes(enc("hello"), {
      filename: "report.csv",
      comment: "nightly export",
      mtime,
    });

    const seen = await collectHeaders(bytes);
    expect(seen).toHaveLength(1);
    const h = seen[0]!.header;
    expect(h.filename).toBe("report.csv");
    expect(h.comment).toBe("nightly export");
    expect(h.mtime?.getTime()).toBe(mtime.getTime());
    expect(h.os).toBe(0xff); // writer emits OS_UNKNOWN
    expect(h.xfl).toBe(0);
    expect(h.extra).toBeNull();
  });

  it("round-trips Latin-1 characters in FNAME", async () => {
    const bytes = await gzipBytes(enc("x"), { filename: "café-menü.txt" });
    const seen = await collectHeaders(bytes);
    expect(seen[0]!.header.filename).toBe("café-menü.txt");
  });

  it("reports absent fields as null, and MTIME 0 as null", async () => {
    // Default options: no filename, no comment, epoch mtime (writes 0).
    const bytes = await gzipBytes(enc("plain"));
    const seen = await collectHeaders(bytes);
    expect(seen[0]!.header.filename).toBeNull();
    expect(seen[0]!.header.comment).toBeNull();
    expect(seen[0]!.header.mtime).toBeNull();
  });
});

describe("concatenated members", () => {
  it("calls onHeader once per member with 0-based indices, before each member's data", async () => {
    const a = await gzipBytes(enc("AAAA"), { filename: "a.txt" });
    const b = await gzipBytes(enc("BBBB"), { filename: "b.txt" });
    const combined = new Uint8Array([...a, ...b]);

    const events: string[] = [];
    await pipe(
      from([combined]),
      gunzip(createTestInflator(), {
        onHeader: (h, i) => events.push(`header${i}:${h.filename}`),
      }),
      async (source: Source<Uint8Array>) => {
        for await (const chunk of source) {
          if (chunk.length > 0) events.push("data");
        }
      },
    );

    // Each header event precedes its member's data events.
    expect(events[0]).toBe("header0:a.txt");
    const header1At = events.indexOf("header1:b.txt");
    expect(header1At).toBeGreaterThan(0);
    expect(events.slice(1, header1At)).toContain("data");
    expect(events.slice(header1At + 1)).toContain("data");
  });
});

describe("verification ordering", () => {
  /** A member whose header carries an FHCRC that no longer matches. */
  async function corruptFhcrcMember(): Promise<Uint8Array> {
    const plain = await gzipBytes(enc("checked"));
    const body = plain.slice(10);
    const header = new Uint8Array(12);
    header.set(plain.slice(0, 10));
    header[3] = 0x02; // FLG: FHCRC
    const crc = new CRC32();
    crc.update(header.slice(0, 10));
    const crc16 = crc.digest() & 0xffff;
    header[10] = crc16 & 0xff;
    header[11] = (crc16 >> 8) & 0xff;
    header[9] = 0x03; // corrupt the OS byte AFTER computing the checksum
    return new Uint8Array([...header, ...body]);
  }

  it("strict mode never surfaces a header that failed its FHCRC", async () => {
    const onHeader = vi.fn();
    await expect(
      pipe(
        from([await corruptFhcrcMember()]),
        gunzip(createTestInflator(), { onHeader }),
        collectBytes(),
      ),
    ).rejects.toThrow(/header CRC/i);
    expect(onHeader).not.toHaveBeenCalled();
  });

  it("permissive mode surfaces the unverified header", async () => {
    const onHeader = vi.fn();
    await pipe(
      from([await corruptFhcrcMember()]),
      gunzip(createTestInflator(), { crcPolicy: "permissive", onHeader }),
      collectBytes(),
    );
    expect(onHeader).toHaveBeenCalledOnce();
  });
});

describe("hostile input", () => {
  function unterminatedFnameMember(length: number): Uint8Array {
    // Fixed header with FNAME flag, then `length` bytes of 'a' and no
    // NUL terminator, then EOF.
    const header = new Uint8Array(10 + length);
    header[0] = 0x1f;
    header[1] = 0x8b;
    header[2] = 8; // CM_DEFLATE
    header[3] = 0x08; // FLG: FNAME
    header.fill(0x61, 10); // 'a' * length
    return header;
  }

  it("rejects an FNAME longer than 65,535 bytes, naming the field", async () => {
    const bytes = unterminatedFnameMember(70_000);
    await expect(
      pipe(from([bytes]), gunzip(createTestInflator()), collectBytes()),
    ).rejects.toThrow(/FNAME/);
  });

  it("applies the cap identically when a callback is registered", async () => {
    const bytes = unterminatedFnameMember(70_000);
    const onHeader = vi.fn();
    await expect(
      pipe(
        from([bytes]),
        gunzip(createTestInflator(), { onHeader }),
        collectBytes(),
      ),
    ).rejects.toThrow(/FNAME/);
    expect(onHeader).not.toHaveBeenCalled();
  });
});

describe("FEXTRA", () => {
  it("passes the raw payload through verbatim", async () => {
    const plain = await gzipBytes(enc("with extra"));
    const payload = Uint8Array.of(0x41, 0x50, 4, 0, 0xde, 0xad, 0xbe, 0xef);
    const header = new Uint8Array(12 + payload.length);
    header.set(plain.slice(0, 10));
    header[3] = 0x04; // FLG: FEXTRA
    header[10] = payload.length & 0xff; // XLEN LE
    header[11] = (payload.length >> 8) & 0xff;
    header.set(payload, 12);
    const member = new Uint8Array([...header, ...plain.slice(10)]);

    const seen = await collectHeaders(member);
    expect(seen[0]!.header.extra).toEqual(payload);
  });
});

describe("observer semantics", () => {
  it("a throwing callback tears the pipeline down with its error", async () => {
    const bytes = await gzipBytes(enc("data"), { filename: "x" });
    await expect(
      pipe(
        from([bytes]),
        gunzip(createTestInflator(), {
          onHeader: () => {
            throw new Error("observer rejected this file");
          },
        }),
        collectBytes(),
      ),
    ).rejects.toThrow("observer rejected this file");
  });

  it("without onHeader, decompression is unchanged", async () => {
    const bytes = await gzipBytes(enc("no callback"), {
      filename: "still-fine.txt",
      comment: "metadata present but unobserved",
    });
    const out = await pipe(
      from([bytes]),
      gunzip(createTestInflator()),
      collectBytes(),
    );
    expect(new TextDecoder().decode(out)).toBe("no callback");
  });
});
