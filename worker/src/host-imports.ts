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
import type { FanoutContext } from "./fanout";

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
  /** WASM memory reference — needed for JIT zerobuf allocation. Set after instantiation. */
  memory?: WebAssembly.Memory;
  /** Request data for JIT zerobuf exchange (written on first zerobuf_exchange_ptr call). */
  zerobufRequest?: { method: string; url: string; headersJson: string; body: string };
  /** Mutable ref — set by JIT zerobuf allocation so caller can read the exchange ptr. */
  zbExchangePtrRef?: { value: number | undefined };
  /** Fan-out context — if provided, async imports use record/cache instead of Promises. */
  fanout?: FanoutContext;
  /** If provided, enables thread_spawn/thread_join (handled via fan-out). */
  threading?: {
    spawn: (code: string, input: Uint8Array) => number;
    join: (threadId: number, bufPtr: number, bufLen: number) => number;
  };
  /** If provided, enables dl_open/dl_sym/dl_close/dl_error (synchronous). */
  dynamicLoading?: {
    open: (path: string) => number;
    sym: (handle: number, symbol: string) => number;
    close: (handle: number) => void;
    error: (bufPtr: number, bufLen: number) => number;
  };
}

/**
 * Build the pymode.* WASM import namespace.
 *
 * All imports are synchronous. Async operations use fan-out:
 * first pass records calls and returns sentinels, JS resolves
 * all pending calls in parallel, then replays with cached results.
 */
