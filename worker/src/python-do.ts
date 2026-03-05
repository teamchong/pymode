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

interface PythonDOEnv {
  KV?: KVNamespace;
  R2?: R2Bucket;
  D1?: D1Database;
  THREAD_DO?: DurableObjectNamespace;
  [key: string]: unknown;
}

class ProcExit extends Error {
  code: number;
  constructor(code: number) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
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

  // Stored references for spawning child DOs
  private wasmModule: WebAssembly.Module | null = null;
  private createWasiFn: ((getMemory: () => WebAssembly.Memory, stdinData?: Uint8Array) => {
    imports: Record<string, Function>;
    getStdout: () => Uint8Array;
    getStderr: () => Uint8Array;
  }) | null = null;

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

      // --- Logging (sync) ---
      console_log: (msgPtr: number, msgLen: number): void => {
        console.log(self.readString(msgPtr, msgLen));
      },
    };
  }

  /**
   * Run Python code in the WASM interpreter.
   *
   * Single _start() invocation. Asyncify handles all async I/O by
   * suspending/resuming the WASM stack when async imports are called.
   * No trampoline, no re-execution.
   */
  async run(
    wasmModule: WebAssembly.Module,
    createWasi: (getMemory: () => WebAssembly.Memory) => {
      imports: Record<string, Function>;
      getStdout: () => Uint8Array;
      getStderr: () => Uint8Array;
    },
    args?: string[]
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const decoder = new TextDecoder();
    const asyncify = new AsyncifyRuntime();

    // Store references so thread_spawn can pass them to child DOs
    this.wasmModule = wasmModule;
    this.createWasiFn = createWasi as any;

    const wasi = createWasi(() => this.wasmMemory!);
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

    const instance = new WebAssembly.Instance(wasmModule, wrappedImports);
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
   * RPC entry point — called by the stateless Worker via DO binding.
   */
  async executeCode(
    wasmModule: WebAssembly.Module,
    createWasi: (getMemory: () => WebAssembly.Memory) => {
      imports: Record<string, Function>;
      getStdout: () => Uint8Array;
      getStderr: () => Uint8Array;
    },
    code: string
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    return this.run(wasmModule, createWasi);
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
