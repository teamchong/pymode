// Native regex module tests — verifies the real _regex C extension
// works via the regex Python package (not the polyfill).

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function run(code: string): Promise<{ text: string; status: number }> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  const text = await response.text();
  return { text: text.trim(), status: response.status };
}

describe("regex: import and basics", () => {
  it("imports regex module", async () => {
    const { text, status } = await run(`
import regex
print(f"version={regex.__version__}")
print(f"has_match={hasattr(regex, 'match')}")
print(f"has_search={hasattr(regex, 'search')}")
print(f"has_findall={hasattr(regex, 'findall')}")
print(f"has_sub={hasattr(regex, 'sub')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_match=True");
    expect(text).toContain("has_search=True");
    expect(text).toContain("has_findall=True");
    expect(text).toContain("has_sub=True");
  });

  it("uses native _regex C extension", async () => {
    const { text, status } = await run(`
import _regex
print(f"type={type(_regex).__name__}")
print(f"has_compile={hasattr(_regex, 'compile')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("type=module");
    expect(text).toContain("has_compile=True");
  });
});

describe("regex: pattern matching", () => {
  it("matches basic patterns", async () => {
    const { text, status } = await run(`
import regex
m = regex.match(r'(\\w+)\\s(\\w+)', 'Hello World')
print(f"group0={m.group(0)}")
print(f"group1={m.group(1)}")
print(f"group2={m.group(2)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("group0=Hello World");
    expect(text).toContain("group1=Hello");
    expect(text).toContain("group2=World");
  });

  it("findall works", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'\\d+', 'abc 123 def 456 ghi 789')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=['123', '456', '789']");
  });

  it("sub works", async () => {
    const { text, status } = await run(`
import regex
result = regex.sub(r'\\d+', 'NUM', 'abc 123 def 456')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=abc NUM def NUM");
  });

  it("split works", async () => {
    const { text, status } = await run(`
import regex
result = regex.split(r'[,;]+', 'one,two;;three,four')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=['one', 'two', 'three', 'four']");
  });
});

describe("regex: unicode properties", () => {
  it("supports \\p{L} letter matching", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'\\p{L}+', 'Hello 世界 Привет 123')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=['Hello', '世界', 'Привет']");
  });

  it("supports \\p{N} number matching", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'\\p{N}+', 'abc 123 ① ② ③')
print(f"result={result}")
print(f"count={len(result)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("123");
    // Unicode numbers include circled digits
  });

  it("supports \\p{Lu} uppercase matching", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'\\p{Lu}', 'Hello World')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=['H', 'W']");
  });

  it("supports \\p{Sc} currency symbol matching", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'\\p{Sc}', 'Price: $10, €20, £30')
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("$");
    expect(text).toContain("€");
    expect(text).toContain("£");
  });
});

describe("regex: advanced features", () => {
  it("supports named groups", async () => {
    const { text, status } = await run(`
import regex
m = regex.match(r'(?P<first>\\w+)\\s(?P<last>\\w+)', 'John Doe')
print(f"first={m.group('first')}")
print(f"last={m.group('last')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("first=John");
    expect(text).toContain("last=Doe");
  });

  it("supports lookahead and lookbehind", async () => {
    const { text, status } = await run(`
import regex
# Positive lookahead
result = regex.findall(r'\\w+(?=\\s*=)', 'x = 1, y = 2, z = 3')
print(f"lookahead={result}")
# Positive lookbehind
result = regex.findall(r'(?<=@)\\w+', 'user@host, admin@server')
print(f"lookbehind={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("lookahead=['x', 'y', 'z']");
    expect(text).toContain("lookbehind=['host', 'server']");
  });

  it("supports compiled patterns", async () => {
    const { text, status } = await run(`
import regex
pat = regex.compile(r'(\\d{4})-(\\d{2})-(\\d{2})')
m = pat.match('2024-01-15')
print(f"year={m.group(1)}")
print(f"month={m.group(2)}")
print(f"day={m.group(3)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("year=2024");
    expect(text).toContain("month=01");
    expect(text).toContain("day=15");
  });

  it("supports IGNORECASE flag", async () => {
    const { text, status } = await run(`
import regex
result = regex.findall(r'hello', 'Hello HELLO hello', regex.IGNORECASE)
print(f"count={len(result)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=3");
  });

  it("supports fuzzy matching", async () => {
    const { text, status } = await run(`
import regex
# Allow up to 1 error (insertion, deletion, substitution)
m = regex.match(r'(?:hello){e<=1}', 'helo')
print(f"matched={m is not None}")
if m:
    print(f"match={m.group()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("matched=True");
    expect(text).toContain("match=helo");
  });
});

describe("regex: used by real packages", () => {
  it("tiktoken can import regex", async () => {
    const { text, status } = await run(`
import regex
# tiktoken uses regex for BPE tokenization patterns
pat = regex.compile(r"""'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+""")
tokens = pat.findall("Hello, world! I'm testing.")
print(f"count={len(tokens)}")
print(f"has_hello={'Hello' in [t.strip() for t in tokens]}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_hello=True");
  });
});
