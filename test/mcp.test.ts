// FastMCP integration tests — real FastMCP package on PyMode
//
// Tests the full MCP JSON-RPC 2.0 protocol over HTTP using
// FastMCP tool registration + pymode.mcp bridge.

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

describe("FastMCP", () => {
  it("imports FastMCP successfully", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
mcp = FastMCP("test")
print(f"name={mcp.name}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=test");
  });

  it("registers tools with type schemas", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
import json

mcp = FastMCP("calc")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b

@mcp.tool()
def greet(name: str, greeting: str = "Hello") -> str:
    """Greet someone."""
    return f"{greeting}, {name}!"

tools = {}
for key, comp in mcp._local_provider._components.items():
    if key.startswith("tool:"):
        tools[comp.name] = comp.parameters

print(f"tool_count={len(tools)}")
print(f"add_schema={json.dumps(tools.get('add'))}")
print(f"greet_schema={json.dumps(tools.get('greet'))}")
`);
    expect(status).toBe(200);
    expect(text).toContain("tool_count=2");

    // Verify add schema has correct types
    const addMatch = text.match(/add_schema=(.+)/);
    expect(addMatch).toBeTruthy();
    const addSchema = JSON.parse(addMatch![1]);
    expect(addSchema.properties.a.type).toBe("integer");
    expect(addSchema.properties.b.type).toBe("integer");
    expect(addSchema.required).toContain("a");

    // Verify greet schema has default
    const greetMatch = text.match(/greet_schema=(.+)/);
    expect(greetMatch).toBeTruthy();
    const greetSchema = JSON.parse(greetMatch![1]);
    expect(greetSchema.properties.name.type).toBe("string");
    expect(greetSchema.properties.greeting.default).toBe("Hello");
  });

  it("calls tools directly", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP

mcp = FastMCP("calc")

@mcp.tool()
def add(a: int, b: int) -> int:
    return a + b

@mcp.tool()
def multiply(x: float, y: float) -> float:
    return x * y

# Call via internal components
add_tool = mcp._local_provider._components["tool:add@"]
result = add_tool.fn(a=42, b=58)
print(f"add_result={result}")

mul_tool = mcp._local_provider._components["tool:multiply@"]
result2 = mul_tool.fn(x=6.0, y=7.0)
print(f"mul_result={result2}")
`);
    expect(status).toBe(200);
    expect(text).toContain("add_result=100");
    expect(text).toContain("mul_result=42.0");
  });
});

describe("MCP JSON-RPC protocol", () => {
  it("handles initialize", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("my-server")

@mcp.tool()
def hello() -> str:
    return "world"

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test"}}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
print(f"protocol={result['result']['protocolVersion']}")
print(f"server={result['result']['serverInfo']['name']}")
print(f"has_tools={'tools' in result['result']['capabilities']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("protocol=2025-03-26");
    expect(text).toContain("server=my-server");
    expect(text).toContain("has_tools=True");
  });

  it("handles tools/list", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add numbers."""
    return a + b

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
tools = result["result"]["tools"]
print(f"tool_count={len(tools)}")
print(f"tool_name={tools[0]['name']}")
print(f"has_schema={'inputSchema' in tools[0]}")
print(f"has_desc={'description' in tools[0]}")
`);
    expect(status).toBe(200);
    expect(text).toContain("tool_count=1");
    expect(text).toContain("tool_name=add");
    expect(text).toContain("has_schema=True");
    expect(text).toContain("has_desc=True");
  });

  it("handles tools/call", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

@mcp.tool()
def add(a: int, b: int) -> int:
    return a + b

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {"name": "add", "arguments": {"a": 100, "b": 200}}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
content = result["result"]["content"][0]
print(f"type={content['type']}")
print(f"text={content['text']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("type=text");
    expect(text).toContain("text=300");
  });

  it("handles tools/call with string result", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

@mcp.tool()
def greet(name: str) -> str:
    return f"Hello, {name}!"

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
    "params": {"name": "greet", "arguments": {"name": "PyMode"}}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
print(f"text={result['result']['content'][0]['text']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("text=Hello, PyMode!");
  });

  it("handles tools/call with dict result", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

@mcp.tool()
def lookup(key: str) -> dict:
    return {"key": key, "value": 42, "found": True}

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 5, "method": "tools/call",
    "params": {"name": "lookup", "arguments": {"key": "test"}}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
content_text = result["result"]["content"][0]["text"]
data = json.loads(content_text)
print(f"key={data['key']}")
print(f"value={data['value']}")
print(f"found={data['found']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("key=test");
    expect(text).toContain("value=42");
    expect(text).toContain("found=True");
  });

  it("returns error for unknown tool", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 6, "method": "tools/call",
    "params": {"name": "nonexistent", "arguments": {}}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
print(f"has_error={'error' in result}")
print(f"message={result['error']['message']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_error=True");
    expect(text).toContain("nonexistent");
  });

  it("returns error for unknown method", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 7, "method": "nonexistent/method", "params": {}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
print(f"error_code={result['error']['code']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("error_code=-32601");
  });

  it("handles ping", async () => {
    const { text, status } = await runPython(`
from fastmcp import FastMCP
from pymode.mcp import mcp_handler
from pymode.workers import Request
import json

mcp = FastMCP("test")

req = Request(method="POST", url="http://localhost/mcp", body=json.dumps({
    "jsonrpc": "2.0", "id": 8, "method": "ping", "params": {}
}))
resp = mcp_handler(mcp, req)
result = json.loads(resp.body)
print(f"id={result['id']}")
print(f"has_result={'result' in result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("id=8");
    expect(text).toContain("has_result=True");
  });
});