export function buildHostImports(opts: HostImportOptions): Record<string, any> {
  const { mem, env } = opts;
  const fanout = opts.fanout;

  // Zerobuf exchange pointer — set on first zerobuf_exchange_ptr call
  let zbExchangePtr: number | undefined;

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

    tcp_recv: (connId: number, bufPtr: number, bufLen: number): number => {
      // TCP recv is stateful — record as pending for fan-out resolution
      if (fanout) {
        const result = fanout.getOrRecord("tcp_recv", [connId]);
        if (result.cached && result.value != null) {
          const data = result.value as Uint8Array;
          const n = Math.min(data.length, bufLen);
          mem.getMemBytes().set(data.subarray(0, n), bufPtr);
          return n;
        }
        return 0; // EOF sentinel on first pass
      }
      return 0;
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
    http_fetch_full: (
      urlPtr: number, urlLen: number,
      methodPtr: number, methodLen: number,
      bodyPtr: number, bodyLen: number,
      headersPtr: number, headersLen: number,
      resultPtr: number, resultLen: number
    ): number => {
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
        const body = bodyLen > 0 ? mem.getMemBytes().slice(bodyPtr, bodyPtr + bodyLen) : null;
        const headersJson = headersLen > 0 ? mem.readString(headersPtr, headersLen) : "{}";
        if (!validateHeaders(JSON.parse(headersJson))) {
          console.error("http_fetch_full blocked: invalid headers (CRLF/null injection)");
          return -1;
        }

        if (fanout) {
          const result = fanout.getOrRecord("http_fetch_full", [url, method, body, headersJson]);
          if (result.cached && result.value != null) {
            const cached = result.value as { status: number; headers: Record<string, string>; body: Uint8Array };
            const headersBytes = _encoder.encode(JSON.stringify(cached.headers));
            const totalLen = 8 + headersBytes.length + cached.body.length;
            if (totalLen > resultLen) return -1;
            const memBytes = mem.getMemBytes();
            const dv = new DataView(memBytes.buffer);
            dv.setUint32(resultPtr, cached.status, true);
            dv.setUint32(resultPtr + 4, headersBytes.length, true);
            memBytes.set(headersBytes, resultPtr + 8);
            memBytes.set(cached.body, resultPtr + 8 + headersBytes.length);
            return totalLen;
          }
          return -1;
        }
        return -1;
      } catch (e: unknown) {
        console.error("http_fetch_full error:", e);
        return -1;
      }
    },

    // --- KV ---
    kv_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        if (fanout) {
          const result = fanout.getOrRecord("kv_get", [bindingName, key]);
          if (result.cached && result.value != null) {
            return mem.writeBytes(bufPtr, result.value as Uint8Array, bufLen);
          }
          return -1; // Not cached or null — key "not found" sentinel
        }
        return -1;
      } catch (e: unknown) {
        console.error("kv_get error:", e);
        return -1;
      }
    },

    kv_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        const val = mem.getMemBytes().slice(valPtr, valPtr + valLen);
        if (fanout) {
          fanout.recordWrite("kv_put", [bindingName, key, val]);
        }
      } catch (e: unknown) {
        console.error("kv_put error:", e);
      }
    },

    kv_delete: (keyPtr: number, keyLen: number): void => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "KV");
        if (fanout) {
          fanout.recordWrite("kv_delete", [bindingName, key]);
        }
      } catch (e: unknown) {
        console.error("kv_delete error:", e);
      }
    },

    kv_multi_get: (
      keysPtr: number, keysLen: number,
      resultPtr: number, resultLen: number
    ): number => {
      try {
        const keysJson: string[] = JSON.parse(mem.readString(keysPtr, keysLen));
        const parsedKeys = keysJson.map(raw => parseBindingKey(raw, "KV"));
        const bindingName = parsedKeys[0]?.[0] || "KV";
        const keys = parsedKeys.map(([, k]) => k);
        if (fanout) {
          const result = fanout.getOrRecord("kv_multi_get", [keys, bindingName]);
          if (result.cached && result.value != null) {
            const results = result.value as Array<Uint8Array | null>;
            const memBytes = mem.getMemBytes();
            const dv = new DataView(memBytes.buffer);
            dv.setInt32(resultPtr, results.length, true);
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
          }
        }
        return -1;
      } catch (e: unknown) {
        console.error("kv_multi_get error:", e);
        return -1;
      }
    },

    kv_multi_put: (dataPtr: number, dataLen: number): void => {
      try {
        const memBytes = mem.getMemBytes();
        const dv = new DataView(memBytes.buffer);
        const count = dv.getInt32(dataPtr, true);
        let offset = dataPtr + 4;
        const entries: Array<[string, Uint8Array]> = [];
        let bindingName = "KV";

        for (let i = 0; i < count; i++) {
          const keyLen = dv.getInt32(offset, true);
          offset += 4;
          const rawKey = _decoder.decode(memBytes.subarray(offset, offset + keyLen));
          offset += keyLen;
          const valLen = dv.getInt32(offset, true);
          offset += 4;
          const val = memBytes.slice(offset, offset + valLen);
          offset += valLen;

          const [bn, key] = parseBindingKey(rawKey, "KV");
          bindingName = bn;
          entries.push([key, val]);
        }

        if (fanout) {
          fanout.recordWrite("kv_multi_put", [entries, bindingName]);
        }
      } catch (e: unknown) {
        console.error("kv_multi_put error:", e);
      }
    },

    // --- R2 ---
    r2_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "R2");
        if (fanout) {
          const result = fanout.getOrRecord("r2_get", [bindingName, key]);
          if (result.cached && result.value != null) {
            return mem.writeBytes(bufPtr, result.value as Uint8Array, bufLen);
          }
        }
        return -1;
      } catch (e: unknown) {
        console.error("r2_get error:", e);
        return -1;
      }
    },

    r2_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
      try {
        const raw = mem.readString(keyPtr, keyLen);
        const [bindingName, key] = parseBindingKey(raw, "R2");
        const val = mem.getMemBytes().slice(valPtr, valPtr + valLen);
        if (fanout) {
          fanout.recordWrite("r2_put", [bindingName, key, val]);
        }
      } catch (e: unknown) {
        console.error("r2_put error:", e);
      }
    },

    // --- D1 ---
    d1_exec: (
      sqlPtr: number, sqlLen: number,
      paramsPtr: number, paramsLen: number,
      resultPtr: number, resultLen: number
    ): number => {
      try {
        const rawSql = mem.readString(sqlPtr, sqlLen);
        const [bindingName, sql] = parseBindingKey(rawSql, "D1");
        const params = JSON.parse(mem.readString(paramsPtr, paramsLen));
        if (fanout) {
          const result = fanout.getOrRecord("d1_exec", [bindingName, sql, params]);
          if (result.cached && result.value != null) {
            const encoded = _encoder.encode(JSON.stringify(result.value));
            return mem.writeBytes(resultPtr, encoded, resultLen);
          }
        }
        return -1;
      } catch (e: unknown) {
        console.error("d1_exec error:", e);
        return -1;
      }
    },

    d1_batch: (
      queriesPtr: number, queriesLen: number,
      resultPtr: number, resultLen: number
    ): number => {
      try {
        const queries: Array<{ sql: string; params?: unknown[]; binding?: string }> =
          JSON.parse(mem.readString(queriesPtr, queriesLen));
        if (queries.length === 0) {
          const encoded = _encoder.encode("[]");
          return mem.writeBytes(resultPtr, encoded, resultLen);
        }

        const bindingName = queries[0].binding || "D1";
        if (fanout) {
          const result = fanout.getOrRecord("d1_batch", [bindingName, queries]);
          if (result.cached && result.value != null) {
            const encoded = _encoder.encode(JSON.stringify(result.value));
            return mem.writeBytes(resultPtr, encoded, resultLen);
          }
        }
        return -1;
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
    thread_spawn: (codePtr: number, codeLen: number, inputPtr: number, inputLen: number): number => {
      if (fanout) {
        const code = mem.readString(codePtr, codeLen);
        const input = mem.getMemBytes().slice(inputPtr, inputPtr + inputLen);
        const result = fanout.getOrRecord("thread_spawn", [code, input]);
        if (result.cached) return result.value as number;
      }
      return -1;
    },

    thread_join: (threadId: number, bufPtr: number, bufLen: number): number => {
      if (fanout) {
        const result = fanout.getOrRecord("thread_join", [threadId]);
        if (result.cached && result.value != null) {
          const data = result.value as Uint8Array;
          return mem.writeBytes(bufPtr, data, bufLen);
        }
      }
      return -1;
    },

    // --- Dynamic Loading ---
    dl_open: (pathPtr: number, pathLen: number): number => {
      if (fanout && opts.dynamicLoading) {
        const path = mem.readString(pathPtr, pathLen);
        const result = fanout.getOrRecord("dl_open", [path]);
        if (result.cached) return result.value as number;
      }
      return -1;
    },

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
    // JIT allocation: grow memory and write request data when Python first asks.
    // This happens AFTER CPython's sbrk has claimed its heap, so the new page
    // is beyond __curbrk and won't be overwritten by heap allocations.
    zerobuf_exchange_ptr: (): number => {
      if (!opts.memory || !opts.zerobufRequest) return 0;
      if (zbExchangePtr !== undefined) return zbExchangePtr;
      zbExchangePtr = zbWriteRequest(
        opts.memory,
        opts.zerobufRequest.method,
        opts.zerobufRequest.url,
        opts.zerobufRequest.headersJson,
        opts.zerobufRequest.body,
      );
      if (opts.zbExchangePtrRef) opts.zbExchangePtrRef.value = zbExchangePtr;
      return zbExchangePtr;
    },

    // --- Logging ---
    console_log: (msgPtr: number, msgLen: number): void => {
      console.log(mem.readString(msgPtr, msgLen));
    },
  };
}
