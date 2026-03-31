// SandboxDO integration tests — hermes-agent CloudflareEnvironment backend
//
// Tests the sandbox API that powers the CloudflareEnvironment terminal backend.
// Each test uses a unique session ID for isolation.

import { describe, it, expect } from "vitest";

const BASE = "http://localhost:8787/sandbox";

async function post(session: string, path: string, body: any): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${BASE}/${session}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        // Wrangler may return HTML during startup — retry
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error(`Non-JSON response: ${text.slice(0, 100)}`);
      }
    } catch (e: any) {
      if (attempt < 2 && (e.message?.includes("fetch") || e.message?.includes("ECONNREFUSED"))) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error("post() exhausted retries");
}

async function get(session: string, path: string): Promise<any> {
  const resp = await fetch(`${BASE}/${session}/${path}`);
  return resp.json();
}

describe("Sandbox status", () => {
  it("returns running status", async () => {
    const result = await get("status-test", "status");
    expect(result.status).toBe("running");
    expect(result.cwd).toBe("/data");
    expect(result.id).toBeTruthy();
  });
});

describe("Sandbox exec — shell builtins", () => {
  it("handles echo", async () => {
    const result = await post("builtin-test", "exec", { command: "echo hello world" });
    expect(result.output).toBe("hello world\n");
    expect(result.returncode).toBe(0);
  });

  it("handles pwd", async () => {
    const result = await post("builtin-test", "exec", { command: "pwd" });
    expect(result.output).toContain("/data");
    expect(result.returncode).toBe(0);
  });

  it("handles cd with persistent cwd", async () => {
    await post("cd-test", "exec", { command: "cd /data/myproject" });
    const result = await post("cd-test", "exec", { command: "pwd" });
    expect(result.output.trim()).toBe("/data/myproject");
  });

  it("handles export and env", async () => {
    await post("env-test", "exec", { command: "export MY_KEY=my_value" });
    const result = await post("env-test", "exec", { command: "env" });
    expect(result.output).toContain("MY_KEY=my_value");
  });

  it("handles date", async () => {
    const result = await post("builtin-test", "exec", { command: "date" });
    expect(result.output).toMatch(/\d{4}/);
    expect(result.returncode).toBe(0);
  });

  it("handles true and false", async () => {
    const t = await post("builtin-test", "exec", { command: "true" });
    expect(t.returncode).toBe(0);
    const f = await post("builtin-test", "exec", { command: "false" });
    expect(f.returncode).toBe(1);
  });
});

describe("Sandbox exec — Python (tier 2)", () => {
  it("runs python -c", async () => {
    const result = await post("python-test", "exec", {
      command: 'python -c "print(6 * 7)"',
    });
    expect(result.output).toContain("42");
    expect(result.returncode).toBe(0);
  });

  it("runs python with imports", async () => {
    const result = await post("python-test", "exec", {
      command: 'python -c "import json; print(json.dumps({\'ok\': True}))"',
    });
    expect(result.output).toContain('{"ok": true}');
    expect(result.returncode).toBe(0);
  });

  it("imports FastMCP", async () => {
    const result = await post("python-test", "exec", {
      command: 'python -c "from fastmcp import FastMCP; print(FastMCP(\'test\').name)"',
    });
    expect(result.output).toContain("test");
    expect(result.returncode).toBe(0);
  });

  it("reports Python errors with non-zero exit", async () => {
    const result = await post("python-err-test", "exec", {
      command: "python -c 'x = 1/0'",
    });
    expect(result.returncode).not.toBe(0);
    expect(result.output).toContain("ZeroDivisionError");
  });
});

