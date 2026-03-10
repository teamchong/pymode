/**
 * PythonDO — Durable Object that runs the full CPython WASM instance.
 *
 * Holds the interpreter, TCP connections, and CF binding access in one place.
 * Host-provided WASM imports (pymode.* namespace) replace the VFS trampoline.
 *
 * Async I/O uses Binaryen Asyncify: the WASM binary is instrumented at build
 * time (wasm-opt --asyncify) so that async host imports suspend/resume the
 * WASM stack in-place. Single _start() invocation, zero re-execution.
 * Python calls socket.recv() → WASM suspends → JS awaits I/O → WASM resumes.
 */

import { DurableObject } from "cloudflare:workers";
import { AsyncifyRuntime } from "./asyncify";
import pythonWasm from "./python.wasm";
import { ProcExit, createWasi } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex, extensionPackagesBin } from "./stdlib-bin";
import { buildHostImports, ASYNC_IMPORTS } from "./host-imports";
import type { MemoryAccessor } from "./host-imports";

interface PythonDOEnv {
  THREAD_DO?: DurableObjectNamespace;
  [key: string]: unknown;
}

export class PythonDO extends DurableObject<PythonDOEnv> {
  private wasmMemory: WebAssembly.Memory | null = null;

  // Thread state — spawned child DOs and their result promises
  private threadResults = new Map<number, Promise<Uint8Array>>();
  private nextThreadId = 1;

  // Dynamic loading state — loaded .wasm side modules for C extensions
  private dlModules = new Map<number, {
    instance: WebAssembly.Instance;
    exports: WebAssembly.Exports;
  }>();
  private nextDlHandle = 1;
  private dlLastError: string | null = null;

  // Pre-compiled C extension .wasm modules (set by worker before calling run())
  public extensionModules = new Map<string, WebAssembly.Module>();

  // Stored references for dynamic loading
  private wasmInstance: WebAssembly.Instance | null = null;

  private _memView: Uint8Array | null = null;
  private _memBuffer: ArrayBuffer | null = null;

  private getMemBytes(): Uint8Array {
    const buf = this.wasmMemory!.buffer;
    if (buf !== this._memBuffer) {
      this._memBuffer = buf;
      this._memView = new Uint8Array(buf);
    }
    return this._memView!;
  }

  private readString(ptr: number, len: number): string {
    return _decoder.decode(this.getMemBytes().subarray(ptr, ptr + len));
  }

  private writeBytes(ptr: number, data: Uint8Array, maxLen: number): number {
    const n = Math.min(data.length, maxLen);
    this.getMemBytes().set(data.subarray(0, n), ptr);
    return n;
  }

  private buildMemoryAccessor(): MemoryAccessor {
    return {
      getMemBytes: () => this.getMemBytes(),
      readString: (ptr, len) => this.readString(ptr, len),
      writeBytes: (ptr, data, maxLen) => this.writeBytes(ptr, data, maxLen),
    };
  }

  /**
   * Run Python in the WASM interpreter with full host imports.
   *
   * Single _start() invocation. Asyncify handles all async I/O by
   * suspending/resuming the WASM stack when async imports are called.
   * No trampoline, no re-execution.
   */
  private async run(
    args: string[],
    wasmEnv: Record<string, string>,
    userFiles?: Record<string, string>,
    stdinData?: Uint8Array,
    sitePackagesData?: ArrayBuffer,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const asyncify = new AsyncifyRuntime();

    // Build VFS from stdlib + pymode runtime (pre-encoded at module load)
    const files: Record<string, Uint8Array> = { ...stdlibBin };

    // Mount user project files
    if (userFiles) {
      for (const [path, content] of Object.entries(userFiles)) {
        files[path] = _encoder.encode(content);
      }
    }

    // Mount site-packages
    if (sitePackagesData) {
      files["site-packages.zip"] = new Uint8Array(sitePackagesData);
    }

    // Mount extension site-packages (numpy, etc.)
    if (extensionPackagesBin) {
      files["extension-site-packages.zip"] = extensionPackagesBin;
      if (wasmEnv.PYTHONPATH && !wasmEnv.PYTHONPATH.includes("extension-site-packages.zip")) {
        wasmEnv = { ...wasmEnv, PYTHONPATH: wasmEnv.PYTHONPATH + ":/stdlib/extension-site-packages.zip" };
      }
    }

    const wasi = createWasi(args, wasmEnv, files, () => this.wasmMemory!, stdinData, stdlibDirIndex);
    const self = this;

    const pymodeImports = buildHostImports({
      mem: this.buildMemoryAccessor(),
      env: this.env,
      threading: this.env.THREAD_DO ? {
        spawn: async (code: string, input: Uint8Array): Promise<number> => {
          const threadId = self.nextThreadId++;
          const doId = self.env.THREAD_DO!.newUniqueId();
          const threadDO = self.env.THREAD_DO!.get(doId) as any;
          const resultPromise = threadDO.execute(code, input)
            .then((r: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }) => r.stdout);
          self.threadResults.set(threadId, resultPromise);
          return threadId;
        },
        join: async (threadId: number, bufPtr: number, bufLen: number): Promise<number> => {
          const promise = self.threadResults.get(threadId);
          if (!promise) return -1;
          try {
            const result = await promise;
            self.threadResults.delete(threadId);
            return self.writeBytes(bufPtr, result, bufLen);
          } catch (e: unknown) {
            console.error("thread_join error:", e);
            self.threadResults.delete(threadId);
            return -1;
          }
        },
      } : undefined,
      dynamicLoading: {
        open: async (path: string): Promise<number> => {
          self.dlLastError = null;
          const basename = path.split("/").pop() || "";
          let wasmModule = self.extensionModules.get(path);
          if (!wasmModule && basename) wasmModule = self.extensionModules.get(basename);
          if (!wasmModule) {
            for (const [key, mod] of self.extensionModules) {
              if (path.endsWith(key) || (basename && key.endsWith(basename))) {
                wasmModule = mod;
                break;
              }
            }
          }
          if (!wasmModule) {
            self.dlLastError = `module not found: ${path}`;
            return -1;
          }
          try {
            const sideImports: WebAssembly.Imports = {
              env: { memory: self.wasmMemory! },
            };
            const instance = await WebAssembly.instantiate(wasmModule, sideImports);
            const handle = self.nextDlHandle++;
            self.dlModules.set(handle, { instance, exports: instance.exports });
            return handle;
          } catch (e: unknown) {
            self.dlLastError = `failed to load ${path}: ${e instanceof Error ? e.message : String(e)}`;
            return -1;
          }
        },
        sym: (handle: number, symbol: string): number => {
          const mod = self.dlModules.get(handle);
          if (!mod) { self.dlLastError = `invalid handle: ${handle}`; return 0; }
          const exported = mod.exports[symbol];
          if (typeof exported !== "function") { self.dlLastError = `symbol '${symbol}' not found`; return 0; }
          const table = self.wasmInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined;
          if (!table) { self.dlLastError = "indirect function table not available"; return 0; }
          const idx = table.length;
          table.grow(1);
          table.set(idx, exported as WebAssembly.Function);
          return idx;
        },
        close: (handle: number): void => { self.dlModules.delete(handle); },
        error: (bufPtr: number, bufLen: number): number => {
          if (!self.dlLastError) return 0;
          const encoded = _encoder.encode(self.dlLastError);
          const n = self.writeBytes(bufPtr, encoded, bufLen);
          self.dlLastError = null;
          return n;
        },
      },
    });

