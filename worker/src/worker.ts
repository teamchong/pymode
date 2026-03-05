import pythonWasm from "./python.wasm";
import { stdlibFS } from "./stdlib-fs.js";

// Custom synchronous WASI shim for running Python on CF Workers.
// Unlike @cloudflare/workers-wasi, this doesn't need asyncify because
// all syscalls are backed by an in-memory filesystem with zero I/O.

class ProcExit extends Error {
  code: number;
  constructor(code: number) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

function createWasi(
  args: string[],
  env: Record<string, string>,
  files: Record<string, Uint8Array>,
  getMemory: () => WebAssembly.Memory
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const FD_STDIN = 0;
  const FD_STDOUT = 1;
  const FD_STDERR = 2;
  const FD_PREOPEN = 3;

  const preopenPath = "/stdlib";

  interface OpenFile {
    path: string;
    data: Uint8Array;
    offset: number;
    isDir: boolean;
  }

  const openFiles = new Map<number, OpenFile>();
  let nextFd = FD_PREOPEN + 1;

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

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

  function isDir(path: string): boolean {
    return dirChildren.has(path);
  }

  function view(): DataView { return new DataView(getMemory().buffer); }
  function mem(): Uint8Array { return new Uint8Array(getMemory().buffer); }

  const ESUCCESS = 0;
  const EBADF = 8;
  const EINVAL = 28;
  const EISDIR = 31;
  const ENOENT = 44;
  const ENOSYS = 52;

  function normalizePath(p: string): string {
    let r = p.replace(/^\.\//, "").replace(/\/\.\//g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
    if (r === ".") r = "";
    return r;
  }

  function resolvePath(dirFd: number, relPath: string): string | null {
    if (dirFd === FD_PREOPEN) return normalizePath(relPath);
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
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = m.slice(ptr, ptr + len);
        if (fd === FD_STDOUT) stdoutChunks.push(chunk);
        else if (fd === FD_STDERR) stderrChunks.push(chunk);
        written += len;
      }
      v.setUint32(retPtr, written, true);
      return ESUCCESS;
    },

    fd_read(fd: number, iovsPtr: number, iovsLen: number, retPtr: number): number {
      const v = view();
      const m = mem();
      if (fd === FD_STDIN) {
        v.setUint32(retPtr, 0, true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      let totalRead = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        const remaining = file.data.length - file.offset;
        const toRead = Math.min(len, remaining);
        if (toRead > 0) {
          m.set(file.data.subarray(file.offset, file.offset + toRead), ptr);
          file.offset += toRead;
          totalRead += toRead;
        }
        if (toRead < len) break;
      }
      v.setUint32(retPtr, totalRead, true);
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

    fd_close(fd: number): number {
      if (fd <= FD_PREOPEN) return ESUCCESS;
      openFiles.delete(fd);
      return ESUCCESS;
    },

    fd_prestat_get(fd: number, retPtr: number): number {
      if (fd === FD_PREOPEN) {
        const v = view();
        v.setUint8(retPtr, 0); // PREOPENTYPE_DIR
        v.setUint32(retPtr + 4, encoder.encode(preopenPath).length, true);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
      if (fd === FD_PREOPEN) {
        mem().set(encoder.encode(preopenPath).subarray(0, pathLen), pathPtr);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_fdstat_get(fd: number, retPtr: number): number {
      const v = view();
      const m = new Uint8Array(getMemory().buffer);
      // Zero out the struct (24 bytes)
      m.fill(0, retPtr, retPtr + 24);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr, 2); // CHARACTER_DEVICE
        v.setBigUint64(retPtr + 8, BigInt(0x1FF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FF), true);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN) {
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

    path_open(
      dirFd: number, _dirflags: number,
      pathPtr: number, pathLen: number,
      _oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
      _fdflags: number, retPtr: number
    ): number {
      const pathStr = decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (files[fullPath]) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data: files[fullPath], offset: 0, isDir: false });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      if (isDir(fullPath)) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data: new Uint8Array(0), offset: 0, isDir: true });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      return ENOENT;
    },

    path_filestat_get(
      dirFd: number, _flags: number,
      pathPtr: number, pathLen: number, retPtr: number
    ): number {
      const pathStr = decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const fileData = files[fullPath];
      const isDirPath = isDir(fullPath);
      if (!fileData && !isDirPath) return ENOENT;

      const v = view();
      const m = new Uint8Array(getMemory().buffer);
      m.fill(0, retPtr, retPtr + 64);
      v.setUint8(retPtr + 16, isDirPath && !fileData ? 3 : 4);
      v.setBigUint64(retPtr + 24, BigInt(1), true);
      v.setBigUint64(retPtr + 32, BigInt(fileData ? fileData.length : 0), true);
      return ESUCCESS;
    },

    fd_filestat_get(fd: number, retPtr: number): number {
      const m = new Uint8Array(getMemory().buffer);
      const v = view();
      m.fill(0, retPtr, retPtr + 64);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr + 16, 2);
        v.setBigUint64(retPtr + 24, BigInt(1), true);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN) {
        v.setUint8(retPtr + 16, 3);
        v.setBigUint64(retPtr + 24, BigInt(1), true);
        return ESUCCESS;
      }
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      v.setUint8(retPtr + 16, file.isDir ? 3 : 4);
      v.setBigUint64(retPtr + 24, BigInt(1), true);
      v.setBigUint64(retPtr + 32, BigInt(file.data.length), true);
      return ESUCCESS;
    },

