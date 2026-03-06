// Test worker for vitest-pool-workers.
//
// This is the entry point that runs inside workerd for integration tests.
// It imports the real python.wasm and stdlib-fs from the main worker,
// then uses the production WASI implementation from worker/src/wasi.ts
// to run Python code — proving the full pipeline works in the Cloudflare runtime.
//
// CF bindings (KV, R2, D1, HTTP, env) work via the _pymode.py polyfill
// which provides the same API as the production C extension. Test data
// is seeded through /stdlib/tmp/_pymode_seed.json in the VFS.

import pythonWasm from "../worker/src/python.wasm";
import { stdlibFS } from "../worker/src/stdlib-fs";
import { ProcExit, createWasi } from "../worker/src/wasi";

// Bundled third-party packages from pymode-install.py.
// Imported as a Data module (ArrayBuffer) via wrangler rules.
// @ts-ignore — conditional import
import sitePackagesData from "../worker/src/site-packages.zip";

// Re-export for cloudflare:test SELF binding
export default {
  async fetch(request: Request): Promise<Response> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Build VFS from stdlib (same as production worker)
    const files: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(stdlibFS)) {
      files[path] = encoder.encode(content);
    }

    let code: string;
    if (request.method === "POST") {
      code = await request.text();
    } else {
      const url = new URL(request.url);
      code = url.searchParams.get("code") || "print('Hello from PyMode!')";
    }

    // WASI compatibility bootstrap — runs before user code to patch
    // os functions that WASI doesn't provide (getpid, getuid, etc.)
    // Loaded from _wasi_compat module bundled in stdlib-fs.
    code = "import _wasi_compat\n" + code;

    // Mount site-packages.zip if available
    let pythonPath = "/stdlib";
    if (sitePackagesData) {
      files["site-packages.zip"] = new Uint8Array(sitePackagesData);
      pythonPath = "/stdlib:/stdlib/site-packages.zip";
    }

    // Seed _pymode polyfill with test data via VFS.
    // The _pymode.py polyfill reads this at import time to populate
    // its in-memory KV, R2, D1, and env stores.
    const seedData = {
      kv: {
        "greeting": "Hello from KV!",
        "counter": "42",
        "json-data": JSON.stringify({ users: ["alice", "bob"], count: 2 }),
      },
      r2: {
        "readme.txt": "PyMode R2 test file contents",
        "data.json": JSON.stringify({ version: 1, items: [1, 2, 3] }),
        "image.bin": {"base64": btoa(String.fromCharCode(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))},
      },
      d1: {
        users: [
          { id: 1, name: "Alice", email: "alice@example.com", age: 30 },
          { id: 2, name: "Bob", email: "bob@example.com", age: 25 },
          { id: 3, name: "Charlie", email: "charlie@example.com", age: 35 },
        ],
        products: [
          { id: 1, name: "Widget", price: 9.99, stock: 100 },
          { id: 2, name: "Gadget", price: 24.99, stock: 50 },
        ],
      },
      env: {
        TEST_SECRET: "my-secret-value",
        API_KEY: "test-api-key-12345",
        DATABASE_URL: "postgres://localhost/testdb",
      },
    };
    files["tmp/_pymode_seed.json"] = encoder.encode(JSON.stringify(seedData));

    try {
      const result = await runWasm(
        ["python", "-S", "-c", code],
        { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", TMPDIR: "/tmp" },
        files
      );

      const stdout = decoder.decode(result.stdout);
      const stderr = decoder.decode(result.stderr);

      if (result.exitCode === 0) {
        return new Response(stdout || "(empty output)\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
        });
      }

      return new Response(stdout + stderr, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      return new Response(`Error: ${msg}\n`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};

async function runWasm(
  args: string[],
  env: Record<string, string>,
  files: Record<string, Uint8Array>
): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
  let memory: WebAssembly.Memory | undefined;
  const wasi = createWasi(args, env, files, () => memory!);

  try {
    // pymode.* WASM host imports.
    // In production, these are implemented in PythonDO (JS) and called via
    // the _pymode C extension through WASM memory pointers + Asyncify.
    // In tests, the _pymode.py polyfill handles KV/R2/D1/HTTP/env entirely
    // in Python. These JS-side imports only need to exist for the WASM
    // linker — the dynload functions are used for C extension loading.
    const pymode: Record<string, Function> = {
      // Dynamic loading — used by dynload_pymode.c for C extensions
      dl_open: () => -1,
      dl_sym: () => 0,
      dl_close: () => {},
      dl_error: () => 0,
      // TCP — requires real socket server, not available in tests
      tcp_connect: () => -1,
      tcp_send: () => -1,
      tcp_recv: () => -1,
      tcp_close: () => {},
      // Threading — requires Durable Object infrastructure
      thread_spawn: () => -1,
      thread_join: () => -1,
      // These exist for WASM link compatibility but the Python polyfill
      // handles them before they'd reach the host import layer
      http_fetch: () => -1,
      http_response_status: () => 0,
      http_response_read: () => 0,
      http_response_header: () => -1,
      kv_get: () => -1,
      kv_put: () => {},
      kv_delete: () => {},
      r2_get: () => -1,
      r2_put: () => {},
      d1_exec: () => -1,
      env_get: () => -1,
      console_log: () => {},
    };

    // Asyncify runtime functions injected by wasm-opt --asyncify.
    const asyncify: Record<string, Function> = {
      start_unwind: () => {},
      stop_unwind: () => {},
      start_rewind: () => {},
      stop_rewind: () => {},
    };

    const result = await WebAssembly.instantiate(pythonWasm, {
      wasi_snapshot_preview1: wasi.imports,
      pymode,
      asyncify,
    });
    const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
    memory = instance.exports.memory as WebAssembly.Memory;
    const start = instance.exports._start as () => void;
    start();
    return {
      exitCode: 0,
      stdout: wasi.getStdout(),
      stderr: wasi.getStderr(),
    };
  } catch (e: unknown) {
    if (e instanceof ProcExit) {
      return {
        exitCode: e.code,
        stdout: wasi.getStdout(),
        stderr: wasi.getStderr(),
      };
    }
    throw e;
  }
}
