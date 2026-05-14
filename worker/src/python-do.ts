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
import { getPythonWasm } from "./python-wasm-loader";
import { ProcExit, createWasi, makeWasiState, type WasiState } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex, getExtensionPackagesBin, getSitePackagesBin, getStdlibBin, warmExtensionPackages, warmSitePackages } from "./stdlib-bin";
import { buildHostImports, zbReadResponse } from "./host-imports";
import type { MemoryAccessor } from "./host-imports";
import { FanoutContext, resolveAll } from "./fanout";

// Site-packages are now fetched via env.ASSETS at request time (see
// warmSitePackages call in handleRequest). The DO runs in its own
// isolate from the entry worker, so it warms separately.

// Pre-compiled side modules for C extensions that go through the
// pymode.dl_open path (numpy, etc). Each is bundled twice:
//   1. As CompiledWasm (`.wasm`) — JS instantiates this with WebAssembly.Instance.
//   2. As a Data module (`.wasm.dat` — sibling copy of the same bytes) so the
//      dynamic linker can read the dylink.0 custom section + import list at
//      runtime. wrangler's Data rule matches `.dat`, CompiledWasm matches `.wasm`,
//      so we can have both for the same logical artifact.
// @ts-ignore — CompiledWasm Data module import
import numpyMultiarrayUmath from "./extensions/numpy/_multiarray_umath.wasm";
// @ts-ignore — Data module import (ArrayBuffer)
import numpyMultiarrayUmathBytes from "./extensions/numpy/_multiarray_umath.wasm.dat";
import { linkSideModule } from "./dynamic-linker";

