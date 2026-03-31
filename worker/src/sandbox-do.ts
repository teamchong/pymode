/**
 * SandboxDO — Durable Object that implements the hermes-agent terminal backend API.
 *
 * Each hermes session gets its own SandboxDO instance with:
 * - Python execution via PythonDO (WASM)
 * - Persistent filesystem via R2 (survives across requests, like Modal/Daytona)
 * - Session state via embedded SQLite
 * - Parallel execution via ThreadDO pool
 *
 * API (called by CloudflareEnvironment Python client):
 *   POST /exec          — Execute command, return {output, returncode}
 *   POST /fs/read       — Read file content
 *   POST /fs/write      — Write file content
 *   POST /fs/list       — List directory
 *   POST /fs/stat       — File metadata
 *   POST /fs/mkdir      — Create directory
 *   POST /fs/delete     — Delete file
 *   GET  /status        — Sandbox health check
 *   POST /cleanup       — Flush state, optionally destroy
 */

import { DurableObject } from "cloudflare:workers";

interface SandboxEnv {
  PYTHON_DO: DurableObjectNamespace;
  THREAD_DO?: DurableObjectNamespace;
  SANDBOX_DO?: DurableObjectNamespace;
  FS_BUCKET?: R2Bucket;
  [key: string]: unknown;
}

interface ExecRequest {
  command: string;
  cwd?: string;
  timeout?: number;
  stdin_data?: string;
  env?: Record<string, string>;
}

interface ExecResult {
  output: string;
  returncode: number;
}

// Shell builtins we handle directly in the DO (no WASM needed)
// Modeled after NodeMode's tier-1 approach
const BUILTIN_COMMANDS = new Set([
  "echo", "printf", "true", "false", "pwd", "whoami", "date",
]);

export class SandboxDO extends DurableObject<SandboxEnv> {
  private cwd = "/data";
  private envVars: Record<string, string> = {};
  private initialized = false;

  /**
   * Initialize sandbox state from SQLite on first request.
   */
  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Create tables if needed
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS process_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL,
        returncode INTEGER NOT NULL,
        output_length INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Restore cwd
    const cwdRow = [...this.ctx.storage.sql.exec(
      "SELECT value FROM sandbox_state WHERE key = 'cwd'"
    )];
    if (cwdRow.length > 0) {
      this.cwd = cwdRow[0].value as string;
    }