describe("Sandbox filesystem — R2", () => {
  it("writes and reads a file", async () => {
    await post("fs-test", "fs/write", {
      path: "data/hello.txt",
      content: "Hello from R2!",
    });
    const result = await post("fs-test", "fs/read", { path: "data/hello.txt" });
    expect(result.content).toBe("Hello from R2!");
    expect(result.size).toBe(14);
  });

  it("lists files", async () => {
    await post("fs-test", "fs/write", { path: "data/a.txt", content: "a" });
    await post("fs-test", "fs/write", { path: "data/b.txt", content: "b" });
    const result = await post("fs-test", "fs/list", { path: "data" });
    const names = result.entries.map((e: any) => e.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("stats a file", async () => {
    await post("fs-test", "fs/write", { path: "data/stat.txt", content: "12345" });
    const result = await post("fs-test", "fs/stat", { path: "data/stat.txt" });
    expect(result.exists).toBe(true);
    expect(result.type).toBe("file");
    expect(result.size).toBe(5);
  });

  it("deletes a file", async () => {
    await post("fs-test", "fs/write", { path: "data/deleteme.txt", content: "x" });
    await post("fs-test", "fs/delete", { path: "data/deleteme.txt" });
    const result = await post("fs-test", "fs/stat", { path: "data/deleteme.txt" });
    expect(result.exists).toBe(false);
  });

  it("cat reads files via exec", async () => {
    await post("fs-test", "fs/write", { path: "data/cattest.txt", content: "meow" });
    const result = await post("fs-test", "exec", { command: "cat /data/cattest.txt" });
    expect(result.output).toBe("meow");
    expect(result.returncode).toBe(0);
  });

  it("ls lists files via exec", async () => {
    await post("fs-test", "fs/write", { path: "data/listed.py", content: "pass" });
    const result = await post("fs-test", "exec", { command: "ls /data" });
    expect(result.output).toContain("listed.py");
  });
});

describe("Sandbox delegation — parallel execution", () => {
  it("executes multiple tasks in parallel", async () => {
    const result = await post("delegate-test", "delegate", {
      tasks: [
        { id: "child-1", command: 'python -c "print(1+1)"' },
        { id: "child-2", command: 'python -c "print(2+2)"' },
        { id: "child-3", command: "echo parallel-ok" },
      ],
    });

    expect(result.results).toHaveLength(3);

    const child1 = result.results.find((r: any) => r.id === "child-1");
    const child2 = result.results.find((r: any) => r.id === "child-2");
    const child3 = result.results.find((r: any) => r.id === "child-3");

    expect(child1.output).toContain("2");
    expect(child2.output).toContain("4");
    expect(child3.output).toContain("parallel-ok");

    // Each should have duration tracking
    expect(child1.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("Sandbox upload/download — binary files", () => {
  it("uploads and downloads binary data", async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // Upload
    const uploadResp = await fetch(
      `${BASE}/binary-test/upload?path=data/test.png`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
      }
    );
    const uploadResult = await uploadResp.json();
    expect(uploadResult.ok).toBe(true);
    expect(uploadResult.size).toBe(8);

    // Download
    const dlResp = await fetch(`${BASE}/binary-test/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "data/test.png" }),
    });
    const downloaded = new Uint8Array(await dlResp.arrayBuffer());
    expect(downloaded.length).toBe(8);
    expect(downloaded[0]).toBe(0x89);
    expect(downloaded[1]).toBe(0x50);
  });
});

describe("Sandbox cleanup", () => {
  it("persists state when not destroying", async () => {
    await post("persist-test", "exec", { command: "export KEEP_ME=yes" });
    await post("persist-test", "cleanup", { destroy: false });

    // State should still exist
    const result = await post("persist-test", "exec", { command: "env" });
    expect(result.output).toContain("KEEP_ME=yes");
  });

  it("destroys state when requested", async () => {
    await post("destroy-test", "exec", { command: "export GONE=true" });
    await post("destroy-test", "fs/write", { path: "data/gone.txt", content: "x" });
    await post("destroy-test", "cleanup", { destroy: true });

    // Env should be reset
    const envResult = await post("destroy-test", "exec", { command: "env" });
    expect(envResult.output).not.toContain("GONE");

    // File should be gone
    const statResult = await post("destroy-test", "fs/stat", { path: "data/gone.txt" });
    expect(statResult.exists).toBe(false);
  });
});
