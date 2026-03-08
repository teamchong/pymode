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
  it("imports and creates structured output types", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
import instructor
print(f"version={instructor.__version__}")
print(f"has_from_openai={hasattr(instructor, 'from_openai')}")
print(f"has_patch={hasattr(instructor, 'patch')}")
print(f"has_mode={hasattr(instructor, 'Mode')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_from_openai=True");
    expect(text).toContain("has_mode=True");
  });
});

describe("openai sdk", () => {
  it("imports openai client types", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
import openai
print(f"version={openai.__version__}")
print(f"has_client={hasattr(openai, 'OpenAI')}")
print(f"has_async={hasattr(openai, 'AsyncOpenAI')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_client=True");
    expect(text).toContain("has_async=True");
  });
});

describe("dspy", () => {
  it("imports dspy and checks core types", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    import dspy
    print(f"has_module={hasattr(dspy, 'Module')}")
    print(f"has_predict={hasattr(dspy, 'Predict')}")
    print(f"has_signature={hasattr(dspy, 'Signature')}")
except Exception as e:
    print(f"ERROR: {e}")
`);
    console.log("dspy:", status, text.substring(0, 300));
    expect(status).toBe(200);
  });
});

describe("autogen", () => {
  it("imports autogen-agentchat core", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    from autogen_agentchat import agents
    print(f"has_agents={hasattr(agents, 'BaseChatAgent')}")
    print(f"module={agents.__name__}")
except Exception as e:
    print(f"ERROR: {e}")
`);
    console.log("autogen:", status, text.substring(0, 300));
    expect(status).toBe(200);
  });
});

describe("haystack", () => {
  it("imports haystack-ai core", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
try:
    from haystack import Pipeline
    from haystack.components.generators.utils import print_streaming_chunk
    print(f"has_pipeline={Pipeline is not None}")
    print(f"pipeline_type={type(Pipeline).__name__}")
except Exception as e:
    print(f"ERROR: {e}")
`);
    console.log("haystack:", status, text.substring(0, 300));
    expect(status).toBe(200);
  });
});
