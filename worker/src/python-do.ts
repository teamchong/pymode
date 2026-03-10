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
import { connect } from "cloudflare:sockets";
import { AsyncifyRuntime } from "./asyncify";
import pythonWasm from "./python.wasm";
import { ProcExit, createWasi } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex, extensionPackagesBin } from "./stdlib-bin";

interface PythonDOEnv {
  THREAD_DO?: DurableObjectNamespace;
  [key: string]: unknown;
}

/**
 * Parse a binding-qualified key: "BINDING_NAME\0actual_key" → [binding, key].
 * If no separator, returns [fallbackBinding, fullKey] for backward compat.
 */
function parseBindingKey(raw: string, fallback: string): [string, string] {
  const sep = raw.indexOf("\0");
  if (sep === -1) return [fallback, raw];
  return [raw.substring(0, sep), raw.substring(sep + 1)];
}

// The set of pymode.* imports that are async (return Promises).
// These must match the --pass-arg=asyncify-imports@ list in build-phase2.py.
const ASYNC_IMPORTS = new Set([
  "pymode.tcp_recv",
  "pymode.http_fetch_full",
  "pymode.kv_get",
  "pymode.kv_put",
  "pymode.kv_delete",
  "pymode.r2_get",
  "pymode.r2_put",
  "pymode.d1_exec",
  "pymode.thread_spawn",
  "pymode.thread_join",
  "pymode.dl_open",
]);

export class PythonDO extends DurableObject<PythonDOEnv> {
  private wasmMemory: WebAssembly.Memory | null = null;

  // Persistent TCP connections — survive across calls within the DO lifetime
  private tcpConns = new Map<number, {
    socket: any;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    timedOut?: boolean;
  }>();
  private nextConnId = 1;

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
  // Keys are paths like "markupsafe/_speedups.wasm", values are compiled WebAssembly.Module
  public extensionModules = new Map<string, WebAssembly.Module>();

  // Stored references for spawning child DOs and dynamic loading
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

  /**
   * Build the pymode.* WASM import namespace.
   *
   * Sync imports return values directly.
   * Async imports return Promises — Asyncify handles suspend/resume.
   */
  private buildImports(): Record<string, any> {
    const self = this;

    return {
      // --- TCP ---
      tcp_connect: (hostPtr: number, hostLen: number, port: number): number => {
        try {
          const host = self.readString(hostPtr, hostLen);
          const connId = self.nextConnId++;
          const socket = connect({ hostname: host, port });
          const writer = socket.writable.getWriter();
          const reader = socket.readable.getReader();
          self.tcpConns.set(connId, { socket, writer, reader });
          return connId;
        } catch (e: unknown) {
          console.error("tcp_connect error:", e);
          return -1;
        }
      },

      tcp_send: (connId: number, dataPtr: number, dataLen: number): number => {
        const conn = self.tcpConns.get(connId);
        if (!conn) return -1;
        const data = self.getMemBytes().slice(dataPtr, dataPtr + dataLen);
        conn.writer.write(data).catch(() => {});
        return dataLen;
      },

      // Async — returns Promise, Asyncify suspends WASM stack
      tcp_recv: async (connId: number, bufPtr: number, bufLen: number): Promise<number> => {
        const conn = self.tcpConns.get(connId);
        if (!conn) return -1;
        // After timeout, the reader has a pending read — can't start another
        if (conn.timedOut) return 0;
        let didTimeout = false;
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => { didTimeout = true; resolve({ value: undefined, done: true }); }, 10000)
        );
        const result = await Promise.race([conn.reader.read(), timeoutPromise]);
        if (didTimeout) conn.timedOut = true;
        if (result.done || !result.value) return 0;
        const n = Math.min(result.value.length, bufLen);
        self.getMemBytes().set(result.value.subarray(0, n), bufPtr);
        return n;
      },

      tcp_close: (connId: number): void => {
        const conn = self.tcpConns.get(connId);
        if (!conn) return;
        try { conn.writer.releaseLock(); } catch {}
        try { conn.reader.releaseLock(); } catch {}
        try { conn.socket.close(); } catch {}
        self.tcpConns.delete(connId);
      },

