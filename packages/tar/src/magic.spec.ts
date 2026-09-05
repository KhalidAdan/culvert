import { collectBytes, from, of, pipe } from "@culvert/stream";
import { describe, expect, it } from "vitest";
import { MAGIC_OFFSET } from "./constants.js";
import { TarCorruptionError } from "./errors.js";
import { readTarEntries } from "./reader.js";
import { computeChecksum, writeChecksum } from "./ustar.js";
import { createTar, EPOCH } from "./writer.js";

async function buildOne(): Promise<Uint8Array> {
  return await pipe(
    createTar(async (a) => {
      await a.addFile({
        name: "x",
        source: of(new Uint8Array(0)),
        size: 0,
        lastModified: EPOCH,
      });
    }),
    collectBytes(),
  );
}

/**
 * Recompute and rewrite the checksum for a header block so that
 * arbitrary modifications (e.g. to the magic field) still produce a
 * valid checksum. This lets us test magic validation independently
 * of checksum validation.
 */
function fixChecksum(block: Uint8Array): void {
  const sum = computeChecksum(block);
  writeChecksum(block, sum);
}

describe("magic validation", () => {
  it("strict (default) throws on invalid magic with valid checksum", async () => {
    const bytes = await buildOne();
    const header = bytes.subarray(0, 512);

    // Corrupt the magic field (offset 257, length 6).
    header.set([0x58, 0x58, 0x58, 0x58, 0x58, 0x58], MAGIC_OFFSET); // "XXXXXX"

    // Fix the checksum so the only problem is the magic.
    fixChecksum(header);

    const promise = (async () => {
      for await (const _ of readTarEntries(from([bytes]))) {
        // drain
      }
    })();
    await expect(promise).rejects.toThrow(TarCorruptionError);
    await expect(promise).rejects.toThrow(/magic/);
  });

  it("permissive ignores invalid magic", async () => {
    const bytes = await buildOne();
    const header = bytes.subarray(0, 512);

    header.set([0x58, 0x58, 0x58, 0x58, 0x58, 0x58], MAGIC_OFFSET); // "XXXXXX"
    fixChecksum(header);

    const out: string[] = [];
    for await (const e of readTarEntries(from([bytes]), {
      checksumPolicy: "permissive",
    })) {
      out.push(e.name);
      if (e.kind === "file") await pipe(e.source, collectBytes());
    }
    expect(out).toEqual(["x"]);
  });

  it("strict accepts POSIX ustar magic", async () => {
    // The default archive already has valid "ustar" magic.
    const bytes = await buildOne();
    const out: string[] = [];
    for await (const e of readTarEntries(from([bytes]))) {
      out.push(e.name);
      if (e.kind === "file") await pipe(e.source, collectBytes());
    }
    expect(out).toEqual(["x"]);
  });

  it("strict accepts GNU ustar-space magic", async () => {
    // GNU-format headers store 'u','s','t','a','r',' ' in the 6-byte
    // magic field (the second space and NUL live in the version field).
    // This test used to assert REJECTION under its current title,
    // masking a bug that made every `tar --format=gnu` archive fail.
    const bytes = await buildOne();
    const header = bytes.subarray(0, 512);

    header.set([0x75, 0x73, 0x74, 0x61, 0x72, 0x20], MAGIC_OFFSET); // "ustar "
    fixChecksum(header);

    const out: string[] = [];
    for await (const e of readTarEntries(from([bytes]))) {
      out.push(e.name);
      if (e.kind === "file") await pipe(e.source, collectBytes());
    }
    expect(out).toEqual(["x"]);
  });

  it("strict rejects garbage magic", async () => {
    const bytes = await buildOne();
    const header = bytes.subarray(0, 512);
    // Some random bytes that aren't any valid magic variant.
    header.set([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72], MAGIC_OFFSET); // "foobar"
    fixChecksum(header);
    const promise = (async () => {
      for await (const _ of readTarEntries(from([bytes]))) {
        // drain
      }
    })();
    await expect(promise).rejects.toThrow(TarCorruptionError);
  });
});
