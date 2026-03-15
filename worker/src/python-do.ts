/**
 * PythonDO — Durable Object that runs the full CPython WASM instance.
 *
 * Holds the interpreter, TCP connections, and CF binding access in one place.
 * Host-provided WASM imports (pymode.* namespace) replace the VFS trampoline.
 *
 * Async I/O uses fan-out replay: WASM runs synchronously, async host imports
 * record calls and return sentinels. After WASM exits, all pending async
 * calls resolve in parallel via Promise.all. A new WASM instance replays
 * with cached results. No wasm-opt --asyncify needed (~30% smaller binary).
 */

import { DurableObject } from "cloudflare:workers";
import pythonWasm from "./python.wasm";
import { ProcExit, createWasi } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex, extensionPackagesBin } from "./stdlib-bin";
import { buildHostImports, zbReadResponse } from "./host-imports";
import type { MemoryAccessor } from "./host-imports";
import { FanoutContext, resolveAll } from "./fanout";

interface PythonDOEnv {
  THREAD_DO?: DurableObjectNamespace;
  FS_BUCKET?: R2Bucket;
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

  // R2-backed filesystem: persisted /data files across requests
  private dataFiles = new Map<string, Uint8Array>();
  private dataFilesLoaded = false;

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
   * Load persisted /data files from R2 into memory.
   * Called once on first request. Subsequent requests use cached data.
   */
  private async loadDataFiles(): Promise<void> {
    if (this.dataFilesLoaded) return;
    this.dataFilesLoaded = true;

    const bucket = this.env.FS_BUCKET;
    if (!bucket) return;

    // List all objects under the DO's workspace prefix
    const prefix = this.ctx.id.toString() + "/";
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix, cursor });
      for (const obj of listed.objects) {
        const path = obj.key.slice(prefix.length); // "data/foo.txt"
        const body = await bucket.get(obj.key);
        if (body) {
          this.dataFiles.set(path, new Uint8Array(await body.arrayBuffer()));
        }
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  /**
   * Flush written /data files to R2 after handler completes.
   */
  private async flushDataFiles(writtenFiles: Map<string, Uint8Array>): Promise<void> {
    const bucket = this.env.FS_BUCKET;
    if (!bucket) return;

    const prefix = this.ctx.id.toString() + "/";

    for (const [path, data] of writtenFiles) {
      if (path.startsWith("data/")) {
        // Persist to R2
        await bucket.put(prefix + path, data);
        // Update local cache
        this.dataFiles.set(path, data);
      }
    }
  }

  /**
   * Run Python in the WASM interpreter with full host imports.
   *
   * Uses fan-out replay: WASM runs synchronously. Async host imports
   * record calls and return sentinels. After WASM exits, all pending
   * calls resolve in parallel. A new instance replays with cached results.
   * Loop until no pending calls remain.
   */
  private async run(
    args: string[],
    wasmEnv: Record<string, string>,
    userFiles?: Record<string, string>,
    stdinData?: Uint8Array,
    sitePackagesData?: ArrayBuffer,
    zerobufRequest?: { method: string; url: string; headersJson: string; body: string },
    zbExchangePtrRef?: { value: number | undefined },
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    // Load persisted /data files from R2 on first request
    await this.loadDataFiles();

    // Build VFS from stdlib + pymode runtime (pre-encoded at module load)
    const baseFiles: Record<string, Uint8Array> = { ...stdlibBin };

    // Mount user project files
    if (userFiles) {
      for (const [path, content] of Object.entries(userFiles)) {
        baseFiles[path] = _encoder.encode(content);
      }
    }

    // Mount site-packages
    if (sitePackagesData) {
      baseFiles["site-packages.zip"] = new Uint8Array(sitePackagesData);
    }

    // Mount extension site-packages (numpy, etc.)
    if (extensionPackagesBin) {
      baseFiles["extension-site-packages.zip"] = extensionPackagesBin;
      if (wasmEnv.PYTHONPATH && !wasmEnv.PYTHONPATH.includes("extension-site-packages.zip")) {
        wasmEnv = { ...wasmEnv, PYTHONPATH: wasmEnv.PYTHONPATH + ":/stdlib/extension-site-packages.zip" };
      }
    }

    // Mount persisted /data files into VFS
    for (const [path, data] of this.dataFiles) {
      baseFiles[path] = data;
    }

    const self = this;
    const fanout = new FanoutContext();
    const MAX_REPLAY_PASSES = 10;

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    let lastWrittenFiles: Map<string, Uint8Array> | null = null;

    for (let pass = 0; pass < MAX_REPLAY_PASSES; pass++) {
      fanout.resetPass();

      const files = { ...baseFiles };
      const wasi = createWasi(args, wasmEnv, files, () => this.wasmMemory!, stdinData, stdlibDirIndex);
      const zbOpts: { memory?: WebAssembly.Memory } = {};

      const pymodeImports = buildHostImports({
        mem: this.buildMemoryAccessor(),
        env: this.env,
        get memory() { return zbOpts.memory; },
        zerobufRequest,
        zbExchangePtrRef: zbExchangePtrRef,
        fanout,
        dynamicLoading: {
          open: (path: string): number => {
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
            // Dynamic loading is sync — instantiate synchronously
            try {
              const sideImports: WebAssembly.Imports = {
                env: { memory: self.wasmMemory! },
              };
              const inst = new WebAssembly.Instance(wasmModule, sideImports);
              const handle = self.nextDlHandle++;
              self.dlModules.set(handle, { instance: inst, exports: inst.exports });
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

      const imports = {
        wasi_snapshot_preview1: wasi.imports,
        pymode: pymodeImports,
      };

      // Async instantiation required — workerd blocks sync instantiation for >4MB modules.
      const result = await WebAssembly.instantiate(pythonWasm, imports);
      const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
      this.wasmInstance = instance;
      this.wasmMemory = instance.exports.memory as WebAssembly.Memory;

      // Set memory reference for JIT zerobuf allocation
      zbOpts.memory = this.wasmMemory;

      exitCode = 0;
      try {
        (instance.exports._start as Function)();
      } catch (e: unknown) {
        if (e instanceof ProcExit) exitCode = e.code;
        else throw e;
      }

      stdout = _decoder.decode(wasi.getStdout());
      stderr = _decoder.decode(wasi.getStderr());
      lastWrittenFiles = wasi.getWrittenFiles();

      // If no pending async calls, we're done
      if (!fanout.hasPending) break;

      // Resolve all pending calls in parallel, then replay
      await resolveAll(fanout, this.env as Record<string, unknown>);
    }

    // Flush written /data files to R2
    if (lastWrittenFiles && lastWrittenFiles.size > 0) {
      await this.flushDataFiles(lastWrittenFiles);
    }

    return { stdout, stderr, exitCode };
  }

  /**
   * RPC entry point — execute arbitrary Python code.
   * Only serializable params (strings) cross the RPC boundary.
   */
  async executeCode(
    code: string,
    sitePackagesData?: ArrayBuffer,
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    let pythonPath = "/stdlib";
    if (sitePackagesData) pythonPath += ":/stdlib/site-packages.zip";
    if (extensionPackagesBin) pythonPath += ":/stdlib/extension-site-packages.zip";
    return this.run(
      ["python", "-S", "-c", "import _wasi_compat\n" + code],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      undefined,
      undefined,
      sitePackagesData,
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
    // Parse the request JSON once on the JS side
    const parsed = JSON.parse(requestJson);
    const req = parsed.request || {};
    const method = req.method || "GET";
    const url = req.url || "";
    const headersJson = JSON.stringify(req.headers || {});
    const body = req.body || "";

    // Zerobuf exchange: request data is written JIT when Python calls zerobuf_exchange_ptr.
    // This avoids memory.grow before _start which lets CPython's sbrk overwrite the data.
    const zbPtrRef: { value: number | undefined } = { value: undefined };

    // Pass request via both stdin (fallback) and zerobuf (zero-copy).
    // The handler checks zerobuf first; if unavailable (binary lacks the import),
    // it reads from stdin instead.
    const stdinData = _encoder.encode(requestJson);

    const result = await this.run(
      ["python", "-S", "-m", "pymode._handler", entryModule],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      userFiles,
      stdinData,
      sitePackagesData,
      { method, url, headersJson, body },
      zbPtrRef,
    );

    // If Python wrote the response via zerobuf, the stdout will be empty
    // and the response is in the exchange region
    const zbPtr = zbPtrRef.value;
    if (result.stdout.trim() === "" && this.wasmMemory && zbPtr) {
      const zbResp = zbReadResponse(this.wasmMemory, zbPtr);
      if (zbResp.status !== 0) {
        // Reconstruct stdout JSON from zerobuf response (for deserializeResponse)
        const respHeaders = zbResp.headersJson ? JSON.parse(zbResp.headersJson) : {};
        result.stdout = JSON.stringify({
          status: zbResp.status,
          body: zbResp.body,
          headers: respHeaders,
          bodyIsBinary: zbResp.bodyIsBinary,
        });
      }
    }

    return result;
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
