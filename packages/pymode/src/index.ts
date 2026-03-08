/**
 * PyMode — Run CPython 3.13 on Cloudflare Workers.
 *
 * Usage:
 *
 *   import { runPython } from "pymode";
 *
 *   const result = await runPython("print('hello from Python')");
 *   console.log(result.stdout); // "hello from Python\n"
 *
 * For Durable Object integration with KV/R2/D1 host imports:
 *
 *   import { PythonDO } from "pymode";
 *   export { PythonDO };
 *
 * Then call from your worker:
 *
 *   const doId = env.PYTHON_DO.idFromName("default");
 *   const pythonDO = env.PYTHON_DO.get(doId);
 *   const result = await pythonDO.executeCode('print("hello")');
 */

// Core WASI runtime
export { ProcExit, createWasi, buildDirIndex } from "./wasi";
export type { WasiResult } from "./wasi";

// Asyncify runtime for async WASM imports
export { AsyncifyRuntime } from "./asyncify";

// PythonDO — full Durable Object with CF binding host imports
export { PythonDO } from "./python-do";

// Stdlib filesystem bundle
export { stdlibFS } from "./stdlib-fs";

// WASM binary (imported as WebAssembly.Module by wrangler)
// @ts-ignore — WASM module import
import pythonWasm from "../python.wasm";
export { pythonWasm };

// Pre-encoded stdlib for direct use
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

let _stdlibBin: Record<string, Uint8Array> | null = null;
let _stdlibDirIndex: Map<string, string[]> | null = null;

function getStdlibBin(): Record<string, Uint8Array> {
  if (!_stdlibBin) {
    const { stdlibFS } = require("./stdlib-fs");
    _stdlibBin = {};
    for (const [path, content] of Object.entries(stdlibFS)) {
      _stdlibBin[path] = _encoder.encode(content as string);
    }
  }
  return _stdlibBin;
}

function getStdlibDirIndex(): Map<string, string[]> {
  if (!_stdlibDirIndex) {
    _stdlibDirIndex = buildDirIndex(getStdlibBin());
  }
  return _stdlibDirIndex;
}

export interface RunPythonResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a Python code string and return the output.
 *
 * This is the simplest way to execute Python. No KV/R2/D1 bindings —
 * for those, use PythonDO.
 *
 *   const result = await runPython("print(1 + 1)");
 *   // result.stdout === "2\n"
 */
export async function runPython(
  code: string,
  options?: {
    sitePackages?: ArrayBuffer;
    env?: Record<string, string>;
  },
): Promise<RunPythonResult> {
  const stdlibBin = getStdlibBin();
  const files: Record<string, Uint8Array> = { ...stdlibBin };

  let pythonPath = "/stdlib";
  if (options?.sitePackages) {
    files["site-packages.zip"] = new Uint8Array(options.sitePackages);
    pythonPath += ":/stdlib/site-packages.zip";
  }

  // Prepend WASI compat bootstrap
  const fullCode = "import _wasi_compat\n" + code;

  let memory: WebAssembly.Memory | undefined;
  const wasi = createWasi(
    ["python", "-S", "-c", fullCode],
    {
      PYTHONPATH: pythonPath,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      ...options?.env,
    },
    files,
    () => memory!,
    undefined,
    getStdlibDirIndex(),
  );

  try {
    const { instance } = await WebAssembly.instantiate(pythonWasm, {
      wasi_snapshot_preview1: wasi.imports,
    });
    memory = instance.exports.memory as WebAssembly.Memory;
    const start = instance.exports._start as () => void;
    start();
    return {
      exitCode: 0,
      stdout: _decoder.decode(wasi.getStdout()),
      stderr: _decoder.decode(wasi.getStderr()),
    };
  } catch (e: unknown) {
    if (e instanceof ProcExit) {
      return {
        exitCode: e.code,
        stdout: _decoder.decode(wasi.getStdout()),
        stderr: _decoder.decode(wasi.getStderr()),
      };
    }
    throw e;
  }
}