    fd_readdir(
      fd: number, bufPtr: number, bufLen: number,
      cookie: bigint, retPtr: number
    ): number {
      const file = openFiles.get(fd);
      if (!file && fd !== FD_PREOPEN) return EBADF;
      const dirPath = fd === FD_PREOPEN ? "" : file!.path;
      const entries = dirChildren.get(dirPath) || [];
      const v = view();
      const m = mem();

      let offset = 0;
      const startIdx = Number(cookie);
      for (let i = startIdx; i < entries.length; i++) {
        const name = entries[i];
        const nameBytes = encoder.encode(name);
        const entrySize = 24 + nameBytes.length;
        if (offset + entrySize > bufLen) break;

        const base = bufPtr + offset;
        v.setBigUint64(base, BigInt(i + 1), true);
        v.setBigUint64(base + 8, BigInt(0), true);
        v.setUint32(base + 16, nameBytes.length, true);
        const childPath = dirPath ? `${dirPath}/${name}` : name;
        v.setUint8(base + 20, isDir(childPath) ? 3 : 4);
        m.set(nameBytes, base + 24);
        offset += entrySize;
      }

      v.setUint32(retPtr, offset, true);
      return ESUCCESS;
    },

    fd_tell(fd: number, retPtr: number): number {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      view().setBigUint64(retPtr, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_advise(): number { return ESUCCESS; },
    fd_allocate(): number { return ESUCCESS; },
    fd_datasync(): number { return ESUCCESS; },
    fd_sync(): number { return ESUCCESS; },
    fd_fdstat_set_flags(): number { return ESUCCESS; },
    fd_fdstat_set_rights(): number { return ESUCCESS; },
    fd_filestat_set_size(): number { return ESUCCESS; },
    fd_filestat_set_times(): number { return ESUCCESS; },
    fd_pread(): number { return ENOSYS; },
    fd_pwrite(): number { return ENOSYS; },
    fd_renumber(): number { return ENOSYS; },
    path_create_directory(): number { return ENOSYS; },
    path_filestat_set_times(): number { return ESUCCESS; },
    path_link(): number { return ENOSYS; },
    path_readlink(): number { return ENOSYS; },
    path_remove_directory(): number { return ENOSYS; },
    path_rename(): number { return ENOSYS; },
    path_symlink(): number { return ENOSYS; },
    path_unlink_file(): number { return ENOSYS; },
    poll_oneoff(): number { return ENOSYS; },
    proc_raise(): number { return ENOSYS; },
    sched_yield(): number { return ESUCCESS; },
    sock_recv(): number { return ENOSYS; },
    sock_send(): number { return ENOSYS; },
    sock_shutdown(): number { return ENOSYS; },
    sock_accept(): number { return ENOSYS; },

    random_get(bufPtr: number, bufLen: number): number {
      crypto.getRandomValues(new Uint8Array(getMemory().buffer, bufPtr, bufLen));
      return ESUCCESS;
    },

    proc_exit(code: number) {
      throw new ProcExit(code);
    },
  };

  return {
    imports,
    getStdout(): Uint8Array {
      let len = 0;
      for (const c of stdoutChunks) len += c.length;
      const result = new Uint8Array(len);
      let off = 0;
      for (const c of stdoutChunks) { result.set(c, off); off += c.length; }
      return result;
    },
    getStderr(): Uint8Array {
      let len = 0;
      for (const c of stderrChunks) len += c.length;
      const result = new Uint8Array(len);
      let off = 0;
      for (const c of stderrChunks) { result.set(c, off); off += c.length; }
      return result;
    },
  };
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let code: string;
    if (request.method === "POST") {
      code = await request.text();
    } else {
      code = url.searchParams.get("code") || "print('Hello from PyMode!')";
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Build file map: path -> Uint8Array
    const files: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(stdlibFS)) {
      files[path] = encoder.encode(content);
    }

    let memory: WebAssembly.Memory | undefined;
    const wasi = createWasi(
      ["python", "-S", "-c", code],
      { PYTHONPATH: "/stdlib", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      files,
      () => memory!
    );

    try {
      const instance = new WebAssembly.Instance(pythonWasm, {
        wasi_snapshot_preview1: wasi.imports,
      });
      memory = instance.exports.memory as WebAssembly.Memory;

      const start = instance.exports._start as () => void;
      start();

      const output = decoder.decode(wasi.getStdout());
      return new Response(output, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
      });
    } catch (e: unknown) {
      if (e instanceof ProcExit && e.code === 0) {
        const output = decoder.decode(wasi.getStdout());
        return new Response(output || "(empty output)\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
        });
      }
      if (e instanceof ProcExit) {
        const output = decoder.decode(wasi.getStdout());
        const errors = decoder.decode(wasi.getStderr());
        return new Response(output + errors, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8", "X-Powered-By": "PyMode" },
        });
      }
      const msg = e instanceof Error ? e.message : String(e);
      const errors = decoder.decode(wasi.getStderr());
      return new Response(`Error: ${msg}\n${errors}`, {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }
  },
};
