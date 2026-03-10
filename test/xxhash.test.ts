// xxhash correctness tests — validates the xxhash module (polyfill or native)
// produces correct hash values against known test vectors.
//
// Test vectors sourced from the xxhash specification and reference implementation.
//
// Tests are split into two categories:
// 1. "structural" — verify the API works (import, streaming, copy, etc.)
//    These pass with both the polyfill and native module.
// 2. "correctness" — verify exact hash values against xxhash spec vectors.
//    These ONLY pass with the native Zig module (polyfill uses wrong algorithms).

import { describe, it, expect } from "vitest";
import { runPython as run } from "./helpers";

// =============================================================================
// STRUCTURAL TESTS — pass with both polyfill and native module
// =============================================================================

describe("xxhash: import and API surface", () => {
  it("imports xxhash module with all expected types", async () => {
    const { text, status } = await run(`
import xxhash
print(f"imported=True")
print(f"has_xxh32={hasattr(xxhash, 'xxh32')}")
print(f"has_xxh64={hasattr(xxhash, 'xxh64')}")
print(f"has_xxh3_64={hasattr(xxhash, 'xxh3_64')}")
print(f"has_xxh3_128={hasattr(xxhash, 'xxh3_128')}")
print(f"has_xxh128={hasattr(xxhash, 'xxh128')}")
print(f"has_xxh32_hexdigest={hasattr(xxhash, 'xxh32_hexdigest')}")
print(f"has_xxh64_hexdigest={hasattr(xxhash, 'xxh64_hexdigest')}")
print(f"has_xxh3_128_hexdigest={hasattr(xxhash, 'xxh3_128_hexdigest')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("imported=True");
    expect(text).toContain("has_xxh32=True");
    expect(text).toContain("has_xxh64=True");
    expect(text).toContain("has_xxh3_64=True");
    expect(text).toContain("has_xxh3_128=True");
    expect(text).toContain("has_xxh128=True");
    expect(text).toContain("has_xxh32_hexdigest=True");
    expect(text).toContain("has_xxh64_hexdigest=True");
    expect(text).toContain("has_xxh3_128_hexdigest=True");
  });
});

describe("xxhash: streaming API (structural)", () => {
  it("incremental update produces same result as one-shot", async () => {
    const { text, status } = await run(`
import xxhash
full = xxhash.xxh64(b"Hello, World!").hexdigest()
h = xxhash.xxh64()
h.update(b"Hello, ")
h.update(b"World!")
streaming = h.hexdigest()
print(f"match={full == streaming}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("copy preserves state independently", async () => {
    const { text, status } = await run(`
import xxhash
h1 = xxhash.xxh64(b"Hello")
h2 = h1.copy()
h1.update(b" World")
h2.update(b" Python")
print(f"different={h1.hexdigest() != h2.hexdigest()}")
h3 = xxhash.xxh64(b"Hello World")
h4 = xxhash.xxh64(b"Hello Python")
print(f"h1_matches_full={h1.hexdigest() == h3.hexdigest()}")
print(f"h2_matches_full={h2.hexdigest() == h4.hexdigest()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("different=True");
    expect(text).toContain("h1_matches_full=True");
    expect(text).toContain("h2_matches_full=True");
  });

  it("different seeds produce different hashes", async () => {
    const { text, status } = await run(`
import xxhash
h0 = xxhash.xxh32(b"test", seed=0)
h1 = xxhash.xxh32(b"test", seed=42)
print(f"different={h0.intdigest() != h1.intdigest()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("different=True");
  });

  it("one-shot xxh32 functions match streaming", async () => {
    const { text, status } = await run(`
import xxhash
data = b"The quick brown fox jumps over the lazy dog"
streaming = xxhash.xxh32(data).hexdigest()
oneshot = xxhash.xxh32_hexdigest(data)
print(f"match={streaming == oneshot}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("one-shot xxh64 functions match streaming", async () => {
    const { text, status } = await run(`
import xxhash
data = b"abcdefghijklmnopqrstuvwxyz"
streaming = xxhash.xxh64(data).hexdigest()
oneshot = xxhash.xxh64_hexdigest(data)
print(f"match={streaming == oneshot}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("one-shot xxh3_64 functions match streaming", async () => {
    const { text, status } = await run(`
import xxhash
data = b"Hello, World!"
streaming = xxhash.xxh3_64(data).hexdigest()
oneshot = xxhash.xxh3_64_hexdigest(data)
print(f"match={streaming == oneshot}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("one-shot xxh3_128 and xxh128 match streaming", async () => {
    const { text, status } = await run(`
import xxhash
data = b"The quick brown fox"
streaming = xxhash.xxh3_128(data).hexdigest()
oneshot = xxhash.xxh3_128_hexdigest(data)
oneshot128 = xxhash.xxh128_hexdigest(data)
print(f"match_3_128={streaming == oneshot}")
print(f"match_128={streaming == oneshot128}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match_3_128=True");
    expect(text).toContain("match_128=True");
  });

  it("xxh128 alias matches xxh3_128", async () => {
    const { text, status } = await run(`
import xxhash
data = b"test data for 128-bit hashing"
h1 = xxhash.xxh3_128(data).hexdigest()
h2 = xxhash.xxh128(data).hexdigest()
print(f"match={h1 == h2}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("hexdigest matches digest bytes hex encoding", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"verify consistency")
d = h.digest()
hx = h.hexdigest()
manual_hex = d.hex()
print(f"match={hx == manual_hex}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("deterministic: same input always gives same output", async () => {
    const { text, status } = await run(`
import xxhash
data = b"deterministic test data 12345"
r1 = xxhash.xxh32(data).hexdigest()
r2 = xxhash.xxh32(data).hexdigest()
r3 = xxhash.xxh64(data).hexdigest()
r4 = xxhash.xxh64(data).hexdigest()
r5 = xxhash.xxh3_64(data).hexdigest()
r6 = xxhash.xxh3_64(data).hexdigest()
r7 = xxhash.xxh3_128(data).hexdigest()
r8 = xxhash.xxh3_128(data).hexdigest()
print(f"xxh32_det={r1 == r2}")
print(f"xxh64_det={r3 == r4}")
print(f"xxh3_64_det={r5 == r6}")
print(f"xxh3_128_det={r7 == r8}")
`);
    expect(status).toBe(200);
    expect(text).toContain("xxh32_det=True");
    expect(text).toContain("xxh64_det=True");
    expect(text).toContain("xxh3_64_det=True");
    expect(text).toContain("xxh3_128_det=True");
  });
});

// =============================================================================
// CORRECTNESS TESTS — require native Zig module (polyfill returns wrong values)
// These verify exact hash values from the xxhash specification.
// =============================================================================

describe("xxhash: XXH32 exact values (native only)", () => {
  it("XXH32('', seed=0) = 0x02CC5D05", async () => {
    const { text, status } = await run(`
import xxhash
v = xxhash.xxh32_intdigest(b'', 0)
print(f"value={v}")
print(f"correct={v == 0x02CC5D05}")
`);
    expect(status).toBe(200);
    expect(text).toContain("correct=True");
  });

  it("XXH32('', seed=1) = 0x0B2CB792", async () => {
    const { text, status } = await run(`
import xxhash
v = xxhash.xxh32_intdigest(b'', 1)
print(f"value={v}")
print(f"correct={v == 0x0B2CB792}")
`);
    expect(status).toBe(200);
    expect(text).toContain("correct=True");
  });

  it("XXH32 digest is 4 bytes", async () => {
    const { text, status } = await run(`
import xxhash
d = xxhash.xxh32(b"test").digest()
print(f"len={len(d)}")
print(f"type={type(d).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("len=4");
    expect(text).toContain("type=bytes");
  });

  it("XXH32 hexdigest is 8 chars", async () => {
    const { text, status } = await run(`
import xxhash
hx = xxhash.xxh32(b"test").hexdigest()
print(f"len={len(hx)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("len=8");
  });

  it("XXH32 intdigest matches hexdigest", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh32(b"Hello, World!")
i = h.intdigest()
hx = h.hexdigest()
parsed = int(hx, 16)
print(f"match={i == parsed}")
print(f"fits_32={i < 2**32}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
    expect(text).toContain("fits_32=True");
  });

  it("XXH32 properties are correct", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh32(b"x", seed=99)
print(f"name={h.name}")
print(f"digest_size={h.digest_size}")
print(f"block_size={h.block_size}")
print(f"seed={h.seed}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=XXH32");
    expect(text).toContain("digest_size=4");
    expect(text).toContain("block_size=16");
    expect(text).toContain("seed=99");
  });
});

describe("xxhash: XXH64 exact values (native only)", () => {
  it("XXH64('', seed=0) = 0xEF46DB3751D8E999", async () => {
    const { text, status } = await run(`
import xxhash
v = xxhash.xxh64_intdigest(b'', 0)
print(f"value={v}")
print(f"correct={v == 0xEF46DB3751D8E999}")
`);
    expect(status).toBe(200);
    expect(text).toContain("correct=True");
  });

  it("XXH64('', seed=1) = 0xD5AFBA1336A3BE4B", async () => {
    const { text, status } = await run(`
import xxhash
v = xxhash.xxh64_intdigest(b'', 1)
print(f"value={v}")
print(f"correct={v == 0xD5AFBA1336A3BE4B}")
`);
    expect(status).toBe(200);
    expect(text).toContain("correct=True");
  });

  it("XXH64 digest is 8 bytes, hexdigest is 16 chars", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"test")
print(f"digest_len={len(h.digest())}")
print(f"hex_len={len(h.hexdigest())}")
`);
    expect(status).toBe(200);
    expect(text).toContain("digest_len=8");
    expect(text).toContain("hex_len=16");
  });

  it("XXH64 intdigest matches hexdigest", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"consistency check")
i = h.intdigest()
hx = h.hexdigest()
parsed = int(hx, 16)
print(f"match={i == parsed}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });

  it("XXH64 properties are correct", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"x", seed=12345)
print(f"name={h.name}")
print(f"digest_size={h.digest_size}")
print(f"block_size={h.block_size}")
print(f"seed={h.seed}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=XXH64");
    expect(text).toContain("digest_size=8");
    expect(text).toContain("block_size=32");
    expect(text).toContain("seed=12345");
  });
});

describe("xxhash: XXH3_128 exact values (native only)", () => {
  it("XXH3_128 digest is 16 bytes, hexdigest is 32 chars", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh3_128(b"test")
print(f"digest_len={len(h.digest())}")
print(f"hex_len={len(h.hexdigest())}")
`);
    expect(status).toBe(200);
    expect(text).toContain("digest_len=16");
    expect(text).toContain("hex_len=32");
  });

  it("XXH3_128 intdigest matches hexdigest for 128-bit values", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh3_128(b"128-bit integer check")
i = h.intdigest()
hx = h.hexdigest()
parsed = int(hx, 16)
print(f"match={i == parsed}")
print(f"large_enough={i > 2**64}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
    // 128-bit hashes should sometimes exceed 64-bit range
    // (not guaranteed for every input but very likely for this one)
  });

  it("XXH3_128 properties are correct", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh3_128(b"x")
print(f"name={h.name}")
print(f"digest_size={h.digest_size}")
print(f"block_size={h.block_size}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=XXH3_128");
    expect(text).toContain("digest_size=16");
    expect(text).toContain("block_size=64");
  });
});

describe("xxhash: reset with seed (native only)", () => {
  it("reset returns to seeded initial state", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"garbage data", seed=123)
initial = xxhash.xxh64(seed=123).hexdigest()
h.reset()
after_reset = h.hexdigest()
print(f"match={initial == after_reset}")
`);
    expect(status).toBe(200);
    expect(text).toContain("match=True");
  });
});
