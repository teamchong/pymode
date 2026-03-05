/**
 * PythonDO — Durable Object that runs the full CPython WASM instance.
 *
 * Holds the interpreter, TCP connections, and CF binding access in one place.
 * Host-provided WASM imports (pymode.* namespace) replace the VFS trampoline.
 *
 * Phase 1: TCP host imports with in-process trampoline for async ops.
 * Phase 3 will add JSPI to eliminate the trampoline entirely.
 */

import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

interface PythonDOEnv {
  KV?: KVNamespace;
  R2?: R2Bucket;
  D1?: D1Database;
  [key: string]: unknown;
}

class ProcExit extends Error {
  code: number;
  constructor(code: number) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

/**
 * Thrown by async host imports (tcp_recv, http_fetch, etc.) when they need
 * to await a JS Promise but JSPI is not available. The run() loop catches
 * this, awaits the operation, writes the result, and re-invokes _start.
 */
class NeedsAsync extends Error {
  operation: () => Promise<void>;
  constructor(operation: () => Promise<void>) {
    super("needs_async");
    this.operation = operation;
  }
}

export class PythonDO extends DurableObject<PythonDOEnv> {
  private wasmMemory: WebAssembly.Memory | null = null;

  // Persistent TCP connections — survive across trampoline rounds within a request
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

  // In-process trampoline state for async ops
  // When an async host import fires, it stores the result here for replay
  private asyncResults = new Map<string, ArrayBuffer>();
  private asyncCounter = 0;

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
   * Create the pymode.* WASM import namespace.
   *
   * Sync imports (tcp_connect, tcp_send, tcp_close, env_get, console_log)
   * execute immediately and return values.
   *
   * Async imports (tcp_recv, http_fetch, kv_*, r2_*, d1_exec) throw NeedsAsync
   * which the run() loop catches, awaits, and replays.
   */
  private createHostImports(): Record<string, Function> {
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

      tcp_recv: (connId: number, bufPtr: number, bufLen: number): number => {
        const asyncKey = `tcp_recv_${self.asyncCounter++}`;

        // Check if we already have the result from a previous trampoline round
        const cached = self.asyncResults.get(asyncKey);
        if (cached) {
          const data = new Uint8Array(cached);
          const n = Math.min(data.length, bufLen);
          self.getMemBytes().set(data.subarray(0, n), bufPtr);
          self.asyncResults.delete(asyncKey);
          return n;
        }

        // No cached result — throw to trigger trampoline
        const conn = self.tcpConns.get(connId);
        if (!conn) return -1;

        throw new NeedsAsync(async () => {
          const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 10000)
          );
          const result = await Promise.race([conn.reader.read(), timeoutPromise]);
          if (result.done || !result.value) {
            self.asyncResults.set(asyncKey, new ArrayBuffer(0));
          } else {
            self.asyncResults.set(asyncKey, result.value.buffer);
          }
        });
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
      http_fetch: (
        urlPtr: number, urlLen: number,
        methodPtr: number, methodLen: number,
        bodyPtr: number, bodyLen: number,
        headersPtr: number, headersLen: number
      ): number => {
        const asyncKey = `http_fetch_${self.asyncCounter++}`;
        const cachedId = self.asyncResults.get(asyncKey);
        if (cachedId) {
          const view = new DataView(cachedId);
          self.asyncResults.delete(asyncKey);
          return view.getInt32(0);
        }

        const url = self.readString(urlPtr, urlLen);
        const method = self.readString(methodPtr, methodLen);
        const body = bodyLen > 0 ? self.getMemBytes().slice(bodyPtr, bodyPtr + bodyLen) : undefined;
        const headersJson = headersLen > 0 ? self.readString(headersPtr, headersLen) : "{}";
        const headers = JSON.parse(headersJson);

        throw new NeedsAsync(async () => {
          const resp = await fetch(url, { method: method || "GET", headers, body });
          const respBody = new Uint8Array(await resp.arrayBuffer());
          const respId = self.nextResponseId++;
          self.httpResponses.set(respId, {
            status: resp.status,
            headers: resp.headers,
            body: respBody,
            offset: 0,
          });
          const buf = new ArrayBuffer(4);
          new DataView(buf).setInt32(0, respId);
          self.asyncResults.set(asyncKey, buf);
        });
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

      // --- KV ---
      kv_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const asyncKey = `kv_get_${self.asyncCounter++}`;
        const cached = self.asyncResults.get(asyncKey);
        if (cached) {
          const data = new Uint8Array(cached);
          if (data.length === 0) { self.asyncResults.delete(asyncKey); return -1; }
          const n = self.writeBytes(bufPtr, data, bufLen);
          self.asyncResults.delete(asyncKey);
          return n;
        }

        const key = self.readString(keyPtr, keyLen);
        throw new NeedsAsync(async () => {
          if (!self.env.KV) { self.asyncResults.set(asyncKey, new ArrayBuffer(0)); return; }
          const val = await self.env.KV.get(key, "arrayBuffer");
          if (val === null) { self.asyncResults.set(asyncKey, new ArrayBuffer(0)); return; }
          self.asyncResults.set(asyncKey, val);
        });
      },

      kv_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
        const asyncKey = `kv_put_${self.asyncCounter++}`;
        if (self.asyncResults.has(asyncKey)) { self.asyncResults.delete(asyncKey); return; }

