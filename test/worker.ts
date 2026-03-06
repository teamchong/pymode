// Test worker for vitest-pool-workers.
//
// This is the entry point that runs inside workerd for integration tests.
// It imports the real python.wasm and stdlib-fs from the main worker,
// then uses the production WASI implementation from worker/src/wasi.ts
// to run Python code — proving the full pipeline works in the Cloudflare runtime.
//
// The production worker.ts cannot be used directly because it has conditional
// require() calls for deploy-time generated modules (user-files, site-packages.zip)
// that fail in the vitest-pool-workers module resolver. Instead, we import the
// WASM + stdlib and re-use the shared createWasi function.

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

    // Mount site-packages.zip if available
    let pythonPath = "/stdlib";
    if (sitePackagesData) {
      files["site-packages.zip"] = new Uint8Array(sitePackagesData);
      pythonPath = "/stdlib:/stdlib/site-packages.zip";
    }

    try {
      const result = await runWasm(
        ["python", "-S", "-c", code],
        { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
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
    // pymode.* host imports — test-environment implementations.
    // Production PythonDO provides real TCP, HTTP, KV, R2, D1, etc.
    // Tests run synchronous Python that doesn't call these, so they
    // return error codes indicating "not available".
    const pymode: Record<string, Function> = {
      tcp_connect: () => -1,
      tcp_send: () => -1,
      tcp_recv: () => -1,
      tcp_close: () => {},
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
      thread_spawn: () => -1,
      thread_join: () => -1,
      dl_open: () => -1,
      dl_sym: () => 0,
      dl_close: () => {},
      dl_error: () => 0,
      console_log: () => {},
    };

    // Asyncify runtime functions injected by wasm-opt --asyncify.
    // Since tests run synchronous Python, these are never invoked.
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
