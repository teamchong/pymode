// Test worker for vitest-pool-workers.
//
// This is the entry point that runs inside workerd for integration tests.
// It imports the real python.wasm and stdlib-fs from the main worker,
// then uses the production WASI implementation from worker/src/worker.ts
// to run Python code — proving the full pipeline works in the Cloudflare runtime.
//
// The production worker.ts cannot be used directly because it has conditional
// require() calls for deploy-time generated modules (user-files, site-packages.zip)
// that fail in the vitest-pool-workers module resolver. Instead, we import the
// WASM + stdlib and re-use the createWasi/runWasm functions extracted here.

import pythonWasm from "../worker/src/python.wasm";
import { stdlibFS } from "../worker/src/stdlib-fs";

// Re-export for cloudflare:test SELF binding
export default {
  async fetch(request: Request): Promise<Response> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Build VFS from stdlib (same as production worker)
    const files: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(stdlibFS)) {
      files[path] = encoder.encode(content);
    }

    let code: string;
    if (request.method === "POST") {
      code = await request.text();
    } else {
      const url = new URL(request.url);
      code = url.searchParams.get("code") || "print('Hello from PyMode!')";
    }

    try {
      const result = await runWasm(
        ["python", "-S", "-c", code],
        { PYTHONPATH: "/stdlib", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
        files
      );

      const stdout = decoder.decode(result.stdout);
      const stderr = decoder.decode(result.stderr);

      if (result.exitCode === 0) {
        return new Response(stdout || "(empty output)\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
        });
      }

      return new Response(stdout + stderr, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      return new Response(`Error: ${msg}\n`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};

// ============================================================
// WASI implementation — extracted from worker/src/worker.ts
// This is the same code that runs in production.
// ============================================================

class ProcExit extends Error {
  code: number;
  constructor(code: number) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

interface WasiResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  writtenFiles: Map<string, Uint8Array>;
}

async function runWasm(
  args: string[],
  env: Record<string, string>,
  files: Record<string, Uint8Array>
): Promise<WasiResult> {
  let memory: WebAssembly.Memory | undefined;
  const wasi = createWasi(args, env, files, () => memory!);

  try {
    // WebAssembly.instantiate() with a Module (CompiledWasm binding) returns
    // Instance directly. With an ArrayBuffer it returns { module, instance }.
    // pymode.* host imports — these are the JS↔WASM bridge functions that the
    // production PythonDO provides (TCP, HTTP, KV, R2, D1, etc.). In the test
    // environment, the Python code under test doesn't call these directly, so
    // they return error codes indicating "not available".
    const pymode: Record<string, Function> = {
      tcp_connect: () => -1,
      tcp_send: () => -1,
      tcp_recv: () => -1,
      tcp_close: () => {},
      http_fetch: () => -1,
      http_response_status: () => 0,
      http_response_read: () => 0,
      http_response_header: () => -1,
      kv_get: () => -1,
      kv_put: () => {},
      kv_delete: () => {},
      r2_get: () => -1,
      r2_put: () => {},
      d1_exec: () => -1,
      env_get: () => -1,
      thread_spawn: () => -1,
      thread_join: () => -1,
      dl_open: () => -1,
      dl_sym: () => 0,
      dl_close: () => {},
      dl_error: () => 0,
      console_log: () => {},
    };

    // Asyncify runtime functions injected by wasm-opt --asyncify.
    // These manage stack unwinding/rewinding for async host calls.
    // Since tests run synchronous Python, these are never invoked.
    const asyncify: Record<string, Function> = {
      start_unwind: () => {},
      stop_unwind: () => {},
      start_rewind: () => {},
      stop_rewind: () => {},
    };

    const result = await WebAssembly.instantiate(pythonWasm, {
      wasi_snapshot_preview1: wasi.imports,
      pymode,
      asyncify,
    });
    const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
    memory = instance.exports.memory as WebAssembly.Memory;
    const start = instance.exports._start as () => void;
    start();
    return {
      exitCode: 0,
      stdout: wasi.getStdout(),
      stderr: wasi.getStderr(),
      writtenFiles: wasi.getWrittenFiles(),
    };
  } catch (e: unknown) {
    if (e instanceof ProcExit) {
      return {
        exitCode: e.code,
        stdout: wasi.getStdout(),
        stderr: wasi.getStderr(),
        writtenFiles: wasi.getWrittenFiles(),
      };
    }
    throw e;
  }
}

function createWasi(
  args: string[],
  env: Record<string, string>,
  files: Record<string, Uint8Array>,
  getMemory: () => WebAssembly.Memory,
  stdinData?: Uint8Array
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const FD_STDIN = 0;
  const FD_STDOUT = 1;
  const FD_STDERR = 2;
  const FD_PREOPEN = 3;       // /stdlib (read-only stdlib + pymode runtime)
  const FD_DATA_PREOPEN = 4;  // /data (read-write, backed by CF KV)

  const preopenPath = "/stdlib";
  const dataPreopenPath = "/data";

  interface OpenFile {
    path: string;
    data: Uint8Array;
    offset: number;
    isDir: boolean;
    writable: boolean;
  }

  const openFiles = new Map<number, OpenFile>();
  let nextFd = FD_DATA_PREOPEN + 1;

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdinOffset = 0;

  const writtenFiles = new Map<string, Uint8Array>();

  // Build directory index from file paths
  const dirChildren = new Map<string, string[]>();
  dirChildren.set("", []);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i).join("/");
      const child = parts[i];
      if (!dirChildren.has(parent)) dirChildren.set(parent, []);
      const list = dirChildren.get(parent)!;
      if (!list.includes(child)) list.push(child);
      const full = parts.slice(0, i + 1).join("/");
      if (!dirChildren.has(full)) dirChildren.set(full, []);
    }
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    if (!dirChildren.has(dir)) dirChildren.set(dir, []);
    const list = dirChildren.get(dir)!;
    if (!list.includes(name)) list.push(name);
  }

  // Ensure /tmp and /data directories exist
  for (const d of ["tmp", "data"]) {
    if (!dirChildren.has(d)) {
      dirChildren.set(d, []);
      const root = dirChildren.get("")!;
      if (!root.includes(d)) root.push(d);
    }
  }

  function isDir(path: string): boolean {
    return dirChildren.has(path);
  }

  function fileExists(path: string): boolean {
    return writtenFiles.has(path) || path in files;
  }

  function fileData(path: string): Uint8Array | undefined {
    return writtenFiles.get(path) || files[path];
  }

  function ensureDir(path: string): void {
    if (dirChildren.has(path)) return;
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirChildren.has(dir)) {
        dirChildren.set(dir, []);
        const parent = parts.slice(0, i - 1).join("/");
        if (!dirChildren.has(parent)) dirChildren.set(parent, []);
        const parentList = dirChildren.get(parent)!;
        const name = parts[i - 1];
        if (!parentList.includes(name)) parentList.push(name);
      }
    }
  }

  function registerFile(path: string): void {
    const parts = path.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    ensureDir(dir);
    const list = dirChildren.get(dir)!;
    if (!list.includes(name)) list.push(name);
  }

  function view(): DataView { return new DataView(getMemory().buffer); }
  function mem(): Uint8Array { return new Uint8Array(getMemory().buffer); }

  const ESUCCESS = 0;
  const EBADF = 8;
  const EEXIST = 20;
  const EINVAL = 28;
  const EISDIR = 31;
  const ENOENT = 44;
  const ENOSYS = 52;
  const ENOTDIR = 54;

  function normalizePath(p: string): string {
    let r = p.replace(/^\.\//, "").replace(/\/\.\//g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
    if (r === ".") r = "";
    return r;
  }

  function resolvePath(dirFd: number, relPath: string): string | null {
    if (dirFd === FD_PREOPEN) return normalizePath(relPath);
    if (dirFd === FD_DATA_PREOPEN) return normalizePath("data/" + relPath);
    const dir = openFiles.get(dirFd);
    if (!dir) return null;
    if (dir.path === "") return normalizePath(relPath);
    return normalizePath(dir.path + "/" + relPath);
  }

  const imports = {
    args_get(argvPtr: number, bufPtr: number): number {
      const v = view();
      for (const arg of args) {
        v.setUint32(argvPtr, bufPtr, true);
        argvPtr += 4;
        const bytes = encoder.encode(arg + "\0");
        mem().set(bytes, bufPtr);
        bufPtr += bytes.length;
      }
      return ESUCCESS;
    },

    args_sizes_get(countPtr: number, sizePtr: number): number {
      const v = view();
      v.setUint32(countPtr, args.length, true);
      let size = 0;
      for (const arg of args) size += encoder.encode(arg + "\0").length;
      v.setUint32(sizePtr, size, true);
      return ESUCCESS;
    },

    environ_get(envPtr: number, bufPtr: number): number {
      const v = view();
      for (const [key, val] of Object.entries(env)) {
        v.setUint32(envPtr, bufPtr, true);
        envPtr += 4;
        const bytes = encoder.encode(`${key}=${val}\0`);
        mem().set(bytes, bufPtr);
        bufPtr += bytes.length;
      }
      return ESUCCESS;
    },

    environ_sizes_get(countPtr: number, sizePtr: number): number {
      const v = view();
      const entries = Object.entries(env);
      v.setUint32(countPtr, entries.length, true);
      let size = 0;
      for (const [key, val] of entries) size += encoder.encode(`${key}=${val}\0`).length;
      v.setUint32(sizePtr, size, true);
      return ESUCCESS;
    },

    clock_time_get(_id: number, _precision: bigint, retPtr: number): number {
      view().setBigUint64(retPtr, BigInt(Date.now()) * BigInt(1_000_000), true);
      return ESUCCESS;
    },

    clock_res_get(_id: number, retPtr: number): number {
      view().setBigUint64(retPtr, BigInt(1_000_000), true);
      return ESUCCESS;
    },

    fd_write(fd: number, iovsPtr: number, iovsLen: number, retPtr: number): number {
      const v = view();
      const m = mem();
      let written = 0;

      if (fd === FD_STDOUT || fd === FD_STDERR) {
        const chunks = fd === FD_STDOUT ? stdoutChunks : stderrChunks;
        for (let i = 0; i < iovsLen; i++) {
          const bufPtr = v.getUint32(iovsPtr + i * 8, true);
          const bufLen = v.getUint32(iovsPtr + i * 8 + 4, true);
          if (bufLen > 0) {
            chunks.push(m.slice(bufPtr, bufPtr + bufLen));
            written += bufLen;
          }
        }
        v.setUint32(retPtr, written, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file || !file.writable) return file ? EBADF : EBADF;

      for (let i = 0; i < iovsLen; i++) {
        const bufPtr = v.getUint32(iovsPtr + i * 8, true);
        const bufLen = v.getUint32(iovsPtr + i * 8 + 4, true);
        if (bufLen > 0) {
          const chunk = m.slice(bufPtr, bufPtr + bufLen);
          const newData = new Uint8Array(Math.max(file.data.length, file.offset + bufLen));
          newData.set(file.data);
          newData.set(chunk, file.offset);
          file.data = newData;
          file.offset += bufLen;
          written += bufLen;
        }
      }
      writtenFiles.set(file.path, file.data);
      registerFile(file.path);
      v.setUint32(retPtr, written, true);
      return ESUCCESS;
    },

    fd_read(fd: number, iovsPtr: number, iovsLen: number, retPtr: number): number {
      const v = view();
      const m = mem();

      if (fd === FD_STDIN) {
        if (!stdinData || stdinOffset >= stdinData.length) {
          v.setUint32(retPtr, 0, true);
          return ESUCCESS;
        }
        let totalRead = 0;
        for (let i = 0; i < iovsLen; i++) {
          const bufPtr = v.getUint32(iovsPtr + i * 8, true);
          const bufLen = v.getUint32(iovsPtr + i * 8 + 4, true);
          const remaining = stdinData.length - stdinOffset;
          const toRead = Math.min(bufLen, remaining);
          if (toRead > 0) {
            m.set(stdinData.subarray(stdinOffset, stdinOffset + toRead), bufPtr);
            stdinOffset += toRead;
            totalRead += toRead;
          }
          if (stdinOffset >= stdinData.length) break;
        }
        v.setUint32(retPtr, totalRead, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file) { v.setUint32(retPtr, 0, true); return EBADF; }

      let totalRead = 0;
      for (let i = 0; i < iovsLen; i++) {
        const bufPtr = v.getUint32(iovsPtr + i * 8, true);
        const bufLen = v.getUint32(iovsPtr + i * 8 + 4, true);
        const remaining = file.data.length - file.offset;
        const toRead = Math.min(bufLen, remaining);
        if (toRead > 0) {
          m.set(file.data.subarray(file.offset, file.offset + toRead), bufPtr);
          file.offset += toRead;
          totalRead += toRead;
        }
      }
      v.setUint32(retPtr, totalRead, true);
      return ESUCCESS;
    },

    fd_close(fd: number): number {
      openFiles.delete(fd);
      return ESUCCESS;
    },

    fd_seek(fd: number, offset: bigint, whence: number, retPtr: number): number {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      const off = Number(offset);
      if (whence === 0) file.offset = off;
      else if (whence === 1) file.offset += off;
      else if (whence === 2) file.offset = file.data.length + off;
      view().setBigUint64(retPtr, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_tell(fd: number, retPtr: number): number {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      view().setBigUint64(retPtr, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_fdstat_get(fd: number, retPtr: number): number {
      const v = view();
      const m = mem();
      m.fill(0, retPtr, retPtr + 24);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr, 2); // CHARACTER_DEVICE
        v.setBigUint64(retPtr + 8, BigInt(0x1FF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FF), true);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN || fd === FD_DATA_PREOPEN) {
        v.setUint8(retPtr, 3); // DIRECTORY
        v.setBigUint64(retPtr + 8, BigInt(0x1FFFFFF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FFFFFF), true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      v.setUint8(retPtr, file.isDir ? 3 : 4);
      v.setBigUint64(retPtr + 8, BigInt(0x1FFFFFF), true);
      v.setBigUint64(retPtr + 16, BigInt(0x1FFFFFF), true);
      return ESUCCESS;
    },

    fd_fdstat_set_flags(): number { return ESUCCESS; },

    fd_filestat_get(fd: number, retPtr: number): number {
      const v = view();
      const m = mem();
      m.fill(0, retPtr, retPtr + 64);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr + 16, 2);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN || fd === FD_DATA_PREOPEN) {
        v.setUint8(retPtr + 16, 3);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      v.setUint8(retPtr + 16, file.isDir ? 3 : 4);
      v.setBigUint64(retPtr + 32, BigInt(file.data.length), true);
      return ESUCCESS;
    },

    fd_filestat_set_size(): number { return ESUCCESS; },
    fd_filestat_set_times(): number { return ESUCCESS; },

    fd_prestat_get(fd: number, retPtr: number): number {
      const preopens: Record<number, string> = {
        [FD_PREOPEN]: preopenPath,
        [FD_DATA_PREOPEN]: dataPreopenPath,
      };
      const path = preopens[fd];
      if (path !== undefined) {
        const v = view();
        v.setUint8(retPtr, 0); // PREOPENTYPE_DIR
        v.setUint32(retPtr + 4, encoder.encode(path).length, true);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
      const preopens: Record<number, string> = {
        [FD_PREOPEN]: preopenPath,
        [FD_DATA_PREOPEN]: dataPreopenPath,
      };
      const path = preopens[fd];
      if (path !== undefined) {
        mem().set(encoder.encode(path).subarray(0, pathLen), pathPtr);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_advise(): number { return ESUCCESS; },
    fd_datasync(): number { return ESUCCESS; },
    fd_sync(): number { return ESUCCESS; },

    fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, retPtr: number): number {
      const file = openFiles.get(fd);
      if (!file) { view().setUint32(retPtr, 0, true); return EBADF; }
      const savedOffset = file.offset;
      file.offset = Number(offset);
      const result = imports.fd_read(fd, iovsPtr, iovsLen, retPtr);
      file.offset = savedOffset;
      return result;
    },

    fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, _offset: bigint, retPtr: number): number {
      return imports.fd_write(fd, iovsPtr, iovsLen, retPtr);
    },

    fd_readdir(fd: number, bufPtr: number, bufLen: number, cookie: bigint, retPtr: number): number {
      const v = view();
      const m = mem();
      const file = openFiles.get(fd);
      if (!file || !file.isDir) {
        v.setUint32(retPtr, 0, true);
        return file ? ENOTDIR : EBADF;
      }

      const children = dirChildren.get(file.path) || [];
      let offset = 0;
      const startIdx = Number(cookie);

      for (let i = startIdx; i < children.length; i++) {
        const name = children[i];
        const nameBytes = encoder.encode(name);
        const entrySize = 24 + nameBytes.length;
        if (offset + entrySize > bufLen) break;

        // WASI dirent: d_next(8) + d_ino(8) + d_namlen(4) + d_type(1)
        v.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        v.setBigUint64(bufPtr + offset + 8, BigInt(0), true);
        v.setUint32(bufPtr + offset + 16, nameBytes.length, true);

        const childPath = file.path ? file.path + "/" + name : name;
        v.setUint8(bufPtr + offset + 20, isDir(childPath) ? 3 : 4);
        m.set(nameBytes, bufPtr + offset + 24);
        offset += entrySize;
      }

      v.setUint32(retPtr, offset, true);
      return ESUCCESS;
    },

    path_open(
      dirFd: number, _dirflags: number,
      pathPtr: number, pathLen: number,
      oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
      _fdflags: number, retPtr: number
    ): number {
      const pathStr = decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const OFLAGS_CREAT = 1;
      const OFLAGS_TRUNC = 8;

      // O_CREAT — create a new writable file (or open existing writable file)
      if (oflags & OFLAGS_CREAT) {
        const fd = nextFd++;
        let existingData = fileData(fullPath);
        if (oflags & OFLAGS_TRUNC) existingData = undefined;
        const data = existingData || new Uint8Array(0);
        openFiles.set(fd, { path: fullPath, data, offset: 0, isDir: false, writable: true });
        if (!existingData) {
          writtenFiles.set(fullPath, data);
          registerFile(fullPath);
        }
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }

      // Directory open
      if (isDir(fullPath)) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data: new Uint8Array(0), offset: 0, isDir: true, writable: false });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }

      // Regular file open
      const data = fileData(fullPath);
      if (data) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data, offset: 0, isDir: false, writable: false });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }

      return ENOENT;
    },

    path_filestat_get(
      dirFd: number, _flags: number,
      pathPtr: number, pathLen: number,
      retPtr: number
    ): number {
      const pathStr = decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const m = mem();
      m.fill(0, retPtr, retPtr + 64);
      const v = view();

      if (isDir(fullPath)) {
        v.setUint8(retPtr + 16, 3);
        return ESUCCESS;
      }

      const data = fileData(fullPath);
      if (data) {
        v.setUint8(retPtr + 16, 4);
        v.setBigUint64(retPtr + 32, BigInt(data.length), true);
        return ESUCCESS;
      }

      return ENOENT;
    },

    path_filestat_set_times(): number { return ESUCCESS; },
    path_create_directory(): number { return ENOSYS; },
    path_remove_directory(): number { return ENOSYS; },
    path_unlink_file(): number { return ENOSYS; },
    path_rename(): number { return ENOSYS; },
    path_readlink(): number { return ENOSYS; },

    poll_oneoff(): number { return ENOSYS; },
    sched_yield(): number { return ESUCCESS; },
    random_get(bufPtr: number, bufLen: number): number {
      const buf = new Uint8Array(getMemory().buffer, bufPtr, bufLen);
      crypto.getRandomValues(buf);
      return ESUCCESS;
    },

    proc_exit(code: number): void {
      throw new ProcExit(code);
    },
  };

  return {
    imports,
    getStdout(): Uint8Array {
      let total = 0;
      for (const c of stdoutChunks) total += c.length;
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of stdoutChunks) { result.set(c, offset); offset += c.length; }
      return result;
    },
    getStderr(): Uint8Array {
      let total = 0;
      for (const c of stderrChunks) total += c.length;
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of stderrChunks) { result.set(c, offset); offset += c.length; }
      return result;
    },
    getWrittenFiles(): Map<string, Uint8Array> {
      return writtenFiles;
    },
  };
}
