/**
 * WASI and Cloudflare service bindings for the Python WASM runtime
 *
 * Maps WASI system calls to Cloudflare Workers APIs:
 * - fd_read/fd_write → console.log (stdout/stderr)
 * - path_open/fd_read → R2 bucket reads
 * - Environment variables → Worker env bindings
 *
 * Also provides the zigpython bridge namespace for:
 * - fetch() → Cloudflare fetch API
 * - kv_get/kv_put → KV namespace
 * - d1_exec → D1 database
 */

import type { Env } from "./worker";

// WASI error codes
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;
const ERRNO_NOENT = 44;
const ERRNO_INVAL = 28;

// File descriptors: 0=stdin, 1=stdout, 2=stderr
const STDOUT_FD = 1;
const STDERR_FD = 2;

interface WasiBindings {
  wasi: Record<string, (...args: number[]) => number>;
  env: Record<string, (...args: number[]) => number>;
  bridge: Record<string, (...args: number[]) => number | Promise<number>>;
}

export function createBindings(env: Env, memory: WebAssembly.Memory): WasiBindings {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Pending async results stored here so WASM can poll for completion
  // Key: request ID, Value: JSON-encoded result or null if pending
  const asyncResults = new Map<number, string | null>();
  let nextRequestId = 1;

  function readString(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
  }

  function writeString(ptr: number, maxLen: number, str: string): number {
    const bytes = encoder.encode(str);
    const writeLen = Math.min(bytes.length, maxLen);
    new Uint8Array(memory.buffer, ptr, writeLen).set(bytes.subarray(0, writeLen));
    return writeLen;
  }

  function writeToMemory(ptr: number, maxLen: number, data: Uint8Array): number {
    const writeLen = Math.min(data.length, maxLen);
    new Uint8Array(memory.buffer, ptr, writeLen).set(data.subarray(0, writeLen));
    return writeLen;
  }

  // Allocate memory in WASM linear memory using the exported malloc
  function wasmMalloc(size: number): number {
    const instance = (memory as unknown as { _instance?: WebAssembly.Instance })._instance;
    if (instance) {
      const malloc = instance.exports["malloc"] as (size: number) => number;
      return malloc(size);
    }
    return 0;
  }

  // Write a JSON result into WASM memory and return the pointer
  function writeResultToWasm(result: string): number {
    const bytes = encoder.encode(result);
    const ptr = wasmMalloc(bytes.length + 1);
    if (ptr === 0) return 0;
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
    new Uint8Array(memory.buffer)[ptr + bytes.length] = 0; // null terminate
    return ptr;
  }

  // Collect environment variables for Python's os.environ
  const envVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      envVars[key] = value;
    }
  }

  const wasi: Record<string, (...args: number[]) => number> = {
    // Process exit
    proc_exit(code: number): number {
      if (code !== 0) {
        console.error(`Python process exited with code ${code}`);
      }
      return ERRNO_SUCCESS;
    },

    // Write to file descriptor (stdout/stderr → console)
    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      if (fd !== STDOUT_FD && fd !== STDERR_FD) return ERRNO_BADF;

      const view = new DataView(memory.buffer);
      let totalWritten = 0;
      const chunks: string[] = [];

      for (let i = 0; i < iovsLen; i++) {
        const bufPtr = view.getUint32(iovsPtr + i * 8, true);
        const bufLen = view.getUint32(iovsPtr + i * 8 + 4, true);
        chunks.push(readString(bufPtr, bufLen));
        totalWritten += bufLen;
      }

      const output = chunks.join("");
      if (fd === STDOUT_FD) {
        console.log(output);
      } else {
        console.error(output);
      }

      view.setUint32(nwrittenPtr, totalWritten, true);
      return ERRNO_SUCCESS;
    },

    // Read from file descriptor
    fd_read(_fd: number, _iovsPtr: number, _iovsLen: number, nreadPtr: number): number {
      // stdin reads return 0 bytes (EOF) in Workers context
      const view = new DataView(memory.buffer);
      view.setUint32(nreadPtr, 0, true);
      return ERRNO_SUCCESS;
    },

    // Close file descriptor
    fd_close(_fd: number): number {
      return ERRNO_SUCCESS;
    },

    // Seek file descriptor
    fd_seek(_fd: number, _offset: number, _whence: number, _newoffsetPtr: number): number {
      return ERRNO_NOSYS;
    },

    // File descriptor stat
    fd_fdstat_get(fd: number, bufPtr: number): number {
      const view = new DataView(memory.buffer);
      // filetype: regular file (4) for stdin/stdout/stderr
      view.setUint8(bufPtr, fd <= 2 ? 2 : 4); // 2 = character device
      view.setUint16(bufPtr + 2, 0, true); // flags
      view.setBigUint64(bufPtr + 8, BigInt(0), true); // rights_base
      view.setBigUint64(bufPtr + 16, BigInt(0), true); // rights_inheriting
      return ERRNO_SUCCESS;
    },

    // Pre-open directory stat
    fd_prestat_get(_fd: number, _bufPtr: number): number {
      return ERRNO_BADF;
    },

    fd_prestat_dir_name(_fd: number, _pathPtr: number, _pathLen: number): number {
      return ERRNO_BADF;
    },

    // Environment
    environ_sizes_get(countPtr: number, bufSizePtr: number): number {
      const view = new DataView(memory.buffer);
      const entries = Object.entries(envVars);
      view.setUint32(countPtr, entries.length, true);

      let totalSize = 0;
      for (const [key, value] of entries) {
        totalSize += encoder.encode(`${key}=${value}\0`).length;
      }
      view.setUint32(bufSizePtr, totalSize, true);
      return ERRNO_SUCCESS;
    },

    environ_get(environPtr: number, bufPtr: number): number {
      const view = new DataView(memory.buffer);
      let currentBuf = bufPtr;
      let ptrOffset = 0;

      for (const [key, value] of Object.entries(envVars)) {
        view.setUint32(environPtr + ptrOffset, currentBuf, true);
        ptrOffset += 4;

        const envStr = `${key}=${value}\0`;
        const written = writeString(currentBuf, envStr.length, envStr);
        currentBuf += written;
      }

      return ERRNO_SUCCESS;
    },

    // Arguments (python interpreter args)
    args_sizes_get(countPtr: number, bufSizePtr: number): number {
      const view = new DataView(memory.buffer);
      view.setUint32(countPtr, 1, true); // just "python"
      view.setUint32(bufSizePtr, 7, true); // "python\0"
      return ERRNO_SUCCESS;
    },

    args_get(argvPtr: number, bufPtr: number): number {
      const view = new DataView(memory.buffer);
      view.setUint32(argvPtr, bufPtr, true);
      writeString(bufPtr, 7, "python\0");
      return ERRNO_SUCCESS;
    },

    // Clock
    clock_time_get(_id: number, _precision: number, timePtr: number): number {
      const view = new DataView(memory.buffer);
      const now = BigInt(Date.now()) * BigInt(1_000_000); // ms to ns
      view.setBigUint64(timePtr, now, true);
      return ERRNO_SUCCESS;
    },

    // Random
    random_get(bufPtr: number, bufLen: number): number {
      const buf = new Uint8Array(memory.buffer, bufPtr, bufLen);
      crypto.getRandomValues(buf);
      return ERRNO_SUCCESS;
    },

    // Unsupported WASI calls - return appropriate error codes
    path_open(): number { return ERRNO_NOSYS; },
    path_filestat_get(): number { return ERRNO_NOSYS; },
    path_create_directory(): number { return ERRNO_NOSYS; },
    path_remove_directory(): number { return ERRNO_NOSYS; },
    path_unlink_file(): number { return ERRNO_NOSYS; },
    path_rename(): number { return ERRNO_NOSYS; },
    path_readlink(): number { return ERRNO_NOSYS; },
    path_symlink(): number { return ERRNO_NOSYS; },
    poll_oneoff(): number { return ERRNO_NOSYS; },
    sched_yield(): number { return ERRNO_SUCCESS; },
    sock_accept(): number { return ERRNO_NOSYS; },
    sock_recv(): number { return ERRNO_NOSYS; },
    sock_send(): number { return ERRNO_NOSYS; },
    sock_shutdown(): number { return ERRNO_NOSYS; },
  };

  // Bridge functions: Cloudflare service bindings exposed as WASM imports.
  // Python code calls these through a thin C shim that the WASM module exports.
  // Each function takes pointers into WASM linear memory and returns status codes.
  const bridge: Record<string, (...args: number[]) => number | Promise<number>> = {

    // ========================================================================
    // R2 Storage (maps to Python's open() for file I/O)
    // ========================================================================

    // r2_get(keyPtr, keyLen, bufPtr, bufMaxLen, bytesReadPtr) -> errno
    // Reads an object from R2 into the provided buffer.
    r2_get(keyPtr: number, keyLen: number, bufPtr: number, bufMaxLen: number, bytesReadPtr: number): number {
      const storage = env.STORAGE;
      if (!storage) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);
      const view = new DataView(memory.buffer);

      // R2 get is async - store request ID and return it
      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      storage.get(key).then(async (obj) => {
        if (!obj) {
          asyncResults.set(requestId, JSON.stringify({ error: ERRNO_NOENT, bytesRead: 0 }));
          return;
        }
        const data = new Uint8Array(await obj.arrayBuffer());
        const written = writeToMemory(bufPtr, bufMaxLen, data);
        view.setUint32(bytesReadPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS, bytesRead: written }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, bytesRead: 0 }));
      });

      return requestId;
    },

    // r2_put(keyPtr, keyLen, dataPtr, dataLen) -> errno
    // Writes data to an R2 object.
    r2_put(keyPtr: number, keyLen: number, dataPtr: number, dataLen: number): number {
      const storage = env.STORAGE;
      if (!storage) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);
      const data = new Uint8Array(memory.buffer, dataPtr, dataLen).slice();

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      storage.put(key, data).then(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL }));
      });

      return requestId;
    },

    // r2_delete(keyPtr, keyLen) -> errno
    // Deletes an R2 object.
    r2_delete(keyPtr: number, keyLen: number): number {
      const storage = env.STORAGE;
      if (!storage) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      storage.delete(key).then(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL }));
      });

      return requestId;
    },

    // r2_list(prefixPtr, prefixLen, resultBufPtr, resultBufMaxLen, resultLenPtr) -> requestId
    // Lists R2 objects by prefix. Returns JSON array of keys.
    r2_list(prefixPtr: number, prefixLen: number, resultBufPtr: number, resultBufMaxLen: number, resultLenPtr: number): number {
      const storage = env.STORAGE;
      if (!storage) return ERRNO_NOSYS;

      const prefix = readString(prefixPtr, prefixLen);
      const view = new DataView(memory.buffer);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      storage.list({ prefix }).then((listing) => {
        const keys = listing.objects.map((obj) => obj.key);
        const json = JSON.stringify(keys);
        const written = writeString(resultBufPtr, resultBufMaxLen, json);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS, len: written }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, len: 0 }));
      });

      return requestId;
    },

    // ========================================================================
    // KV Namespace (maps to Python's shelve/dbm)
    // ========================================================================

    // kv_get(keyPtr, keyLen, valueBufPtr, valueBufMaxLen, valueLenPtr) -> requestId
    // Gets a value from KV by key. Returns the value as a UTF-8 string.
    kv_get(keyPtr: number, keyLen: number, valueBufPtr: number, valueBufMaxLen: number, valueLenPtr: number): number {
      const kv = env.KV;
      if (!kv) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);
      const view = new DataView(memory.buffer);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      kv.get(key).then((value) => {
        if (value === null) {
          view.setUint32(valueLenPtr, 0, true);
          asyncResults.set(requestId, JSON.stringify({ error: ERRNO_NOENT, len: 0 }));
          return;
        }
        const written = writeString(valueBufPtr, valueBufMaxLen, value);
        view.setUint32(valueLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS, len: written }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, len: 0 }));
      });

      return requestId;
    },

    // kv_put(keyPtr, keyLen, valuePtr, valueLen) -> requestId
    // Stores a value in KV.
    kv_put(keyPtr: number, keyLen: number, valuePtr: number, valueLen: number): number {
      const kv = env.KV;
      if (!kv) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);
      const value = readString(valuePtr, valueLen);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      kv.put(key, value).then(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL }));
      });

      return requestId;
    },

    // kv_delete(keyPtr, keyLen) -> requestId
    // Deletes a key from KV.
    kv_delete(keyPtr: number, keyLen: number): number {
      const kv = env.KV;
      if (!kv) return ERRNO_NOSYS;

      const key = readString(keyPtr, keyLen);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      kv.delete(key).then(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL }));
      });

      return requestId;
    },

    // ========================================================================
    // D1 Database (maps to Python's sqlite3)
    // ========================================================================

    // d1_exec(sqlPtr, sqlLen, resultBufPtr, resultBufMaxLen, resultLenPtr) -> requestId
    // Executes a SQL statement against D1 and returns the result as JSON.
    d1_exec(sqlPtr: number, sqlLen: number, resultBufPtr: number, resultBufMaxLen: number, resultLenPtr: number): number {
      const db = env.DB;
      if (!db) return ERRNO_NOSYS;

      const sql = readString(sqlPtr, sqlLen);
      const view = new DataView(memory.buffer);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      db.prepare(sql).all().then((result) => {
        const json = JSON.stringify(result.results);
        const written = writeString(resultBufPtr, resultBufMaxLen, json);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS, len: written }));
      }).catch((err) => {
        const errJson = JSON.stringify({ error: String(err) });
        const written = writeString(resultBufPtr, resultBufMaxLen, errJson);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, len: written }));
      });

      return requestId;
    },

    // d1_exec_bind(sqlPtr, sqlLen, paramsPtr, paramsLen, resultBufPtr, resultBufMaxLen, resultLenPtr) -> requestId
    // Executes a parameterized SQL statement. Params are JSON-encoded array.
    d1_exec_bind(sqlPtr: number, sqlLen: number, paramsPtr: number, paramsLen: number, resultBufPtr: number, resultBufMaxLen: number, resultLenPtr: number): number {
      const db = env.DB;
      if (!db) return ERRNO_NOSYS;

      const sql = readString(sqlPtr, sqlLen);
      const paramsJson = readString(paramsPtr, paramsLen);
      const view = new DataView(memory.buffer);

      let params: unknown[];
      try {
        params = JSON.parse(paramsJson);
      } catch {
        return ERRNO_INVAL;
      }

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      db.prepare(sql).bind(...params).all().then((result) => {
        const json = JSON.stringify(result.results);
        const written = writeString(resultBufPtr, resultBufMaxLen, json);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_SUCCESS, len: written }));
      }).catch((err) => {
        const errJson = JSON.stringify({ error: String(err) });
        const written = writeString(resultBufPtr, resultBufMaxLen, errJson);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, len: written }));
      });

      return requestId;
    },

    // ========================================================================
    // Fetch API (maps to Python's urllib.request)
    // ========================================================================

    // fetch_url(urlPtr, urlLen, methodPtr, methodLen, bodyPtr, bodyLen,
    //           resultBufPtr, resultBufMaxLen, resultLenPtr) -> requestId
    // Performs an HTTP fetch and writes the response body to the result buffer.
    fetch_url(
      urlPtr: number, urlLen: number,
      methodPtr: number, methodLen: number,
      bodyPtr: number, bodyLen: number,
      resultBufPtr: number, resultBufMaxLen: number, resultLenPtr: number,
    ): number {
      const url = readString(urlPtr, urlLen);
      const method = readString(methodPtr, methodLen);
      const view = new DataView(memory.buffer);

      const requestId = nextRequestId++;
      asyncResults.set(requestId, null);

      const fetchOptions: RequestInit = { method };
      if (bodyLen > 0) {
        fetchOptions.body = new Uint8Array(memory.buffer, bodyPtr, bodyLen).slice();
      }

      fetch(url, fetchOptions).then(async (response) => {
        const data = new Uint8Array(await response.arrayBuffer());
        const written = writeToMemory(resultBufPtr, resultBufMaxLen, data);
        view.setUint32(resultLenPtr, written, true);
        asyncResults.set(requestId, JSON.stringify({
          error: ERRNO_SUCCESS,
          status: response.status,
          len: written,
          totalLen: data.length,
        }));
      }).catch(() => {
        asyncResults.set(requestId, JSON.stringify({ error: ERRNO_INVAL, status: 0, len: 0 }));
      });

      return requestId;
    },

    // ========================================================================
    // Async result polling
    // ========================================================================

    // async_poll(requestId, resultBufPtr, resultBufMaxLen) -> 0 if ready, 1 if pending
    // Checks if an async operation has completed. If ready, writes the result JSON.
    async_poll(requestId: number, resultBufPtr: number, resultBufMaxLen: number): number {
      const result = asyncResults.get(requestId);
      if (result === undefined) return ERRNO_INVAL;
      if (result === null) return 1; // still pending

      writeString(resultBufPtr, resultBufMaxLen, result);
      asyncResults.delete(requestId);
      return 0; // ready
    },
  };

  return { wasi, env: {}, bridge };
}
