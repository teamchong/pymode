/**
 * host-imports.ts — Shared pymode.* WASM import builder.
 *
 * Used by both PythonDO and ThreadDO to provide KV, R2, D1, HTTP, TCP,
 * env, and logging host imports to the python.wasm instance.
 *
 * Thread/DL imports are optional — ThreadDO disables them to prevent
 * recursive fan-out.
 */

import { connect } from "cloudflare:sockets";
import { encoder as _encoder, decoder as _decoder } from "./stdlib-bin";

/** Block requests to private/internal networks (SSRF prevention). */
function isPrivateHost(hostname: string): boolean {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  if (/^\[?fe80:/i.test(hostname) || /^\[?fc/i.test(hostname) || /^\[?fd/i.test(hostname)) return true;
  return false;
}

/** Validate HTTP headers — reject CRLF injection and null bytes. */
function validateHeaders(headers: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== "string" || typeof value !== "string") return false;
    if (/[\r\n\0]/.test(key) || /[\r\n\0]/.test(value)) return false;
  }
  return true;
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

/** Memory accessor interface for reading/writing WASM linear memory. */
export interface MemoryAccessor {
  getMemBytes(): Uint8Array;
  readString(ptr: number, len: number): string;
  writeBytes(ptr: number, data: Uint8Array, maxLen: number): number;
}

/** Zerobuf exchange region layout constants. */
export const ZB_REQUEST_BASE = 0;       // 4 fields × 16 = 64 bytes
export const ZB_RESPONSE_BASE = 64;     // 4 fields × 16 = 64 bytes
export const ZB_REQ_POOL_START = 128;   // request string pool (JS writes)
export const ZB_RESP_POOL_START = 32768; // response string pool (Python writes)
export const ZB_PAGE_SIZE = 65536;      // 1 WASM page

// Zerobuf tag constants (must match zerobuf.zig Tag enum)
export const ZB_TAG_NULL = 0;
export const ZB_TAG_BOOL = 1;
export const ZB_TAG_I32 = 2;
export const ZB_TAG_F64 = 3;
export const ZB_TAG_STRING = 4;

// Zerobuf value slot = 16 bytes, string header = 4 bytes (u32 length prefix)
export const ZB_VALUE_SLOT = 16;
export const ZB_STRING_HEADER = 4;

/** Write a zerobuf string into a memory region.
 * Returns the offset of the string header. */
export function zbWriteString(
  mem: Uint8Array, poolBase: number, poolOffset: number, str: string
): { headerPtr: number; newOffset: number } {
  const encoded = _encoder.encode(str);
  const headerPtr = poolBase + poolOffset;
  const dv = new DataView(mem.buffer);
  dv.setUint32(headerPtr, encoded.length, true);
  mem.set(encoded, headerPtr + ZB_STRING_HEADER);
  return { headerPtr, newOffset: poolOffset + ZB_STRING_HEADER + encoded.length };
}

/** Write a string-tagged value slot. */
export function zbWriteStringSlot(
  mem: Uint8Array, slotOffset: number, stringHeaderPtr: number
): void {
  mem[slotOffset] = ZB_TAG_STRING;
  mem[slotOffset + 1] = 0;
  mem[slotOffset + 2] = 0;
  mem[slotOffset + 3] = 0;
  const dv = new DataView(mem.buffer);
  dv.setUint32(slotOffset + 4, stringHeaderPtr, true);
}

/** Write an i32-tagged value slot. */
export function zbWriteI32Slot(
  mem: Uint8Array, slotOffset: number, value: number
): void {
  mem[slotOffset] = ZB_TAG_I32;
  mem[slotOffset + 1] = 0;
  mem[slotOffset + 2] = 0;
  mem[slotOffset + 3] = 0;
  const dv = new DataView(mem.buffer);
  dv.setInt32(slotOffset + 4, value, true);
}

/** Read a string from a zerobuf string-tagged value slot. */
export function zbReadString(mem: Uint8Array, slotOffset: number): string {
  if (mem[slotOffset] !== ZB_TAG_STRING) return "";
  const dv = new DataView(mem.buffer);
  const headerPtr = dv.getUint32(slotOffset + 4, true);
  if (headerPtr === 0) return "";
  const strLen = dv.getUint32(headerPtr, true);
  return _decoder.decode(mem.subarray(headerPtr + ZB_STRING_HEADER, headerPtr + ZB_STRING_HEADER + strLen));
}

/** Read an i32 from a zerobuf i32-tagged value slot. */
export function zbReadI32(mem: Uint8Array, slotOffset: number): number {
  if (mem[slotOffset] !== ZB_TAG_I32) return 0;
  const dv = new DataView(mem.buffer);
  return dv.getInt32(slotOffset + 4, true);
}

/** Read a bool from a zerobuf bool-tagged value slot. */
export function zbReadBool(mem: Uint8Array, slotOffset: number): boolean {
  if (mem[slotOffset] !== ZB_TAG_BOOL) return false;
  const dv = new DataView(mem.buffer);
  return dv.getUint32(slotOffset + 4, true) !== 0;
}

/** Write the request into the zerobuf exchange region.
 * Returns the exchange base offset in WASM memory. */
export function zbWriteRequest(
  memory: WebAssembly.Memory,
  method: string,
  url: string,
  headersJson: string,
  body: string,
): number {
  // Grow memory by 1 page for the exchange region
  const oldPages = memory.grow(1);
  const exchangeBase = oldPages * ZB_PAGE_SIZE;
  const mem = new Uint8Array(memory.buffer);

  // Clear the exchange page
  mem.fill(0, exchangeBase, exchangeBase + ZB_PAGE_SIZE);

  // Write request strings into the request pool
  let poolOffset = 0;
  const poolBase = exchangeBase + ZB_REQ_POOL_START;

  const { headerPtr: methodPtr, newOffset: o1 } = zbWriteString(mem, poolBase, poolOffset, method);
  poolOffset = o1;
  const { headerPtr: urlPtr, newOffset: o2 } = zbWriteString(mem, poolBase, poolOffset, url);
  poolOffset = o2;
  const { headerPtr: headersPtr, newOffset: o3 } = zbWriteString(mem, poolBase, poolOffset, headersJson);
  poolOffset = o3;
  const { headerPtr: bodyPtr } = zbWriteString(mem, poolBase, poolOffset, body);

  // Write request schema field slots
  const reqBase = exchangeBase + ZB_REQUEST_BASE;
  zbWriteStringSlot(mem, reqBase + 0 * ZB_VALUE_SLOT, methodPtr);  // field 0: method
  zbWriteStringSlot(mem, reqBase + 1 * ZB_VALUE_SLOT, urlPtr);     // field 1: url
  zbWriteStringSlot(mem, reqBase + 2 * ZB_VALUE_SLOT, headersPtr); // field 2: headers_json
  zbWriteStringSlot(mem, reqBase + 3 * ZB_VALUE_SLOT, bodyPtr);    // field 3: body

  return exchangeBase;
}

/** Read the response from the zerobuf exchange region. */
export function zbReadResponse(
  memory: WebAssembly.Memory,
  exchangeBase: number,
): { status: number; body: string; headersJson: string; bodyIsBinary: boolean } {
  const mem = new Uint8Array(memory.buffer);
  const respBase = exchangeBase + ZB_RESPONSE_BASE;

  return {
    status: zbReadI32(mem, respBase + 0 * ZB_VALUE_SLOT),
    body: zbReadString(mem, respBase + 1 * ZB_VALUE_SLOT),
    headersJson: zbReadString(mem, respBase + 2 * ZB_VALUE_SLOT),
    bodyIsBinary: zbReadBool(mem, respBase + 3 * ZB_VALUE_SLOT),
  };
}

/** Options for building host imports. */
export interface HostImportOptions {
  mem: MemoryAccessor;
  env: Record<string, unknown>;
  /** If set, zerobuf_exchange_ptr returns this offset. */
  zerobufExchangePtr?: number;
  /** If provided, enables thread_spawn/thread_join. */
  threading?: {
    spawn: (code: string, input: Uint8Array) => Promise<number>;
    join: (threadId: number, bufPtr: number, bufLen: number) => Promise<number>;
  };
  /** If provided, enables dl_open/dl_sym/dl_close/dl_error. */
  dynamicLoading?: {
    open: (path: string) => Promise<number>;
    sym: (handle: number, symbol: string) => number;
    close: (handle: number) => void;
    error: (bufPtr: number, bufLen: number) => number;
  };
}

/** The set of pymode.* imports that are async (return Promises). */
export const ASYNC_IMPORTS = new Set([
  "pymode.tcp_recv",
  "pymode.http_fetch_full",
  "pymode.kv_get",
  "pymode.kv_put",
  "pymode.kv_delete",
  "pymode.kv_multi_get",
  "pymode.kv_multi_put",
  "pymode.r2_get",
  "pymode.r2_put",
  "pymode.d1_exec",
  "pymode.d1_batch",
  "pymode.thread_spawn",
  "pymode.thread_join",
  "pymode.dl_open",
]);

/**
 * Build the pymode.* WASM import namespace.
 *
 * Sync imports return values directly.
 * Async imports return Promises — Asyncify handles suspend/resume.
 */
export function buildHostImports(opts: HostImportOptions): Record<string, any> {
  const { mem, env } = opts;

  // TCP connection state (per-instance)
  const tcpConns = new Map<number, {
    socket: any;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    writer: WritableStreamDefaultWriter<Uint8Array>;
    timedOut?: boolean;
  }>();
  let nextConnId = 1;

  return {
    // --- TCP ---
    tcp_connect: (hostPtr: number, hostLen: number, port: number): number => {
      try {
        const host = mem.readString(hostPtr, hostLen);
        if (isPrivateHost(host)) {
          console.error(`tcp_connect blocked: private host ${host}`);
          return -1;
        }
        const connId = nextConnId++;
        const socket = connect({ hostname: host, port });
        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();
        tcpConns.set(connId, { socket, writer, reader });
        return connId;
      } catch (e: unknown) {
        console.error("tcp_connect error:", e);
        return -1;
      }
    },

    tcp_send: (connId: number, dataPtr: number, dataLen: number): number => {
      const conn = tcpConns.get(connId);
      if (!conn) return -1;
      const data = mem.getMemBytes().slice(dataPtr, dataPtr + dataLen);
      conn.writer.write(data).catch((e: unknown) => console.error("tcp_send error:", e));
      return dataLen;
    },

    tcp_recv: async (connId: number, bufPtr: number, bufLen: number): Promise<number> => {
      const conn = tcpConns.get(connId);
      if (!conn) return -1;
      if (conn.timedOut) return 0;
      let didTimeout = false;
      const timeoutPromise = new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => { didTimeout = true; resolve({ value: undefined, done: true }); }, 10000)
      );
      const result = await Promise.race([conn.reader.read(), timeoutPromise]);
      if (didTimeout) conn.timedOut = true;
      if (result.done || !result.value) return 0;
      const n = Math.min(result.value.length, bufLen);
      mem.getMemBytes().set(result.value.subarray(0, n), bufPtr);
      return n;
    },

    tcp_close: (connId: number): void => {
      const conn = tcpConns.get(connId);
      if (!conn) return;
      try { conn.writer.releaseLock(); } catch {}
      try { conn.reader.releaseLock(); } catch {}
      try { conn.socket.close(); } catch {}
      tcpConns.delete(connId);
    },

    // --- HTTP ---
    http_fetch_full: async (
      urlPtr: number, urlLen: number,
      methodPtr: number, methodLen: number,
      bodyPtr: number, bodyLen: number,
      headersPtr: number, headersLen: number,
      resultPtr: number, resultLen: number
    ): Promise<number> => {
      try {
        const url = mem.readString(urlPtr, urlLen);
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          console.error(`http_fetch_full blocked: unsupported protocol ${parsed.protocol}`);
          return -1;
        }
        if (isPrivateHost(parsed.hostname)) {
          console.error(`http_fetch_full blocked: private host ${parsed.hostname}`);
          return -1;
        }
        const method = mem.readString(methodPtr, methodLen);
        const body = bodyLen > 0 ? mem.getMemBytes().slice(bodyPtr, bodyPtr + bodyLen) : undefined;
        const headersJson = headersLen > 0 ? mem.readString(headersPtr, headersLen) : "{}";
        const headers = JSON.parse(headersJson);
        if (!validateHeaders(headers)) {
          console.error("http_fetch_full blocked: invalid headers (CRLF/null injection)");
          return -1;
        }
        const resp = await fetch(url, { method: method || "GET", headers, body });
        const respBody = new Uint8Array(await resp.arrayBuffer());

        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((value, key) => { respHeaders[key] = value; });
        const headersBytes = _encoder.encode(JSON.stringify(respHeaders));

        const totalLen = 8 + headersBytes.length + respBody.length;
        if (totalLen > resultLen) {
          console.error(`http_fetch_full: result too large (${totalLen} > ${resultLen})`);
          return -1;
        }

        const memBytes = mem.getMemBytes();
        const dv = new DataView(memBytes.buffer);
        dv.setUint32(resultPtr, resp.status, true);
        dv.setUint32(resultPtr + 4, headersBytes.length, true);
        memBytes.set(headersBytes, resultPtr + 8);
        memBytes.set(respBody, resultPtr + 8 + headersBytes.length);
        return totalLen;
      } catch (e: unknown) {
        console.error("http_fetch_full error:", e);
        return -1;
      }
    },

    // --- KV ---
    kv_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        const kv = env[bindingName] as KVNamespace | undefined;
        if (!kv) return -1;
        const val = await kv.get(key, "arrayBuffer");
        if (val === null) return -1;
        return mem.writeBytes(bufPtr, new Uint8Array(val), bufLen);
      } catch (e: unknown) {
        console.error("kv_get error:", e);
        return -1;
      }
    },

    kv_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        const kv = env[bindingName] as KVNamespace | undefined;
        if (!kv) return;
        const val = mem.getMemBytes().slice(valPtr, valPtr + valLen);
        await kv.put(key, val);
      } catch (e: unknown) {
        console.error("kv_put error:", e);
      }
    },

    kv_delete: async (keyPtr: number, keyLen: number): Promise<void> => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        const kv = env[bindingName] as KVNamespace | undefined;
        if (!kv) return;
        await kv.delete(key);
      } catch (e: unknown) {
        console.error("kv_delete error:", e);
      }
    },

    kv_multi_get: async (
      keysPtr: number, keysLen: number,
      resultPtr: number, resultLen: number
    ): Promise<number> => {
      try {
        const keysJson: string[] = JSON.parse(mem.readString(keysPtr, keysLen));
        const results = await Promise.all(keysJson.map(async (raw) => {
          const [bindingName, key] = parseBindingKey(raw, "KV");
          const kv = env[bindingName] as KVNamespace | undefined;
          if (!kv) return null;
          const val = await kv.get(key, "arrayBuffer");
          return val !== null ? new Uint8Array(val) : null;
        }));

        const count = results.length;
        let totalLen = 4;
        for (const r of results) totalLen += 4 + (r ? r.length : 0);
        if (totalLen > resultLen) return -1;

        const memBytes = mem.getMemBytes();
        const dv = new DataView(memBytes.buffer);
        dv.setInt32(resultPtr, count, true);
        let offset = 4;
        for (const r of results) {
          if (r) {
            dv.setInt32(resultPtr + offset, r.length, true);
            offset += 4;
            memBytes.set(r, resultPtr + offset);
            offset += r.length;
          } else {
            dv.setInt32(resultPtr + offset, -1, true);
            offset += 4;
          }
        }
        return offset;
      } catch (e: unknown) {
        console.error("kv_multi_get error:", e);
        return -1;
      }
    },

    kv_multi_put: async (dataPtr: number, dataLen: number): Promise<void> => {
      try {
        const memBytes = mem.getMemBytes();
        const dv = new DataView(memBytes.buffer);
        const count = dv.getInt32(dataPtr, true);
        let offset = dataPtr + 4;
        const ops: Promise<void>[] = [];

        for (let i = 0; i < count; i++) {
          const keyLen = dv.getInt32(offset, true);
          offset += 4;
          const rawKey = _decoder.decode(memBytes.subarray(offset, offset + keyLen));
          offset += keyLen;
          const valLen = dv.getInt32(offset, true);
          offset += 4;
          const val = memBytes.slice(offset, offset + valLen);
          offset += valLen;

          const [bindingName, key] = parseBindingKey(rawKey, "KV");
          const kv = env[bindingName] as KVNamespace | undefined;
          if (kv) ops.push(kv.put(key, val));
        }

        await Promise.all(ops);
      } catch (e: unknown) {
        console.error("kv_multi_put error:", e);
      }
    },

    // --- R2 ---
    r2_get: async (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): Promise<number> => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "R2");
        const r2 = env[bindingName] as R2Bucket | undefined;
        if (!r2) return -1;
        const obj = await r2.get(key);
        if (!obj) return -1;
        return mem.writeBytes(bufPtr, new Uint8Array(await obj.arrayBuffer()), bufLen);
      } catch (e: unknown) {
        console.error("r2_get error:", e);
        return -1;
      }
    },

    r2_put: async (keyPtr: number, keyLen: number, valPtr: number, valLen: number): Promise<void> => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "R2");
        const r2 = env[bindingName] as R2Bucket | undefined;
        if (!r2) return;
        const val = mem.getMemBytes().slice(valPtr, valPtr + valLen);
        await r2.put(key, val);
      } catch (e: unknown) {
        console.error("r2_put error:", e);
      }
    },

    // --- D1 ---
    d1_exec: async (
      sqlPtr: number, sqlLen: number,
      paramsPtr: number, paramsLen: number,
      resultPtr: number, resultLen: number
    ): Promise<number> => {
      try {
        const rawSql = mem.readString(sqlPtr, sqlLen);
        const [bindingName, sql] = parseBindingKey(rawSql, "D1");
        const d1 = env[bindingName] as D1Database | undefined;
        if (!d1) return -1;
        const params = JSON.parse(mem.readString(paramsPtr, paramsLen));
        const stmt = d1.prepare(sql).bind(...params);
        const { results } = await stmt.all();
        const encoded = _encoder.encode(JSON.stringify(results));
        return mem.writeBytes(resultPtr, encoded, resultLen);
      } catch (e: unknown) {
        console.error("d1_exec error:", e);
        return -1;
      }
    },

    d1_batch: async (
      queriesPtr: number, queriesLen: number,
      resultPtr: number, resultLen: number
    ): Promise<number> => {
      try {
        const queries: Array<{ sql: string; params?: unknown[]; binding?: string }> =
          JSON.parse(mem.readString(queriesPtr, queriesLen));
        if (queries.length === 0) {
          const encoded = _encoder.encode("[]");
          return mem.writeBytes(resultPtr, encoded, resultLen);
        }

        const bindingName = queries[0].binding || "D1";
        const mismatch = queries.find((q) => (q.binding || "D1") !== bindingName);
        if (mismatch) {
          console.error(`d1_batch: mixed bindings (${bindingName} vs ${mismatch.binding})`);
          return -1;
        }
        const d1 = env[bindingName] as D1Database | undefined;
        if (!d1) return -1;

        const stmts = queries.map((q) =>
          d1.prepare(q.sql).bind(...(q.params || []))
        );
        const batchResults = await d1.batch(stmts);
        const allResults = batchResults.map((r) => r.results);
        const encoded = _encoder.encode(JSON.stringify(allResults));
        return mem.writeBytes(resultPtr, encoded, resultLen);
      } catch (e: unknown) {
        console.error("d1_batch error:", e);
        return -1;
      }
    },

    // --- Environment ---
    env_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
      const key = mem.readString(keyPtr, keyLen);
      const value = env[key];
      if (value === undefined || value === null) return -1;
      const encoded = _encoder.encode(String(value));
      return mem.writeBytes(bufPtr, encoded, bufLen);
    },

    // --- Threading ---
    thread_spawn: opts.threading
      ? async (codePtr: number, codeLen: number, inputPtr: number, inputLen: number): Promise<number> => {
          const code = mem.readString(codePtr, codeLen);
          const input = mem.getMemBytes().slice(inputPtr, inputPtr + inputLen);
          return opts.threading!.spawn(code, input);
        }
      : () => -1,

    thread_join: opts.threading
      ? async (threadId: number, bufPtr: number, bufLen: number): Promise<number> => {
          return opts.threading!.join(threadId, bufPtr, bufLen);
        }
      : () => -1,

    // --- Dynamic Loading ---
    dl_open: opts.dynamicLoading
      ? async (pathPtr: number, pathLen: number): Promise<number> => {
          return opts.dynamicLoading!.open(mem.readString(pathPtr, pathLen));
        }
      : () => -1,

    dl_sym: opts.dynamicLoading
      ? (handle: number, symbolPtr: number, symbolLen: number): number => {
          return opts.dynamicLoading!.sym(handle, mem.readString(symbolPtr, symbolLen));
        }
      : () => 0,

    dl_close: opts.dynamicLoading
      ? (handle: number): void => { opts.dynamicLoading!.close(handle); }
      : () => {},

    dl_error: opts.dynamicLoading
      ? (bufPtr: number, bufLen: number): number => {
          return opts.dynamicLoading!.error(bufPtr, bufLen);
        }
      : () => 0,

    // --- Zerobuf exchange ---
    zerobuf_exchange_ptr: (): number => {
      return opts.zerobufExchangePtr || 0;
    },

    // --- Logging ---
    console_log: (msgPtr: number, msgLen: number): void => {
      console.log(mem.readString(msgPtr, msgLen));
    },
  };
}