    // Wrap imports with Asyncify — async pymode imports will trigger
    // stack unwind/rewind automatically
    const wrappedImports = asyncify.wrapImports(
      {
        wasi_snapshot_preview1: wasi.imports,
        pymode: pymodeImports,
      },
      ASYNC_IMPORTS
    );

    // Async instantiation required — workerd blocks sync instantiation for >4MB modules.
    const result = await WebAssembly.instantiate(pythonWasm, wrappedImports);
    const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
    this.wasmInstance = instance;
    this.wasmMemory = instance.exports.memory as WebAssembly.Memory;

    // Initialize asyncify data buffer in linear memory
    asyncify.init(instance);

    let exitCode = 0;
    try {
      await asyncify.callExport("_start");
    } catch (e: unknown) {
      if (e instanceof ProcExit) exitCode = e.code;
      else throw e;
    }
    const stdout = _decoder.decode(wasi.getStdout());
    const stderr = _decoder.decode(wasi.getStderr());
    console.error(`[PythonDO] exit=${exitCode} outLen=${stdout.length} errLen=${stderr.length} out=${JSON.stringify(stdout.substring(0, 300))}`);
    return { stdout, stderr, exitCode };
  }

  /**
   * RPC entry point — execute arbitrary Python code.
   * Only serializable params (strings) cross the RPC boundary.
   */
  async executeCode(
    code: string
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return this.run(
      ["python", "-S", "-c", "import _wasi_compat\n" + code],
      { PYTHONPATH: "/stdlib", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    );
  }

  /**
   * RPC entry point — handle an HTTP request through a Python handler.
   *
   * All params are serializable (strings, plain objects) so they can
   * cross the worker→DO RPC boundary without structured clone issues.
   */
  async handleRequest(
    entryModule: string,
    userFiles: Record<string, string>,
    pythonPath: string,
    requestJson: string,
    sitePackagesData?: ArrayBuffer,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return this.run(
      ["python", "-S", "-m", "pymode._handler", entryModule],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      userFiles,
      _encoder.encode(requestJson),
      sitePackagesData,
    );
  }

  /**
   * RPC entry point — call a Python function by module path and get JSON result.
   *
   * Usage from another worker/DO:
   *   const pythonDO = env.PYTHON_DO.get(doId);
   *   const result = await pythonDO.callFunction("mymodule", "process", { data: [1, 2, 3] });
   *   // result.returnValue is the JSON-serialized return value
   */
  async callFunction(
    modulePath: string,
    functionName: string,
    args?: Record<string, unknown>,
    options?: {
      pythonPath?: string;
      sitePackagesData?: ArrayBuffer;
      userFiles?: Record<string, string>;
    },
  ): Promise<{
    returnValue: unknown;
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const argsJson = JSON.stringify(args || {});
    const code = [
      "import _wasi_compat",
      "import json, sys, importlib",
      `_mod = importlib.import_module(${JSON.stringify(modulePath)})`,
      `_fn = getattr(_mod, ${JSON.stringify(functionName)})`,
      `_args = json.loads(${JSON.stringify(argsJson)})`,
      "_result = _fn(**_args)",
      'print(json.dumps({"__pymode_return__": _result}))',
    ].join("\n");

    const pythonPath = options?.pythonPath || "/stdlib";
    const result = await this.run(
      ["python", "-S", "-c", code],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      options?.userFiles,
      undefined,
      options?.sitePackagesData,
    );

    let returnValue: unknown = null;
    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed && "__pymode_return__" in parsed) {
          returnValue = parsed.__pymode_return__;
        }
      } catch {
        // stdout wasn't valid JSON — leave returnValue as null
      }
    }

    return { returnValue, ...result };
  }

  /**
   * Clean up TCP connections when DO is evicted.
   */
  async alarm(): Promise<void> {
    this.dlModules.clear();
    this.threadResults.clear();
  }
}