interface SideModuleEntry { module: WebAssembly.Module; bytes: Uint8Array }
function _sideEntry(mod: unknown, bytes: unknown): SideModuleEntry {
  return {
    module: mod as WebAssembly.Module,
    bytes: bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : (bytes as Uint8Array),
  };
}
const _extensionModules: ReadonlyMap<string, SideModuleEntry> = new Map([
  ["_multiarray_umath.wasm", _sideEntry(numpyMultiarrayUmath, numpyMultiarrayUmathBytes)],
  ["numpy/_core/_multiarray_umath.wasm", _sideEntry(numpyMultiarrayUmath, numpyMultiarrayUmathBytes)],
]);

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

  // Pre-compiled C extension .wasm modules. Seeded from the module-level
  // _extensionModules (bundled by wrangler), settable by worker for tests.
  // Each entry has both the CompiledWasm Module (for instantiation) and
  // the raw bytes (for dylink.0 parsing by the dynamic linker).
  public extensionModules = new Map<string, SideModuleEntry>(_extensionModules);

  // Stored references for dynamic loading
  private wasmInstance: WebAssembly.Instance | null = null;

  /**
   * Persistent runner — when the previous request completed without
   * registering a pending fanout call, we cache the wasm instance + the
   * wasi state object so the next request can just reset stdin/stdout
   * and call _start() again. This avoids the ~30–50 ms per-request
   * instantiation + data-segment copy cost.
   *
   * Reused across requests as long as the user-files set is stable.
   * Fanout-using requests fall back to the original per-pass fresh-
   * instance path because the fanout context needs per-pass replay.
   */
  private persistentRunner: {
    instance: WebAssembly.Instance;
    wasiState: WasiState;
    wasi: ReturnType<typeof createWasi>;
    /** Hash of the user-files set used at instantiation time. If a
     *  later request has different user files, we invalidate. */
    userFilesKey: string;
    /** Wasm __stack_pointer value captured after first _start() returns.
     *  Reset to this before each subsequent _start() so wasi-libc's
     *  one-shot _start wrapper sees a fresh stack. */
    initialStackPointer?: number;
  } | null = null;

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

    // Mount site-packages — explicit RPC payload wins (legacy path),
    // otherwise fall back to the assets-warmed copy.
    if (sitePackagesData) {
      baseFiles["site-packages.zip"] = new Uint8Array(sitePackagesData);
    } else {
      const sp = getSitePackagesBin();
      if (sp) baseFiles["site-packages.zip"] = sp;
    }

    // Mount extension site-packages (numpy, etc.)
    const _extBin = getExtensionPackagesBin();
    if (_extBin) {
      baseFiles["extension-site-packages.zip"] = _extBin;
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

    // ── Persistent fast path ────────────────────────────────────────
    // Reuse a cached wasm Instance across requests when the user-files
    // set hasn't changed. Skips the ~100ms memcpy of the 20MB wizer
    // snapshot into a fresh linear memory.
    //
    // Known issue: second _start() call can trap with
    // "RuntimeError: unreachable". When that happens we capture stderr
    // for diagnostic output and fall back to a fresh instance.
    const userFilesKey = userFiles
      ? Object.keys(userFiles).sort().join("\n")
      : "";
    // Recover the entry module from args: python -S -m pymode._handler <entryModule>.
    const mIdx = args.indexOf("-m");
    const entryModule = mIdx >= 0 && mIdx + 2 < args.length ? args[mIdx + 2] : "";
    const warmRunFn = this.persistentRunner?.instance.exports.pymode_warm_run as
      ((ptr: number, len: number) => number) | undefined;
    if (this.persistentRunner && this.persistentRunner.userFilesKey === userFilesKey && warmRunFn && entryModule) {
      const { instance, wasiState, wasi, initialStackPointer } = this.persistentRunner;
      // Reset per-request state.
      wasiState.stdinData = stdinData;
      wasiState.stdinOffset = 0;
      wasiState.stdoutChunks.length = 0;
      wasiState.stderrChunks.length = 0;
      wasiState.exited = false;
      wasiState.exitCode = 0;
      // Reset wasm stack pointer in case it was clobbered by a prior
      // call that exited via proc_exit (which throws mid-function).
      const sp = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
      if (sp && initialStackPointer !== undefined) {
        sp.value = initialStackPointer;
      }
      let trapped = false;
      let warmExitCode = 0;
      try {
        // pymode_warm_run does runpy.run_module(<entryModule>) without
        // going through wasi-libc's one-shot _start wrapper. We pass
        // the module name via a malloc'd buffer.
        const enc = _encoder.encode(entryModule);
        const malloc = instance.exports.PyMem_RawMalloc as ((n: number) => number);
        const free = instance.exports.PyMem_RawFree as ((p: number) => void);
        const ptr = malloc(enc.length);
        const memBytes = new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);
        memBytes.set(enc, ptr);
        try {
          warmExitCode = warmRunFn(ptr, enc.length);
        } finally {
          free(ptr);
        }
      } catch (e) {
        const trapStderr = _decoder.decode(wasi.getStderr());
        console.error("[pymode] persistent path trap:", e instanceof Error ? e.message : String(e));
        if (trapStderr) console.error("[pymode] trap stderr:", trapStderr.slice(0, 1500));
        this.persistentRunner = null;
        trapped = true;
      }
      if (!trapped && !fanout.hasPending) {
        stdout = _decoder.decode(wasi.getStdout());
        stderr = _decoder.decode(wasi.getStderr());
        exitCode = warmExitCode;
        lastWrittenFiles = wasi.getWrittenFiles();
        if (lastWrittenFiles && lastWrittenFiles.size > 0) {
          await this.flushDataFiles(lastWrittenFiles);
        }
        return { stdout, stderr, exitCode };
      }
      // Fanout was pending — handler needs replay, fall back to the
      // original fresh-instance loop. Invalidate the cache.
      this.persistentRunner = null;
      fanout.resetPass();
    }

    // Promote stdin to a WasiState if it isn't already; this is what
    // proc_exit uses to decide whether to throw (slow-path fanout) or
    // record-and-return (fast-path persistent). On the *last* pass that
    // completes without fanout, we'll stash the state on `persistentRunner`
    // so the next request can take the fast path.
    const slowPathWasiState = makeWasiState(stdinData);

    for (let pass = 0; pass < MAX_REPLAY_PASSES; pass++) {
      fanout.resetPass();

      // Reset slowPathWasiState for this pass.
      slowPathWasiState.stdinData = stdinData;
      slowPathWasiState.stdinOffset = 0;
      slowPathWasiState.stdoutChunks.length = 0;
      slowPathWasiState.stderrChunks.length = 0;
      slowPathWasiState.exited = false;
      slowPathWasiState.exitCode = 0;

      const files = { ...baseFiles };
      const wasi = createWasi(args, wasmEnv, files, () => this.wasmMemory!, slowPathWasiState, stdlibDirIndex);
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
            let entry = self.extensionModules.get(path);
            if (!entry && basename) entry = self.extensionModules.get(basename);
            if (!entry) {
              for (const [key, mod] of self.extensionModules) {
                if (path.endsWith(key) || (basename && key.endsWith(basename))) {
                  entry = mod;
                  break;
                }
              }
            }
            if (!entry) {
              self.dlLastError = `module not found: ${path}`;
              return -1;
            }
            try {
              const mainExports = self.wasmInstance?.exports;
              if (!mainExports) {
                self.dlLastError = "main wasm not yet instantiated";
                return -1;
              }
              console.log(`[dynlink] loading ${basename} (${entry.bytes.byteLength} bytes)`);
              const linked = linkSideModule(entry.module, entry.bytes, {
                mainExports,
                sideModuleName: basename,
              });
              console.log(`[dynlink] ${basename} linked: missing=${linked.missing.length} memoryBase=${linked.memoryBase} tableBase=${linked.tableBase}`);
              if (linked.missing.length > 0) {
                console.warn(
                  `[dynlink] ${basename}: first 5 unresolved: ${linked.missing.slice(0, 5).join(", ")}`,
                );
              }
              const handle = self.nextDlHandle++;
              self.dlModules.set(handle, {
                instance: linked.instance,
                exports: linked.exports,
              });
              return handle;
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[dynlink] failed to load ${path}: ${msg}`);
              if (e instanceof Error && e.stack) console.error(e.stack);
              self.dlLastError = `failed to load ${path}: ${msg}`;
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
      const result = await WebAssembly.instantiate(await getPythonWasm(), imports);
      const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
      this.wasmInstance = instance;
      this.wasmMemory = instance.exports.memory as WebAssembly.Memory;

      // Set memory reference for JIT zerobuf allocation
      zbOpts.memory = this.wasmMemory;

      // Capture the fresh stack pointer BEFORE _start runs. We restore
      // this on every persistent-runner re-entry so wasi-libc's _start
      // wrapper sees a clean SP each call.
      const spExport = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
      const freshStackPointer = spExport ? (spExport.value as number) : undefined;

      exitCode = 0;
      try {
        (instance.exports._start as Function)();
      } catch (e: unknown) {
        if (e instanceof ProcExit) exitCode = e.code;
        else throw e;
      }

      // proc_exit with external state records exitCode + returns. Pick
      // up either signal.
      if (slowPathWasiState.exited) exitCode = slowPathWasiState.exitCode;

      stdout = _decoder.decode(wasi.getStdout());
      stderr = _decoder.decode(wasi.getStderr());
      lastWrittenFiles = wasi.getWrittenFiles();

      // If no pending async calls, we're done. Promote the instance to
      // the persistent cache so the next request can skip instantiation.
      if (!fanout.hasPending) {
        this.persistentRunner = {
          instance,
          wasiState: slowPathWasiState,
          wasi,
          userFilesKey,
          initialStackPointer: freshStackPointer,
        };
        break;
      }

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
    // Warm the brotli-decompressed stdlib + the assets-hosted extension
    // site-packages zip (cached after first call). The DO runs in its own
    // isolate from the entry worker, so even if worker.ts already warmed
    // them in the entry isolate, this isolate hasn't.
    const _envAssets = this.env as unknown as { ASSETS?: { fetch: (r: Request) => Promise<Response> } };
    await Promise.all([
      getStdlibBin(_envAssets),
      warmExtensionPackages(_envAssets),
      warmSitePackages(_envAssets),
      this._keepAlive(),
    ]);
    let pythonPath = "/stdlib";
    if (sitePackagesData || getSitePackagesBin()) pythonPath += ":/stdlib/site-packages.zip";
    if (getExtensionPackagesBin()) pythonPath += ":/stdlib/extension-site-packages.zip";
    return this.run(
      ["python", "-S", "-c", "import _wasi_compat\n" + code],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PY_KEY_VALUE_DISABLE_BEARTYPE: "1" },
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
    // Warm the gzip-decompressed stdlib + the assets-hosted extension &
    // user site-packages (all cached after first call). The DO runs in
    // its own isolate from the entry worker, so it warms separately.
    const _envAssets = this.env as unknown as { ASSETS?: { fetch: (r: Request) => Promise<Response> } };
    await Promise.all([
      getStdlibBin(_envAssets),
      warmExtensionPackages(_envAssets),
      warmSitePackages(_envAssets),
      this._keepAlive(),
    ]);
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
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PY_KEY_VALUE_DISABLE_BEARTYPE: "1" },
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
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PY_KEY_VALUE_DISABLE_BEARTYPE: "1" },
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
   * Alarm handler — fired periodically to keep this DO instance warm.
   *
   * CF evicts idle DOs after ~70s of no activity. For pandas-class
   * variants where the cold-start cost (`import pandas`) is 20-30
   * seconds, keeping the DO instance warm via a periodic alarm is far
   * cheaper than paying that cost on a real request.
   *
   * The alarm reschedules itself, so once seeded (by the first request)
   * the DO stays alive until CF actively evicts it (rare; happens on
   * deploys and occasional zone-level evictions). Real requests reset
   * the schedule.
   */
  async alarm(): Promise<void> {
    // Wake-up tap: ensure stdlib + extensions are warmed in this isolate.
    // Doesn't run user code — the persistentRunner caches the wasm
    // instance from prior requests anyway, so we just need to keep the
    // isolate alive.
    const envAssets = this.env as unknown as { ASSETS?: { fetch: (r: Request) => Promise<Response> } };
    await Promise.all([
      getStdlibBin(envAssets),
      warmExtensionPackages(envAssets),
      warmSitePackages(envAssets),
    ]).catch(() => undefined);

    // Reschedule. 30s is well under CF's eviction window (~70s) so we
    // never miss a wake-up.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
  }

  /**
   * Seed the alarm from the first request — `handleRequest`, `executeCode`,
   * and `callFunction` all call this. setAlarm is idempotent for the same
   * timestamp, so it's safe to call on every request.
   */
  private async _keepAlive(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing < Date.now() + 10_000) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }
}
