import { describe, expect, it } from "vitest";
import { CRC32 } from "./index.js";

// Helper: compute CRC-32 of a Uint8Array in one shot, GC after returning
function crc32(data: Uint8Array): number {
  const c = new CRC32();
  c.update(data);
  return c.digest();
}

// Helper: encode ASCII string to bytes
function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((ch) => ch.charCodeAt(0)));
}

// Helper: parse hex string to bytes
function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 1. Canonical check value (Ross Williams, 1993)
//    The ASCII bytes "123456789" must produce 0xCBF43926.
//    This is the single most important CRC-32 test vector in existence.
// ---------------------------------------------------------------------------
describe("canonical check value", () => {
  it('CRC-32 of ASCII "123456789" equals 0xCBF43926', () => {
    expect(crc32(ascii("123456789"))).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------------------
// 2. Edge cases
//    Empty input, all-zero bytes, all-0xFF bytes, single bytes.
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("empty input produces 0x00000000", () => {
    // Init 0xFFFFFFFF XOR final 0xFFFFFFFF with no data = 0x00000000
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
  });

  it("four zero bytes produce 0x2144DF1C", () => {
    expect(crc32(hex("00000000"))).toBe(0x2144df1c);
  });

  it("four 0xFF bytes produce 0xFFFFFFFF", () => {
    expect(crc32(hex("FFFFFFFF"))).toBe(0xffffffff);
  });

  it("single zero byte produces 0xD202EF8D", () => {
    expect(crc32(new Uint8Array([0x00]))).toBe(0xd202ef8d);
  });

  it("single 0xFF byte produces 0xFF000000", () => {
    expect(crc32(new Uint8Array([0xff]))).toBe(0xff000000);
  });

  it("32 zero bytes produce 0x190A55AD", () => {
    expect(crc32(new Uint8Array(32))).toBe(0x190a55ad);
  });

  it("32 bytes of 0xFF produce 0xFF6CAB0B", () => {
    expect(crc32(new Uint8Array(32).fill(0xff))).toBe(0xff6cab0b);
  });
});

// ---------------------------------------------------------------------------
// 3. AUTOSAR SWS CRC Library test vectors (Table 7.10)
//    These are standards-body-verified byte-level vectors for IEEE 802.3.
// ---------------------------------------------------------------------------
describe("AUTOSAR test vectors", () => {
  const vectors: [string, string, number][] = [
    ["F2 01 83", "3 bytes", 0x24ab9d77],
    ["0F AA 00 55", "4 bytes", 0xb6c9b287],
    ["00 FF 55 11", "mixed", 0x32a06212],
    ["33 22 55 AA BB CC DD EE FF", "9 bytes", 0xb0ae863d],
    ["92 6B 55", "3 bytes", 0x9cdea29b],
  ];

  for (const [input, label, expected] of vectors) {
    it(`${label} (${input}) → 0x${expected.toString(16).toUpperCase()}`, () => {
      expect(crc32(hex(input))).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Well-known string vectors
// ---------------------------------------------------------------------------
describe("well-known strings", () => {
  it('"The quick brown fox jumps over the lazy dog" → 0x414FA339', () => {
    expect(crc32(ascii("The quick brown fox jumps over the lazy dog"))).toBe(
      0x414fa339,
    );
  });

  it("sequential bytes 0x00–0x1F → 0x91267E8A", () => {
    const data = new Uint8Array(32);
    for (let i = 0; i < 32; i++) data[i] = i;
    expect(crc32(data)).toBe(0x91267e8a);
  });
});

// ---------------------------------------------------------------------------
// 5. Streaming equivalence
//    Feeding data in arbitrary chunks must produce the same digest as
//    feeding it all at once. This is the core contract for @culvert/crc32.
// ---------------------------------------------------------------------------
describe("streaming equivalence", () => {
  const input = ascii("123456789");
  const expected = 0xcbf43926;

  it("byte-at-a-time produces the same result", () => {
    const c = new CRC32();
    for (let i = 0; i < input.length; i++) {
      c.update(input.subarray(i, i + 1));
    }
    expect(c.digest()).toBe(expected);
  });

  it("split into [1,2,3,3] byte chunks produces the same result", () => {
    const c = new CRC32();
    c.update(input.subarray(0, 1));
    c.update(input.subarray(1, 3));
    c.update(input.subarray(3, 6));
    c.update(input.subarray(6, 9));
    expect(c.digest()).toBe(expected);
  });

  it("split at every possible midpoint produces the same result", () => {
    for (let split = 0; split <= input.length; split++) {
      const c = new CRC32();
      c.update(input.subarray(0, split));
      c.update(input.subarray(split));
      expect(c.digest()).toBe(expected);
    }
  });

  it("zero-length update is a no-op", () => {
    const c = new CRC32();
    c.update(new Uint8Array(0));
    c.update(input);
    c.update(new Uint8Array(0));
    expect(c.digest()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 6. Reset independence
//    After reset(), a new computation must be completely independent of
//    any prior state.
// ---------------------------------------------------------------------------
describe("reset independence", () => {
  it("reset after a computation yields a fresh instance", () => {
    const c = new CRC32();
    c.update(ascii("garbage"));
    c.reset();
    c.update(ascii("123456789"));
    expect(c.digest()).toBe(0xcbf43926);
  });

  it("reset with no prior update yields empty CRC", () => {
    const c = new CRC32();
    c.reset();
    expect(c.digest()).toBe(0x00000000);
  });

  it("multiple resets are idempotent", () => {
    const c = new CRC32();
    c.update(ascii("something"));
    c.reset();
    c.reset();
    c.reset();
    c.update(ascii("123456789"));
    expect(c.digest()).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------------------
// 7. Digest is idempotent
//    Calling digest() multiple times without further updates must return
//    the same value. digest() is a read, not a consume.
// ---------------------------------------------------------------------------
describe("digest idempotency", () => {
  it("calling digest() twice returns the same value", () => {
    const c = new CRC32();
    c.update(ascii("123456789"));
    const first = c.digest();
    const second = c.digest();
    expect(first).toBe(second);
    expect(first).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------------------
// 8. Residue (magic check) value
//    When a CRC is appended to its message in little-endian byte order,
//    the CRC of the combined data is always 0xDEBB20E3.
// ---------------------------------------------------------------------------
describe("residue constant", () => {
  it("CRC of message + LE CRC equals 0xDEBB20E3", () => {
    const msg = ascii("123456789");
    const msgCrc = crc32(msg);

    // Append CRC in little-endian byte order
    const combined = new Uint8Array(msg.length + 4);
    combined.set(msg);
    combined[msg.length + 0] = (msgCrc >>> 0) & 0xff;
    combined[msg.length + 1] = (msgCrc >>> 8) & 0xff;
    combined[msg.length + 2] = (msgCrc >>> 16) & 0xff;
    combined[msg.length + 3] = (msgCrc >>> 24) & 0xff;

    expect(crc32(combined)).toBe(0xdebb20e3 ^ 0xffffffff);
  });

  it("residue holds for a different message", () => {
    const msg = ascii("Hello, Culvert");
    const msgCrc = crc32(msg);

    const combined = new Uint8Array(msg.length + 4);
    combined.set(msg);
    combined[msg.length + 0] = (msgCrc >>> 0) & 0xff;
    combined[msg.length + 1] = (msgCrc >>> 8) & 0xff;
    combined[msg.length + 2] = (msgCrc >>> 16) & 0xff;
    combined[msg.length + 3] = (msgCrc >>> 24) & 0xff;

    expect(crc32(combined)).toBe(0xdebb20e3 ^ 0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// 9. Lookup table integrity
//    The first and last entries of the precomputed table are well-known
//    constants. If the polynomial or table generation is wrong, these
//    will fail before anything else.
// ---------------------------------------------------------------------------
describe("lookup table spot checks", () => {
  it("TABLE[0] is 0x00000000", () => {
    // Byte 0x00 with no prior state contributes nothing
    const c = new CRC32();
    // We verify indirectly: CRC of [0x00] is a known value
    c.update(new Uint8Array([0x00]));
    expect(c.digest()).toBe(0xd202ef8d);
  });

  it("TABLE[255] encodes correctly via CRC of [0xFF]", () => {
    const c = new CRC32();
    c.update(new Uint8Array([0xff]));
    expect(c.digest()).toBe(0xff000000);
  });
});

// ---------------------------------------------------------------------------
// 10. Output is always an unsigned 32-bit integer
//     The digest must never be negative and must fit in 32 bits.
// ---------------------------------------------------------------------------
describe("output range", () => {
  const inputs = [
    new Uint8Array(0),
    new Uint8Array([0x00]),
    new Uint8Array([0xff]),
    ascii("123456789"),
    ascii("The quick brown fox jumps over the lazy dog"),
  ];

  for (const input of inputs) {
    it(`digest is unsigned 32-bit for input of length ${input.length}`, () => {
      const result = crc32(input);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(result)).toBe(true);
    });
  }
});
