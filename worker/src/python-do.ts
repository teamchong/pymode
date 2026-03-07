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
import { stdlibFS } from "./stdlib-fs";
import { ProcExit, createWasi, buildDirIndex } from "./wasi";

// Pre-encode stdlib files once at module load (persists across requests in the DO isolate).
const _encoder = new TextEncoder();
const stdlibBin: Record<string, Uint8Array> = {};
for (const [path, content] of Object.entries(stdlibFS)) {
  stdlibBin[path] = _encoder.encode(content);
}

// Pre-build directory index from stdlib paths.
const stdlibDirIndex = buildDirIndex(stdlibBin);

// Optional: extension site-packages (e.g. numpy Python layer)
let extensionPackagesData: ArrayBuffer | undefined;
try {
  // @ts-ignore — conditional import, only present for extension variants
  extensionPackagesData = require("./extension-site-packages.zip");
} catch {
  // No extension packages
}

interface PythonDOEnv {
  KV?: KVNamespace;
  R2?: R2Bucket;
  D1?: D1Database;
  THREAD_DO?: DurableObjectNamespace;
  [key: string]: unknown;
}

// The set of pymode.* imports that are async (return Promises).
// These must match the --pass-arg=asyncify-imports@ list in build-phase2.sh.
const ASYNC_IMPORTS = new Set([
  "pymode.tcp_recv",
  "pymode.http_fetch",
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
  }>();
  private nextConnId = 1;

  // HTTP response storage — fetch results for Python to read back
  private httpResponses = new Map<number, {
    status: number;
    headers: Headers;
    body: Uint8Array;
    offset: number;
  }>();
  private nextResponseId = 1;

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

  private getMemBytes(): Uint8Array {
    return new Uint8Array(this.wasmMemory!.buffer);
  }

  private readString(ptr: number, len: number): string {
    return new TextDecoder().decode(this.getMemBytes().subarray(ptr, ptr + len));
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
        const host = self.readString(hostPtr, hostLen);
        const connId = self.nextConnId++;
        const socket = connect({ hostname: host, port });
        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();
        self.tcpConns.set(connId, { socket, writer, reader });
        return connId;
      },

      tcp_send: (connId: number, dataPtr: number, dataLen: number): number => {
        const conn = self.tcpConns.get(connId);
        if (!conn) return -1;
        const data = self.getMemBytes().slice(dataPtr, dataPtr + dataLen);
        conn.writer.write(data);
        return dataLen;
      },

      // Async — returns Promise, Asyncify suspends WASM stack
      tcp_recv: async (connId: number, bufPtr: number, bufLen: number): Promise<number> => {
        const conn = self.tcpConns.get(connId);
        if (!conn) return -1;
        const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 10000)
        );
        const result = await Promise.race([conn.reader.read(), timeoutPromise]);
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
      // Async — returns Promise
      http_fetch: async (
        urlPtr: number, urlLen: number,
        methodPtr: number, methodLen: number,
        bodyPtr: number, bodyLen: number,
        headersPtr: number, headersLen: number
      ): Promise<number> => {
        const url = self.readString(urlPtr, urlLen);
        const method = self.readString(methodPtr, methodLen);
        const body = bodyLen > 0 ? self.getMemBytes().slice(bodyPtr, bodyPtr + bodyLen) : undefined;
        const headersJson = headersLen > 0 ? self.readString(headersPtr, headersLen) : "{}";
        const headers = JSON.parse(headersJson);
        const resp = await fetch(url, { method: method || "GET", headers, body });
        const respBody = new Uint8Array(await resp.arrayBuffer());
        const respId = self.nextResponseId++;
        self.httpResponses.set(respId, { status: resp.status, headers: resp.headers, body: respBody, offset: 0 });
        return respId;
      },

      http_response_status: (responseId: number): number => {
        const resp = self.httpResponses.get(responseId);
        return resp ? resp.status : -1;
      },

      http_response_read: (responseId: number, bufPtr: number, bufLen: number): number => {
        const resp = self.httpResponses.get(responseId);
        if (!resp) return -1;
        const remaining = resp.body.length - resp.offset;
        const n = Math.min(remaining, bufLen);
        self.getMemBytes().set(resp.body.subarray(resp.offset, resp.offset + n), bufPtr);
        resp.offset += n;
        return n;
      },

      http_response_header: (
        responseId: number,
        namePtr: number, nameLen: number,
        bufPtr: number, bufLen: number
      ): number => {
        const resp = self.httpResponses.get(responseId);
        if (!resp) return -1;
        const name = self.readString(namePtr, nameLen);
        const value = resp.headers.get(name);
        if (!value) return -1;
        const encoded = new TextEncoder().encode(value);
        return self.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- KV (async) ---
      kv_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
        if (!self.env.KV) return -1;
        const key = self.readString(keyPtr, keyLen);
        const val = await self.env.KV.get(key, "arrayBuffer");
        if (val === null) return -1;
        return self.writeBytes(bufPtr, new Uint8Array(val), bufLen);
      },

      kv_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
        if (!self.env.KV) return;
        const key = self.readString(keyPtr, keyLen);
        const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
        await self.env.KV.put(key, val);
      },

      kv_delete: async (keyPtr: number, keyLen: number): Promise<void> => {
        if (!self.env.KV) return;
        const key = self.readString(keyPtr, keyLen);
        await self.env.KV.delete(key);
      },

      // --- R2 (async) ---
      r2_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
        if (!self.env.R2) return -1;
        const key = self.readString(keyPtr, keyLen);
        const obj = await self.env.R2.get(key);
        if (!obj) return -1;
        return self.writeBytes(bufPtr, new Uint8Array(await obj.arrayBuffer()), bufLen);
      },

      r2_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
        if (!self.env.R2) return;
        const key = self.readString(keyPtr, keyLen);
        const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
        await self.env.R2.put(key, val);
      },

      // --- D1 (async) ---
      d1_exec: async (
        sqlPtr: number, sqlLen: number,
        paramsPtr: number, paramsLen: number,
        resultPtr: number, resultLen: number
      ): Promise<number> => {
        if (!self.env.D1) return -1;
        const sql = self.readString(sqlPtr, sqlLen);
        const params = JSON.parse(self.readString(paramsPtr, paramsLen));
        const stmt = self.env.D1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        const encoded = new TextEncoder().encode(JSON.stringify(results));
        return self.writeBytes(resultPtr, encoded, resultLen);
      },

      // --- Environment (sync) ---
      env_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const key = self.readString(keyPtr, keyLen);
        const value = self.env[key];
        if (value === undefined || value === null) return -1;
        const encoded = new TextEncoder().encode(String(value));
        return self.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- Threading (async) ---
      // Spawn a child DO to run Python code in parallel
      thread_spawn: async (
        codePtr: number, codeLen: number,
        inputPtr: number, inputLen: number
      ): Promise<number> => {
        if (!self.env.THREAD_DO || !self.wasmModule || !self.createWasiFn) return -1;
        const code = self.readString(codePtr, codeLen);
        const input = self.getMemBytes().slice(inputPtr, inputPtr + inputLen);
        const threadId = self.nextThreadId++;

        // Get a unique DO instance for this thread
        const doId = self.env.THREAD_DO.newUniqueId();
        const threadDO = self.env.THREAD_DO.get(doId) as any;

        // Fire off the child DO — it runs in parallel
        const resultPromise = threadDO.execute(
          self.wasmModule, self.createWasiFn, code, input
        ).then((r: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }) => {
          return r.stdout;
        });

        self.threadResults.set(threadId, resultPromise);
        return threadId;
      },

      // Join a spawned thread — blocks until child DO completes
      thread_join: async (threadId: number, bufPtr: number, bufLen: number): Promise<number> => {
        const promise = self.threadResults.get(threadId);
        if (!promise) return -1;
        const result = await promise;
        self.threadResults.delete(threadId);
        return self.writeBytes(bufPtr, result, bufLen);
      },

      // --- Dynamic Loading (C extension polyfill) ---
      // Async — loads a .wasm side module with shared linear memory
      dl_open: async (pathPtr: number, pathLen: number): Promise<number> => {
        const path = self.readString(pathPtr, pathLen);
        self.dlLastError = null;

        // Look up pre-compiled extension module by path
        // Try exact path first, then basename, then various normalizations
        let wasmModule = self.extensionModules.get(path);
        if (!wasmModule) {
          // Try basename (e.g. "_speedups.wasm" from full path)
          const basename = path.split("/").pop() || path;
          wasmModule = self.extensionModules.get(basename);
        }
        if (!wasmModule) {
          // Try matching by module name pattern in the path
          for (const [key, mod] of self.extensionModules) {
            if (path.endsWith(key) || key.endsWith(path.split("/").pop() || "")) {
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
        const encoded = new TextEncoder().encode(self.dlLastError);
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
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const asyncify = new AsyncifyRuntime();

    // Build VFS from stdlib + pymode runtime (pre-encoded at module load)
    const files: Record<string, Uint8Array> = { ...stdlibBin };

    // Mount user project files
    if (userFiles) {
      for (const [path, content] of Object.entries(userFiles)) {
        files[path] = encoder.encode(content);
      }
    }

    // Mount site-packages
    if (sitePackagesData) {
      files["site-packages.zip"] = new Uint8Array(sitePackagesData);
    }

    // Mount extension site-packages (numpy, etc.)
    if (extensionPackagesData) {
      files["extension-site-packages.zip"] = new Uint8Array(extensionPackagesData);
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

    try {
      // Single call — asyncify handles all async suspensions internally
      await asyncify.callExport("_start");
      return {
        stdout: decoder.decode(wasi.getStdout()),
        stderr: decoder.decode(wasi.getStderr()),
        exitCode: 0,
      };
    } catch (e: unknown) {
      if (e instanceof ProcExit) {
        return {
          stdout: decoder.decode(wasi.getStdout()),
          stderr: decoder.decode(wasi.getStderr()),
          exitCode: e.code,
        };
      }
      throw e;
    }
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
    const encoder = new TextEncoder();
    return this.run(
      ["python", "-S", "-m", "pymode._handler", entryModule],
      { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      userFiles,
      encoder.encode(requestJson),
      sitePackagesData,
    );
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
  }
}