      // --- HTTP ---
      // Batched fetch — returns status + headers + body in one async call.
      // Buffer layout: [4B status LE][4B headers_json_len LE][headers_json][body]
      http_fetch_full: async (
        urlPtr: number, urlLen: number,
        methodPtr: number, methodLen: number,
        bodyPtr: number, bodyLen: number,
        headersPtr: number, headersLen: number,
        resultPtr: number, resultLen: number
      ): Promise<number> => {
        try {
          const url = self.readString(urlPtr, urlLen);
          const method = self.readString(methodPtr, methodLen);
          const body = bodyLen > 0 ? self.getMemBytes().slice(bodyPtr, bodyPtr + bodyLen) : undefined;
          const headersJson = headersLen > 0 ? self.readString(headersPtr, headersLen) : "{}";
          const headers = JSON.parse(headersJson);
          const resp = await fetch(url, { method: method || "GET", headers, body });
          const respBody = new Uint8Array(await resp.arrayBuffer());

          // Serialize all response headers as JSON
          const respHeaders: Record<string, string> = {};
          resp.headers.forEach((value, key) => {
            respHeaders[key] = value;
          });
          const headersBytes = _encoder.encode(JSON.stringify(respHeaders));

          // Total: 4 (status) + 4 (headers len) + headers + body
          const totalLen = 8 + headersBytes.length + respBody.length;
          if (totalLen > resultLen) {
            console.error(`http_fetch_full: result too large (${totalLen} > ${resultLen})`);
            return -1;
          }

          const mem = self.getMemBytes();
          const view = new DataView(mem.buffer, resultPtr, 8);
          view.setUint32(0, resp.status, true);
          view.setUint32(4, headersBytes.length, true);
          mem.set(headersBytes, resultPtr + 8);
          mem.set(respBody, resultPtr + 8 + headersBytes.length);
          return totalLen;
        } catch (e: unknown) {
          console.error("http_fetch_full error:", e);
          return -1;
        }
      },