    // Restore env vars
    const envRow = [...this.ctx.storage.sql.exec(
      "SELECT value FROM sandbox_state WHERE key = 'env'"
    )];
    if (envRow.length > 0) {
      try {
        this.envVars = JSON.parse(envRow[0].value as string);
      } catch { /* ignore corrupt state */ }
    }
  }

  private saveCwd(): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO sandbox_state (key, value) VALUES ('cwd', ?)",
      this.cwd
    );
  }

  private saveEnv(): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO sandbox_state (key, value) VALUES ('env', ?)",
      JSON.stringify(this.envVars)
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureInit();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/exec" && request.method === "POST") {
        return this.handleExec(await request.json() as ExecRequest);
      }
      if (path === "/fs/read" && request.method === "POST") {
        return this.handleFsRead(await request.json());
      }
      if (path === "/fs/write" && request.method === "POST") {
        return this.handleFsWrite(await request.json());
      }
      if (path === "/fs/list" && request.method === "POST") {
        return this.handleFsList(await request.json());
      }
      if (path === "/fs/stat" && request.method === "POST") {
        return this.handleFsStat(await request.json());
      }
      if (path === "/fs/mkdir" && request.method === "POST") {
        return this.handleFsMkdir(await request.json());
      }
      if (path === "/fs/delete" && request.method === "POST") {
        return this.handleFsDelete(await request.json());
      }
      if (path === "/status") {
        return Response.json({
          status: "running",
          cwd: this.cwd,
          id: this.ctx.id.toString(),
        });
      }
      if (path === "/cleanup" && request.method === "POST") {
        return this.handleCleanup(await request.json());
      }
      if (path === "/delegate" && request.method === "POST") {
        return this.handleDelegate(await request.json());
      }
      if (path === "/rpc" && request.method === "POST") {
        return this.handleRpc(await request.json());
      }
      if (path === "/upload" && request.method === "POST") {
        return this.handleUpload(request);
      }
      if (path === "/download" && request.method === "POST") {
        return this.handleDownload(await request.json());
      }

      return Response.json({ error: `Unknown endpoint: ${path}` }, { status: 404 });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * Execute a command — the core hermes backend interface.
   *
   * Tier 1: Shell builtins (echo, pwd) → handle in DO directly
   * Tier 2: Python code (python ...) → PythonDO.executeCode()
   * Tier 3: File operations (cat, ls, mkdir, rm) → R2 filesystem
   */
  private async handleExec(req: ExecRequest): Promise<Response> {
    const start = Date.now();
    const command = req.command.trim();
    const cwd = req.cwd || this.cwd;
    const timeout = req.timeout || 60;

    // Merge env vars
    if (req.env) {
      Object.assign(this.envVars, req.env);
      this.saveEnv();
    }

    let result: ExecResult;

    // Compound commands (pipes, &&, ||, ;, >, >>) go straight to Python
    if (/[|;&><]/.test(command) && !command.startsWith("python") && !command.startsWith("echo")) {
      result = await this.execPythonShell(command, cwd, timeout, req.stdin_data);
      return this.logAndReturn(command, result, start);
    }

    // Parse the command to determine execution tier
    const parts = parseCommand(command);
    const cmd = parts[0];

    if (cmd === "cd") {
      // cd — change working directory (persistent across calls)
      const target = parts[1] || "/data";
      this.cwd = target.startsWith("/") ? target : `${cwd}/${target}`.replace(/\/+/g, "/");
      this.saveCwd();
      result = { output: "", returncode: 0 };
    } else if (cmd === "pwd") {
      result = { output: cwd + "\n", returncode: 0 };
    } else if (cmd === "echo") {
      result = { output: parts.slice(1).join(" ") + "\n", returncode: 0 };
    } else if (cmd === "true") {
      result = { output: "", returncode: 0 };
    } else if (cmd === "false") {
      result = { output: "", returncode: 1 };
    } else if (cmd === "date") {
      result = { output: new Date().toISOString() + "\n", returncode: 0 };
    } else if (cmd === "env" || cmd === "printenv") {
      const envStr = Object.entries(this.envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      result = { output: envStr + "\n", returncode: 0 };
    } else if (cmd === "export") {
      // export VAR=value
      for (const arg of parts.slice(1)) {
        const eq = arg.indexOf("=");
        if (eq > 0) {
          this.envVars[arg.slice(0, eq)] = arg.slice(eq + 1);
        }
      }
      this.saveEnv();
      result = { output: "", returncode: 0 };
    } else if (cmd === "cat") {
      result = await this.execCat(parts.slice(1), cwd);
    } else if (cmd === "ls") {
      result = await this.execLs(parts.slice(1), cwd);
    } else if (cmd === "mkdir") {
      result = await this.execMkdir(parts.slice(1), cwd);
    } else if (cmd === "rm") {
      result = await this.execRm(parts.slice(1), cwd);
    } else if (cmd === "python" || cmd === "python3") {
      result = await this.execPython(parts, cwd, timeout, req.stdin_data);
    } else if (cmd === "pip" || cmd === "pip3") {
      // pip commands — report what's available
      result = { output: "pip: packages are pre-bundled in site-packages.zip. Use 'python -c \"import pkg\"' to check availability.\n", returncode: 0 };
    } else if (command.includes("python") || command.includes("python3")) {
      // Complex command containing python — execute as Python
      result = await this.execPythonShell(command, cwd, timeout, req.stdin_data);
    } else {
      // Unknown command — try to run as Python expression
      result = await this.execPythonShell(command, cwd, timeout, req.stdin_data);
    }

    return this.logAndReturn(command, result, start);
  }

  private logAndReturn(command: string, result: ExecResult, startTime: number): Response {
    const duration = Date.now() - startTime;
    this.ctx.storage.sql.exec(
      "INSERT INTO process_log (command, returncode, output_length, duration_ms) VALUES (?, ?, ?, ?)",
      command.slice(0, 500),
      result.returncode,
      result.output.length,
      duration,
    );
    return Response.json(result);
  }

  // ---- Tier 2: Python execution via PythonDO ----

  private async execPython(
    parts: string[],
    cwd: string,
    timeout: number,
    stdinData?: string,
  ): Promise<ExecResult> {
    // Parse python arguments
    let code = "";
    let moduleMode = false;
    let moduleName = "";

    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === "-c" && i + 1 < parts.length) {
        code = parts.slice(i + 1).join(" ");
        break;
      }
      if (parts[i] === "-m" && i + 1 < parts.length) {
        moduleMode = true;
        moduleName = parts[i + 1];
        break;
      }
      if (!parts[i].startsWith("-")) {
        // Script file — read from R2 and execute
        const scriptPath = resolvePath(parts[i], cwd);
        const content = await this.readR2File(scriptPath);
        if (content === null) {
          return { output: `python: can't open file '${parts[i]}': [Errno 2] No such file or directory\n`, returncode: 2 };
        }
        code = new TextDecoder().decode(content);
        break;
      }
    }

    if (moduleMode) {
      code = `import runpy; runpy.run_module('${moduleName}', run_name='__main__')`;
    }

    if (!code) {
      return { output: "python: no code to execute\n", returncode: 1 };
    }

    return this.runPythonCode(code, timeout);
  }

  private async execPythonShell(
    command: string,
    cwd: string,
    timeout: number,
    stdinData?: string,
  ): Promise<ExecResult> {
    // Wrap shell command as Python subprocess emulation
    const code = `
import sys, os
os.chdir('${cwd}')
try:
    exec("""${escapeForPython(command)}""")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
`;
    return this.runPythonCode(code, timeout);
  }

  private async runPythonCode(code: string, timeout: number): Promise<ExecResult> {
    const doId = this.env.PYTHON_DO.idFromName(this.ctx.id.toString());
    const pythonDO = this.env.PYTHON_DO.get(doId) as any;

    try {
      const result = await pythonDO.executeCode(code);
      const output = (result.stdout || "") + (result.stderr ? `\n${result.stderr}` : "");
      return {
        output: output || "",
        returncode: result.exitCode,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { output: `Execution error: ${msg}\n`, returncode: 1 };
    }
  }

  // ---- Tier 3: R2 filesystem operations ----

  private r2Key(path: string): string {
    return `${this.ctx.id.toString()}/${path.replace(/^\//, "")}`;
  }

  private async readR2File(path: string): Promise<Uint8Array | null> {
    const bucket = this.env.FS_BUCKET;
    if (!bucket) return null;
    const obj = await bucket.get(this.r2Key(path));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  private async writeR2File(path: string, data: Uint8Array | string): Promise<void> {
    const bucket = this.env.FS_BUCKET;
    if (!bucket) return;
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await bucket.put(this.r2Key(path), bytes);
  }

  private async deleteR2File(path: string): Promise<void> {
    const bucket = this.env.FS_BUCKET;
    if (!bucket) return;
    await bucket.delete(this.r2Key(path));
  }

  private async listR2Dir(prefix: string): Promise<{ name: string; size: number }[]> {
    const bucket = this.env.FS_BUCKET;
    if (!bucket) return [];

    const fullPrefix = this.r2Key(prefix.endsWith("/") ? prefix : prefix + "/");
    const entries: { name: string; size: number }[] = [];
    let cursor: string | undefined;

    do {
      const listed = await bucket.list({ prefix: fullPrefix, delimiter: "/", cursor });
      for (const obj of listed.objects) {
        const name = obj.key.slice(fullPrefix.length);
        if (name) entries.push({ name, size: obj.size });
      }
      // Include "directories" (common prefixes)
      if (listed.delimitedPrefixes) {
        for (const dp of listed.delimitedPrefixes) {
          const name = dp.slice(fullPrefix.length).replace(/\/$/, "");
          if (name) entries.push({ name: name + "/", size: 0 });
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return entries;
  }

  // ---- Shell command handlers (Tier 1 + filesystem) ----

  private async execCat(args: string[], cwd: string): Promise<ExecResult> {
    const outputs: string[] = [];
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const path = resolvePath(arg, cwd);
      const data = await this.readR2File(path);
      if (data === null) {
        return { output: `cat: ${arg}: No such file or directory\n`, returncode: 1 };
      }
      outputs.push(new TextDecoder().decode(data));
    }
    return { output: outputs.join(""), returncode: 0 };
  }

  private async execLs(args: string[], cwd: string): Promise<ExecResult> {
    const target = args.find(a => !a.startsWith("-")) || cwd;
    const path = resolvePath(target, cwd);
    const entries = await this.listR2Dir(path);

    if (entries.length === 0) {
      // Check if path is a file
      const data = await this.readR2File(path);
      if (data !== null) {
        return { output: path.split("/").pop() + "\n", returncode: 0 };
      }
      return { output: "", returncode: 0 };
    }

    const longFormat = args.includes("-l") || args.includes("-la") || args.includes("-al");
    if (longFormat) {
      const lines = entries.map(e => {
        const type = e.name.endsWith("/") ? "d" : "-";
        return `${type}rw-r--r--  1 root root ${String(e.size).padStart(8)} ${e.name}`;
      });
      return { output: lines.join("\n") + "\n", returncode: 0 };
    }

    return { output: entries.map(e => e.name).join("\n") + "\n", returncode: 0 };
  }

  private async execMkdir(args: string[], cwd: string): Promise<ExecResult> {
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const path = resolvePath(arg, cwd);
      // R2 doesn't need explicit dirs, but write a marker
      await this.writeR2File(path + "/.keep", "");
    }
    return { output: "", returncode: 0 };
  }

  private async execRm(args: string[], cwd: string): Promise<ExecResult> {
    const recursive = args.includes("-r") || args.includes("-rf") || args.includes("-fr");
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      const path = resolvePath(arg, cwd);
      if (recursive) {
        // Delete all files under prefix
        const entries = await this.listR2Dir(path);
        for (const entry of entries) {
          await this.deleteR2File(path + "/" + entry.name);
        }
      }
      await this.deleteR2File(path);
    }
    return { output: "", returncode: 0 };
  }

  // ---- Filesystem API handlers ----

  private async handleFsRead(body: any): Promise<Response> {
    const { path } = body;
    const data = await this.readR2File(path);
    if (data === null) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }
    // Return as base64 for binary safety
    const text = new TextDecoder().decode(data);
    return Response.json({ content: text, size: data.length });
  }

  private async handleFsWrite(body: any): Promise<Response> {
    const { path, content } = body;
    await this.writeR2File(path, content);
    return Response.json({ ok: true });
  }

  private async handleFsList(body: any): Promise<Response> {
    const { path } = body;
    const entries = await this.listR2Dir(path || "/data");
    return Response.json({ entries });
  }

  private async handleFsStat(body: any): Promise<Response> {
    const { path } = body;
    const data = await this.readR2File(path);
    if (data === null) {
      // Check if it's a directory (has children)
      const entries = await this.listR2Dir(path);
      if (entries.length > 0) {
        return Response.json({ exists: true, type: "directory", size: 0 });
      }
      return Response.json({ exists: false }, { status: 404 });
    }
    return Response.json({ exists: true, type: "file", size: data.length });
  }

  private async handleFsMkdir(body: any): Promise<Response> {
    const { path } = body;
    await this.writeR2File(path + "/.keep", "");
    return Response.json({ ok: true });
  }

  private async handleFsDelete(body: any): Promise<Response> {
    const { path, recursive } = body;
    if (recursive) {
      const entries = await this.listR2Dir(path);
      for (const entry of entries) {
        await this.deleteR2File(path + "/" + entry.name);
      }
    }
    await this.deleteR2File(path);
    return Response.json({ ok: true });
  }

  private async handleCleanup(body: any): Promise<Response> {
    const { destroy } = body || {};
    if (destroy) {
      // Delete all R2 objects for this sandbox
      const bucket = this.env.FS_BUCKET;
      if (bucket) {
        const prefix = this.ctx.id.toString() + "/";
        let cursor: string | undefined;
        do {
          const listed = await bucket.list({ prefix, cursor });
          for (const obj of listed.objects) {
            await bucket.delete(obj.key);
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      }
      // Clear SQLite + in-memory state
      this.ctx.storage.sql.exec("DELETE FROM sandbox_state");
      this.ctx.storage.sql.exec("DELETE FROM process_log");
      this.cwd = "/data";
      this.envVars = {};
    }
    return Response.json({ ok: true });
  }

  // ---- Parallel subagent delegation (replaces ThreadPoolExecutor) ----

  /**
   * Dispatch multiple commands to separate SandboxDOs in parallel.
   * Same pattern as GitMode's dispatchToPool: fan-out via Promise.all.
   *
   * Replaces hermes delegate_tool.py's ThreadPoolExecutor(max_workers=3).
   * Each task gets its own isolated SandboxDO instance.
   *
   * Request: { tasks: [{ id: string, command: string, timeout?: number }] }
   * Response: { results: [{ id: string, output: string, returncode: number, duration_ms: number }] }
   */
  private async handleDelegate(body: any): Promise<Response> {
    const { tasks } = body as {
      tasks: { id: string; command: string; timeout?: number; env?: Record<string, string> }[];
    };

    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return Response.json({ error: "tasks array required" }, { status: 400 });
    }

    // Cap concurrent children (same as hermes MAX_CONCURRENT_CHILDREN=3)
    const maxConcurrent = 3;
    const results: any[] = [];

    // Process in batches of maxConcurrent
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const batch = tasks.slice(i, i + maxConcurrent);

      const batchResults = await Promise.all(
        batch.map(async (task) => {
          const start = Date.now();
          try {
            // Each child task gets its own SandboxDO keyed by task.id
            const childId = this.env.SANDBOX_DO
              ? (this.env as any).SANDBOX_DO.idFromName(task.id)
              : null;

            if (!childId) {
              // Fallback: execute in current sandbox's PythonDO
              const result = await this.runPythonCode(task.command, task.timeout || 60);
              return {
                id: task.id,
                ...result,
                duration_ms: Date.now() - start,
              };
            }

            // Dispatch to child SandboxDO
            const childDO = (this.env as any).SANDBOX_DO.get(childId);
            const childReq = new Request("https://sandbox/exec", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                command: task.command,
                timeout: task.timeout || 60,
                env: task.env,
              }),
            });
            const childResp = await childDO.fetch(childReq);
            const childResult = await childResp.json() as ExecResult;

            return {
              id: task.id,
              ...childResult,
              duration_ms: Date.now() - start,
            };
          } catch (e: unknown) {
            return {
              id: task.id,
              output: `Delegate error: ${e instanceof Error ? e.message : String(e)}\n`,
              returncode: 1,
              duration_ms: Date.now() - start,
            };
          }
        })
      );

      results.push(...batchResults);
    }

    return Response.json({ results });
  }

  // ---- RPC endpoint (replaces Unix socket IPC for code_execution_tool) ----

  /**
   * JSON-RPC endpoint for sandboxed code calling back to parent for tool access.
   * Replaces the Unix domain socket RPC in hermes code_execution_tool.py.
   *
   * Protocol: same as hermes — {"tool": "tool_name", "args": {...}}
   * Response: {"result": value} or {"error": "..."}
   *
   * The child sandbox POSTs tool calls here; the parent resolves them
   * via its own tool registry and returns results.
   */
  private async handleRpc(body: any): Promise<Response> {
    const { tool, args } = body;

    if (!tool) {
      return Response.json({ error: "tool name required" }, { status: 400 });
    }

    // Execute the tool call as Python code in this sandbox's PythonDO
    // Tools are registered in the Python environment
    const code = `
import json, sys
try:
    from tools.registry import registry
    result = registry.call("${tool}", ${JSON.stringify(JSON.stringify(args || {}))})
    print(json.dumps({"result": result}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

    const execResult = await this.runPythonCode(code, 30);

    // Parse the JSON output
    try {
      const parsed = JSON.parse(execResult.output.trim().split("\n")[0]);
      return Response.json(parsed);
    } catch {
      return Response.json({
        result: execResult.output,
        returncode: execResult.returncode,
      });
    }
  }

  // ---- Binary file upload/download ----

  /**
   * Upload binary file to R2 via multipart or raw body.
   * POST /upload?path=data/file.bin with binary body.
   */
  private async handleUpload(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return Response.json({ error: "path query param required" }, { status: 400 });
    }
    const data = new Uint8Array(await request.arrayBuffer());
    await this.writeR2File(path, data);
    return Response.json({ ok: true, size: data.length });
  }

  /**
   * Download binary file from R2.
   * POST /download with {"path": "data/file.bin"}
   * Returns raw binary with Content-Type: application/octet-stream.
   */
  private async handleDownload(body: any): Promise<Response> {
    const { path } = body;
    const data = await this.readR2File(path);
    if (data === null) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }
    return new Response(data, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
      },
    });
  }
}

// ---- Helpers ----

function parseCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of cmd) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function resolvePath(target: string, cwd: string): string {
  if (target.startsWith("/")) return target;
  return (cwd + "/" + target).replace(/\/+/g, "/");
}

function escapeForPython(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}
