// ThreadDO execution tests — verifies the child DO pattern for parallel Python.
//
// These tests validate Python execution patterns used by ThreadDO:
//   - stdin/stdout data flow
//   - pickle protocol for spawn/join
//   - JSON serialization alternative
//   - computation-heavy tasks
//   - error handling
//   - state isolation between executions

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

describe("ThreadDO execution pattern", () => {
  it("should run basic Python and capture stdout", async () => {
    const { text, status } = await runPython("print('thread-ok')");
    expect(status).toBe(200);
    expect(text).toBe("thread-ok");
  });

  it("should handle computation-heavy tasks", async () => {
    const { text, status } = await runPython(`
# Simulate a CPU-bound task a child DO might run
total = sum(i * i for i in range(10000))
print(total)
`);
    expect(status).toBe(200);
    expect(text).toBe("333283335000");
  });

  it("should handle pickle round-trip (spawn/join protocol)", async () => {
    const { text, status } = await runPython(`
import pickle

# Simulate the spawn/join protocol: pickle serialize → process → pickle serialize
task = {"a": 10, "b": 32}
pickled = pickle.dumps(task)
unpickled = pickle.loads(pickled)
result = unpickled["a"] + unpickled["b"]
output = pickle.dumps({"result": result})
final = pickle.loads(output)
print(f"result={final['result']}")
print(f"pickle_ok=True")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=42");
    expect(text).toContain("pickle_ok=True");
  });

  it("should handle errors gracefully", async () => {
    const { text, status } = await runPython(`
try:
    raise ValueError('thread error')
except ValueError as e:
    print(f"caught={e}")
`);
    expect(status).toBe(200);
    expect(text).toBe("caught=thread error");
  });

  it("should handle import errors gracefully", async () => {
    const { text, status } = await runPython(`
try:
    import nonexistent_module_xyz
    print("imported")
except ModuleNotFoundError as e:
    print(f"error={type(e).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toBe("error=ModuleNotFoundError");
  });

  it("should work with json serialization (alternative to pickle)", async () => {
    const { text, status } = await runPython(`
import json
data = {"items": [1, 2, 3, 4, 5]}
serialized = json.dumps(data)
parsed = json.loads(serialized)
result = {"sum": sum(parsed["items"]), "count": len(parsed["items"])}
print(json.dumps(result))
`);
    expect(status).toBe(200);
    const result = JSON.parse(text);
    expect(result).toEqual({ sum: 15, count: 5 });
  });

  it("should isolate state between executions", async () => {
    // First execution sets a value
    const { text: text1, status: status1 } = await runPython(`
import sys
sys.modules['__test_marker'] = True
print('set')
`);
    expect(status1).toBe(200);
    expect(text1).toBe("set");

    // Second execution should NOT see it (fresh WASM instance)
    const { text: text2, status: status2 } = await runPython(`
import sys
has_marker = '__test_marker' in sys.modules
print(f'isolated:{not has_marker}')
`);
    expect(status2).toBe(200);
    expect(text2).toBe("isolated:True");
  });
});
