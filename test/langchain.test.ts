// LangChain conformance tests — verifies langchain-core works in pymode.
//
// LangChain is the one heavy framework that genuinely fits Workers:
// it's an HTTP orchestration layer for LLM APIs (OpenAI, Anthropic, etc.)
//
// These tests verify core langchain-core functionality. The full import chain
// (prompts, runnables, tools) requires ~9s cold start due to the deep
// dependency graph (pydantic, langsmith, etc.), so we test lighter imports
// individually and batch heavy operations into single tests to amortize
// the import cost.
//
// Requires python-pydantic-core.wasm variant (pydantic_core Rust extension).
// Run via: npx vitest run --config vitest-pydantic.config.ts test/langchain.test.ts

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

describe("langchain-core: messages", () => {
  it("creates message types and serializes them", { timeout: 15000 }, async () => {
    const { text, status } = await run(`
from langchain_core.messages import (
    SystemMessage, HumanMessage, AIMessage, messages_to_dict
)

msgs = [
    SystemMessage(content="You are helpful."),
    HumanMessage(content="Hi there"),
    AIMessage(content="Hello! How can I help?"),
]

for m in msgs:
    print(f"{m.type}:{m.content}")
print(f"count={len(msgs)}")

# Serialize to dicts
dicts = messages_to_dict([HumanMessage(content="What is 2+2?")])
print(f"dict_type={dicts[0]['type']}")
print(f"dict_content={dicts[0]['data']['content']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("system:You are helpful.");
    expect(text).toContain("human:Hi there");
    expect(text).toContain("ai:Hello! How can I help?");
    expect(text).toContain("count=3");
    expect(text).toContain("dict_type=human");
    expect(text).toContain("dict_content=What is 2+2?");
  });
});

describe("langchain-core: documents", () => {
  it("creates and inspects Documents with metadata", { timeout: 15000 }, async () => {
    const { text, status } = await run(`
from langchain_core.documents import Document

docs = [
    Document(page_content="Python was created by Guido.", metadata={"source": "wiki", "page": 1}),
    Document(page_content="LangChain is a framework.", metadata={"source": "docs"}),
]

print(f"count={len(docs)}")
print(f"content0={docs[0].page_content}")
print(f"source0={docs[0].metadata['source']}")
print(f"page0={docs[0].metadata['page']}")
print(f"type={type(docs[0]).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=2");
    expect(text).toContain("content0=Python was created by Guido.");
    expect(text).toContain("source0=wiki");
    expect(text).toContain("page0=1");
    expect(text).toContain("type=Document");
  });
});

describe("langchain-core: utils", () => {
  it("uses langchain utils for input/output handling", { timeout: 15000 }, async () => {
    const { text, status } = await run(`
# Test langchain_core utilities that don't trigger the heavy runnables chain
from langchain_core.utils.strings import stringify_dict, stringify_value

d = {"name": "Alice", "items": [1, 2, 3]}
result = stringify_dict(d)
print(f"stringified={type(result).__name__}")
print(f"has_name={'Alice' in result}")

val = stringify_value("hello")
print(f"val={val}")
`);
    expect(status).toBe(200);
    expect(text).toContain("stringified=str");
    expect(text).toContain("has_name=True");
    expect(text).toContain("val=hello");
  });
});

describe("langchain-core: load status", () => {
  it("verifies langchain_core.load module exists", { timeout: 15000 }, async () => {
    const { text, status } = await run(`
# Test the load/dump serialization protocol
from langchain_core.load.serializable import Serializable

print(f"serializable_type={Serializable.__name__}")
print(f"has_lc_id={hasattr(Serializable, 'get_lc_namespace')}")
print(f"has_secrets={hasattr(Serializable, 'lc_secrets')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("serializable_type=Serializable");
    expect(text).toContain("has_lc_id=True");
  });
});

describe("langchain-core: version and core imports", () => {
  it("imports langchain_core and checks version", { timeout: 15000 }, async () => {
    const { text, status } = await run(`
import langchain_core
print(f"version={langchain_core.__version__}")
print(f"has_version={len(langchain_core.__version__) > 0}")

# Check that core submodules are accessible
from langchain_core import messages, documents
print(f"messages_module={messages.__name__}")
print(f"documents_module={documents.__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_version=True");
    expect(text).toContain("messages_module=langchain_core.messages");
    expect(text).toContain("documents_module=langchain_core.documents");
  });
});
