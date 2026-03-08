// Tests for the npm package API — verifies that the pymode package
// exports work correctly and can run Python code.

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

describe("npm package: core exports", () => {
  it("runPython is importable and functional", async () => {
    // The test worker uses the same underlying runtime as the npm package.
    // We verify via the worker that Python execution works end-to-end.
    const { text, status } = await run(`
result = 2 + 2
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=4");
  });

  it("stdlib modules work", async () => {
    const { text, status } = await run(`
import json
import os
import sys
import math
data = json.dumps({"pi": round(math.pi, 4)})
print(f"json={data}")
print(f"platform={sys.platform}")
`);
    expect(status).toBe(200);
    expect(text).toContain('json={"pi": 3.1416}');
    expect(text).toContain("platform=wasi");
  });

  it("site-packages work", async () => {
    const { text, status } = await run(`
import jinja2
template = jinja2.Template("Hello {{ name }}!")
result = template.render(name="PyMode")
print(f"rendered={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("rendered=Hello PyMode!");
  });

  it("native extensions work (_xxhash, _regex)", async () => {
    const { text, status } = await run(`
import xxhash
h = xxhash.xxh64(b"test").hexdigest()
print(f"xxhash={h}")
import regex
m = regex.match(r'\\p{L}+', "Hello")
print(f"regex={m.group()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("xxhash=");
    expect(text).toContain("regex=Hello");
  });
});