        const key = self.readString(keyPtr, keyLen);
        const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
        throw new NeedsAsync(async () => {
          if (!self.env.KV) return;
          await self.env.KV.put(key, val);
          self.asyncResults.set(asyncKey, new ArrayBuffer(0));
        });
      },

      kv_delete: (keyPtr: number, keyLen: number): void => {
        const asyncKey = `kv_delete_${self.asyncCounter++}`;
        if (self.asyncResults.has(asyncKey)) { self.asyncResults.delete(asyncKey); return; }

        const key = self.readString(keyPtr, keyLen);
        throw new NeedsAsync(async () => {
          if (!self.env.KV) return;
          await self.env.KV.delete(key);
          self.asyncResults.set(asyncKey, new ArrayBuffer(0));
        });
      },

      // --- R2 ---
      r2_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const asyncKey = `r2_get_${self.asyncCounter++}`;
        const cached = self.asyncResults.get(asyncKey);
        if (cached) {
          const data = new Uint8Array(cached);
          if (data.length === 0) { self.asyncResults.delete(asyncKey); return -1; }
          const n = self.writeBytes(bufPtr, data, bufLen);
          self.asyncResults.delete(asyncKey);
          return n;
        }

        const key = self.readString(keyPtr, keyLen);
        throw new NeedsAsync(async () => {
          if (!self.env.R2) { self.asyncResults.set(asyncKey, new ArrayBuffer(0)); return; }
          const obj = await self.env.R2.get(key);
          if (!obj) { self.asyncResults.set(asyncKey, new ArrayBuffer(0)); return; }
          self.asyncResults.set(asyncKey, await obj.arrayBuffer());
        });
      },

      r2_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
        const asyncKey = `r2_put_${self.asyncCounter++}`;
        if (self.asyncResults.has(asyncKey)) { self.asyncResults.delete(asyncKey); return; }

        const key = self.readString(keyPtr, keyLen);
        const val = self.getMemBytes().slice(valPtr, valPtr + valLen);
        throw new NeedsAsync(async () => {
          if (!self.env.R2) return;
          await self.env.R2.put(key, val);
          self.asyncResults.set(asyncKey, new ArrayBuffer(0));
        });
      },

      // --- D1 ---
      d1_exec: (
        sqlPtr: number, sqlLen: number,
        paramsPtr: number, paramsLen: number,
        resultPtr: number, resultLen: number
      ): number => {
        const asyncKey = `d1_exec_${self.asyncCounter++}`;
        const cached = self.asyncResults.get(asyncKey);
        if (cached) {
          const data = new Uint8Array(cached);
          if (data.length === 0) { self.asyncResults.delete(asyncKey); return -1; }
          const n = self.writeBytes(resultPtr, data, resultLen);
          self.asyncResults.delete(asyncKey);
          return n;
        }

        const sql = self.readString(sqlPtr, sqlLen);
        const paramsJson = self.readString(paramsPtr, paramsLen);
        throw new NeedsAsync(async () => {
          if (!self.env.D1) { self.asyncResults.set(asyncKey, new ArrayBuffer(0)); return; }
          const params = JSON.parse(paramsJson);
          const stmt = self.env.D1.prepare(sql).bind(...params);
          const { results } = await stmt.all();
          const encoded = new TextEncoder().encode(JSON.stringify(results));
          self.asyncResults.set(asyncKey, encoded.buffer);
        });
      },

      // --- Environment ---
      env_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const key = self.readString(keyPtr, keyLen);
        const value = self.env[key];
        if (value === undefined || value === null) return -1;
        const encoded = new TextEncoder().encode(String(value));
        return self.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- Logging ---
      console_log: (msgPtr: number, msgLen: number): void => {
        console.log(self.readString(msgPtr, msgLen));
      },
    };
  }

  /**
   * Run Python code in the WASM interpreter.
   *
   * Uses in-process trampoline for async ops: when a host import needs to await
   * (tcp_recv, http_fetch, etc.), it throws NeedsAsync. We catch it, await the
   * operation, store the result, and re-invoke _start. The async counter ensures
   * deterministic replay — each call site gets the same counter value on replay.
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
    const MAX_ROUNDS = 50;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Reset the async counter each round — deterministic replay
      this.asyncCounter = 0;

      const wasi = createWasi(() => this.wasmMemory!);
      const hostImports = this.createHostImports();

      const instance = new WebAssembly.Instance(wasmModule, {
        wasi_snapshot_preview1: wasi.imports,
        pymode: hostImports,
      });
      this.wasmMemory = instance.exports.memory as WebAssembly.Memory;

      try {
        const start = instance.exports._start as () => void;
        start();
        return {
          stdout: decoder.decode(wasi.getStdout()),
          stderr: decoder.decode(wasi.getStderr()),
          exitCode: 0,
        };
      } catch (e: unknown) {
        if (e instanceof NeedsAsync) {
          // Await the async operation and loop for replay
          await e.operation();
          continue;
        }
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

    throw new Error("Too many async trampoline rounds (possible infinite loop)");
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
    for (const [connId, conn] of this.tcpConns) {
      try { conn.writer.releaseLock(); } catch {}
      try { conn.reader.releaseLock(); } catch {}
      try { conn.socket.close(); } catch {}
    }
    this.tcpConns.clear();
  }
}