      // --- KV (async) ---
      kv_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
        try {
          const raw = self.readString(keyPtr, keyLen);
          const [bindingName, key] = parseBindingKey(raw, "KV");
          const kv = self.env[bindingName] as KVNamespace | undefined;
          if (!kv) return -1;
          const val = await kv.get(key, "arrayBuffer");
          if (val === null) return -1;
          return self.writeBytes(bufPtr, new Uint8Array(val), bufLen);
        } catch (e: unknown) {
          console.error("kv_get error:", e);
          return -1;
        }
      },

      kv_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
        try {
          const raw = self.readString(keyPtr, keyLen);
          const [bindingName, key] = parseBindingKey(raw, "KV");
          const kv = self.env[bindingName] as KVNamespace | undefined;
          if (!kv) return;
          const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
          await kv.put(key, val);
        } catch (e: unknown) {
          console.error("kv_put error:", e);
        }
      },

      kv_delete: async (keyPtr: number, keyLen: number): Promise<void> => {
        try {
          const raw = self.readString(keyPtr, keyLen);
          const [bindingName, key] = parseBindingKey(raw, "KV");
          const kv = self.env[bindingName] as KVNamespace | undefined;
          if (!kv) return;
          await kv.delete(key);
        } catch (e: unknown) {
          console.error("kv_delete error:", e);
        }
      },

      // --- R2 (async) ---
      r2_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
        try {
          const raw = self.readString(keyPtr, keyLen);
          const [bindingName, key] = parseBindingKey(raw, "R2");
          const r2 = self.env[bindingName] as R2Bucket | undefined;
          if (!r2) return -1;
          const obj = await r2.get(key);
          if (!obj) return -1;
          return self.writeBytes(bufPtr, new Uint8Array(await obj.arrayBuffer()), bufLen);
        } catch (e: unknown) {
          console.error("r2_get error:", e);
          return -1;
        }
      },

      r2_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
        try {
          const raw = self.readString(keyPtr, keyLen);
          const [bindingName, key] = parseBindingKey(raw, "R2");
          const r2 = self.env[bindingName] as R2Bucket | undefined;
          if (!r2) return;
          const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
          await r2.put(key, val);
        } catch (e: unknown) {
          console.error("r2_put error:", e);
        }
      },

      // --- D1 (async) ---
      d1_exec: async (
        sqlPtr: number, sqlLen: number,
        paramsPtr: number, paramsLen: number,
        resultPtr: number, resultLen: number
      ): Promise<number> => {
        try {
          const rawSql = self.readString(sqlPtr, sqlLen);
          const [bindingName, sql] = parseBindingKey(rawSql, "D1");
          const d1 = self.env[bindingName] as D1Database | undefined;
          if (!d1) return -1;
          const params = JSON.parse(self.readString(paramsPtr, paramsLen));
          const stmt = d1.prepare(sql).bind(...params);
          const { results } = await stmt.all();
          const encoded = _encoder.encode(JSON.stringify(results));
          return self.writeBytes(resultPtr, encoded, resultLen);
        } catch (e: unknown) {
          console.error("d1_exec error:", e);
          return -1;
        }
      },

      // --- Environment (sync) ---
      env_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const key = self.readString(keyPtr, keyLen);
        const value = self.env[key];
        if (value === undefined || value === null) return -1;
        const encoded = _encoder.encode(String(value));
        return self.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- Threading (async) ---
      // Spawn a child DO to run Python code in parallel
      thread_spawn: async (
        codePtr: number, codeLen: number,
        inputPtr: number, inputLen: number
      ): Promise<number> => {
        if (!self.env.THREAD_DO) return -1;
        const code = self.readString(codePtr, codeLen);
        const input = self.getMemBytes().slice(inputPtr, inputPtr + inputLen);
        const threadId = self.nextThreadId++;

        // Get a unique DO instance for this thread
        const doId = self.env.THREAD_DO.newUniqueId();
        const threadDO = self.env.THREAD_DO.get(doId) as any;

        // Fire off the child DO — it runs in parallel.
        // ThreadDO imports python.wasm directly (can't send Module via RPC).
        const resultPromise = threadDO.execute(code, input)
          .then((r: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }) => {
            return r.stdout;
          });

        self.threadResults.set(threadId, resultPromise);
        return threadId;
      },

      // Join a spawned thread — blocks until child DO completes
      thread_join: async (threadId: number, bufPtr: number, bufLen: number): Promise<number> => {
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

      // --- Dynamic Loading (C extension polyfill) ---
      // Async — loads a .wasm side module with shared linear memory
      dl_open: async (pathPtr: number, pathLen: number): Promise<number> => {
        const path = self.readString(pathPtr, pathLen);
        self.dlLastError = null;

        // Look up pre-compiled extension module by path
        // Try exact path first, then basename, then suffix match
        const basename = path.split("/").pop() || "";
        let wasmModule = self.extensionModules.get(path);
        if (!wasmModule && basename) {
          wasmModule = self.extensionModules.get(basename);
        }
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
          // Instantiate the side module sharing python.wasm's linear memory.
          // Side modules export PyInit_<name> and import CPython API functions.
          // We provide the shared memory so the extension can read/write Python objects.
          const sideImports: WebAssembly.Imports = {
            env: {
              memory: self.wasmMemory!,
            },
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

      // Resolve a symbol (e.g. PyInit__speedups) in a loaded side module.
      // Returns a WASM function table index, or 0 if not found.
      dl_sym: (handle: number, symbolPtr: number, symbolLen: number): number => {
        const mod = self.dlModules.get(handle);
        if (!mod) {
          self.dlLastError = `invalid handle: ${handle}`;
          return 0;
        }

        const symbol = self.readString(symbolPtr, symbolLen);
        const exported = mod.exports[symbol];
        if (typeof exported !== "function") {
          self.dlLastError = `symbol '${symbol}' not found`;
          return 0;
        }

        // To call a function from a side module as a function pointer in the main
        // module, we need to add it to the main module's indirect call table.
        // The main module's __indirect_function_table is exported by python.wasm.
        const table = self.wasmInstance?.exports.__indirect_function_table as WebAssembly.Table | undefined;
        if (!table) {
          // Fallback: return a non-zero sentinel. The C side may not need table-based
          // calling if using direct calls. This shouldn't happen with a properly
          // built python.wasm (Asyncify always exports the table).
          self.dlLastError = "indirect function table not available";
          return 0;
        }

        // Grow the table by 1 and set the new slot to our function
        const idx = table.length;
        table.grow(1);
        table.set(idx, exported as WebAssembly.Function);
        return idx;
      },

      dl_close: (handle: number): void => {
        self.dlModules.delete(handle);
      },

      dl_error: (bufPtr: number, bufLen: number): number => {
        if (!self.dlLastError) return 0;
        const encoded = _encoder.encode(self.dlLastError);
        const n = self.writeBytes(bufPtr, encoded, bufLen);
        self.dlLastError = null;
        return n;
      },

      // --- Logging (sync) ---
      console_log: (msgPtr: number, msgLen: number): void => {
        console.log(self.readString(msgPtr, msgLen));
      },
    };
  }

  /**
   * Run Python in the WASM interpreter with full host imports.
   *
   * Single _start() invocation. Asyncify handles all async I/O by
   * suspending/resuming the WASM stack when async imports are called.
   * No trampoline, no re-execution.
   *
   * PythonDO imports python.wasm and stdlib-fs directly — no need to
   * pass non-serializable objects (WebAssembly.Module, closures) via RPC.
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
      // Append to PYTHONPATH if not already there
      if (wasmEnv.PYTHONPATH && !wasmEnv.PYTHONPATH.includes("extension-site-packages.zip")) {
        wasmEnv = { ...wasmEnv, PYTHONPATH: wasmEnv.PYTHONPATH + ":/stdlib/extension-site-packages.zip" };
      }
    }

    const wasi = createWasi(args, wasmEnv, files, () => this.wasmMemory!, stdinData, stdlibDirIndex);
    const pymodeImports = this.buildImports();

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
    // WebAssembly.instantiate() with a Module returns Instance directly;
    // with an ArrayBuffer it returns { module, instance }.
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
    return {
      stdout: _decoder.decode(wasi.getStdout()),
      stderr: _decoder.decode(wasi.getStderr()),
      exitCode,
    };
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
    for (const [, conn] of this.tcpConns) {
      try { conn.writer.releaseLock(); } catch {}
      try { conn.reader.releaseLock(); } catch {}
      try { conn.socket.close(); } catch {}
    }
    this.tcpConns.clear();
    this.dlModules.clear();
    this.threadResults.clear();
  }
}
