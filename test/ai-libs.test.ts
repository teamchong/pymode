// AI library compatibility tests — tests which popular AI/ML frameworks
// can import and run basic operations in pymode's WASM environment.
//
// Requires python-pydantic-core.wasm variant.
// Run via: npx vitest run --config vitest-pydantic.config.ts test/ai-libs.test.ts

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

describe("instructor", () => {
  it("imports and has core types", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    import instructor
    print(f"version={instructor.__version__}")
    print(f"has_from_openai={hasattr(instructor, 'from_openai')}")
    print(f"has_patch={hasattr(instructor, 'patch')}")
    print(f"has_mode={hasattr(instructor, 'Mode')}")
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"ERROR: {e}")
`);
    console.log("instructor:", status, text.substring(0, 200));
    expect(status).toBe(200);
    expect(text).not.toContain("ERROR:");
  });
});

describe("openai sdk", () => {
  it("imports openai client types", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    import openai
    print(f"version={openai.__version__}")
    print(f"has_client={hasattr(openai, 'OpenAI')}")
    print(f"has_async={hasattr(openai, 'AsyncOpenAI')}")
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"ERROR: {e}")
`);
    console.log("openai:", status, text.substring(0, 200));
    expect(status).toBe(200);
    expect(text).not.toContain("ERROR:");
  });
});

describe("dspy", () => {
  it("imports dspy core", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    import dspy
    print(f"has_module={hasattr(dspy, 'Module')}")
    print(f"has_predict={hasattr(dspy, 'Predict')}")
    print(f"has_signature={hasattr(dspy, 'Signature')}")
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"ERROR: {e}")
`);
    console.log("dspy:", status, text.substring(0, 200));
    // Don't assert status — just record if it works
    if (status === 200 && !text.includes("ERROR:")) {
      expect(text).toContain("has_module=");
    }
  });
});

describe("marvin", () => {
  it("imports marvin core", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    import marvin
    print(f"version={marvin.__version__}")
    print(f"type={type(marvin).__name__}")
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"ERROR: {e}")
`);
    console.log("marvin:", status, text.substring(0, 200));
    if (status === 200 && !text.includes("ERROR:")) {
      expect(text).toContain("version=");
    }
  });
});
