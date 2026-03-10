// Test worker with pydantic_core statically linked.
//
// Uses python-pydantic-core.wasm (CPython + pydantic_core Rust extension)
// and site-packages.zip (pydantic's Python layer + other pure packages).

import pythonPydanticWasm from "../worker/src/python-pydantic-core.wasm";
import { stdlibFS } from "../worker/src/stdlib-fs";
import { ProcExit, createWasi } from "../worker/src/wasi";

// @ts-ignore — conditional import
import sitePackagesData from "../worker/src/site-packages.zip";

// Pre-encode stdlib files once at module load.
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();
const stdlibBin: Record<string, Uint8Array> = {};
for (const [path, content] of Object.entries(stdlibFS)) {
  stdlibBin[path] = _encoder.encode(content);
}

export default {
  async fetch(request: Request): Promise<Response> {
    const files: Record<string, Uint8Array> = { ...stdlibBin };

    let code: string;
    if (request.method === "POST") {
      code = await request.text();
    } else {
      const url = new URL(request.url);
      code = url.searchParams.get("code") || "print('Hello from PyMode with pydantic!')";
    }

    let pythonPath = "/stdlib";
    if (sitePackagesData) {
      files["site-packages.zip"] = new Uint8Array(sitePackagesData);
      pythonPath += ":/stdlib/site-packages.zip";
    }

    // WASI compat bootstrap
    code = "import _wasi_compat\n" + code;

    try {
      const result = await runWasm(
        ["python", "-S", "-c", code],
        { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", TMPDIR: "/tmp" },
        files
      );

      const stdout = _decoder.decode(result.stdout);
      const stderr = _decoder.decode(result.stderr);

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
    const pymode: Record<string, Function> = {
      dl_open: () => -1,
      dl_sym: () => 0,
      dl_close: () => {},
      dl_error: () => 0,
      tcp_connect: () => -1,
      tcp_send: () => -1,
      tcp_recv: () => -1,
      tcp_close: () => {},
      thread_spawn: () => -1,
      thread_join: () => -1,
      http_fetch_full: () => -1,
      kv_get: () => -1,
      kv_put: () => {},
      kv_delete: () => {},
      kv_multi_get: () => -1,
      kv_multi_put: () => {},
      r2_get: () => -1,
      r2_put: () => {},
      d1_exec: () => -1,
      d1_batch: () => -1,
      env_get: () => -1,
      console_log: () => {},
    };

    const asyncify: Record<string, Function> = {
      start_unwind: () => {},
      stop_unwind: () => {},
      start_rewind: () => {},
      stop_rewind: () => {},
    };

    const result = await WebAssembly.instantiate(pythonPydanticWasm, {
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
