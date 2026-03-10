// Extracted WASI implementation — shared by worker.ts and python-do.ts.
// Provides a synchronous in-memory VFS for running CPython in WebAssembly.

export class ProcExit extends Error {
  code: number;
  constructor(code: number) {
    super(`proc_exit(${code})`);
    this.code = code;
  }
}

export interface WasiResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  files: Record<string, Uint8Array>;
  writtenFiles: Map<string, Uint8Array>;
}

// Pre-build directory index from file paths. Reusable across requests
// when the base file set doesn't change (e.g., stdlib).
export function buildDirIndex(files: Record<string, Uint8Array>): Map<string, string[]> {
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

  if (!dirChildren.has("tmp")) {
    dirChildren.set("tmp", []);
    const root = dirChildren.get("")!;
    if (!root.includes("tmp")) root.push("tmp");
  }
  if (!dirChildren.has("data")) {
    dirChildren.set("data", []);
    const root = dirChildren.get("")!;
    if (!root.includes("data")) root.push("data");
  }

  return dirChildren;
}

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

export function createWasi(
  args: string[],
  env: Record<string, string>,
  files: Record<string, Uint8Array>,
  getMemory: () => WebAssembly.Memory,
  stdinData?: Uint8Array,
  baseDirIndex?: Map<string, string[]>
) {
  const FD_STDIN = 0;
  const FD_STDOUT = 1;
  const FD_STDERR = 2;
  const FD_PREOPEN = 3;       // /stdlib (read-only stdlib + pymode runtime)
  const FD_DATA_PREOPEN = 4;  // /data (read-write, backed by CF KV)
  const FD_TMP_PREOPEN = 5;   // /tmp (writable temp directory)

  const preopenPath = "/stdlib";
  const dataPreopenPath = "/data";
  const tmpPreopenPath = "/tmp";

  // Pre-encode preopen paths (called repeatedly during WASI init)
  const preopenPaths: Record<number, { str: string; bytes: Uint8Array }> = {
    [FD_PREOPEN]: { str: preopenPath, bytes: _encoder.encode(preopenPath) },
    [FD_DATA_PREOPEN]: { str: dataPreopenPath, bytes: _encoder.encode(dataPreopenPath) },
    [FD_TMP_PREOPEN]: { str: tmpPreopenPath, bytes: _encoder.encode(tmpPreopenPath) },
  };

  interface OpenFile {
    path: string;
    data: Uint8Array;
    offset: number;
    isDir: boolean;
    writable: boolean;
  }

  const openFiles = new Map<number, OpenFile>();
  let nextFd = FD_TMP_PREOPEN + 1;

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdinOffset = 0;

  // Writable files layer — sits on top of the read-only files map
  const writtenFiles = new Map<string, Uint8Array>();
  const deletedFiles = new Set<string>();

  // Clone the pre-built directory index or build one fresh.
  // Cloning a Map is cheaper than rebuilding from 242+ file paths.
  let dirChildren: Map<string, string[]>;
  if (baseDirIndex) {
    dirChildren = new Map<string, string[]>();
    for (const [k, v] of baseDirIndex) dirChildren.set(k, v.slice());
  } else {
    dirChildren = buildDirIndex(files);
  }

  function isDir(path: string): boolean {
    return dirChildren.has(path);
  }

  function fileExists(path: string): boolean {
    return writtenFiles.has(path) || (!deletedFiles.has(path) && path in files);
  }

  function fileData(path: string): Uint8Array | undefined {
    return writtenFiles.get(path) || (deletedFiles.has(path) ? undefined : files[path]);
  }

  // Register a directory in the VFS (creates parent chain)
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

  // Register a file in its parent directory's children list
  function registerFile(path: string): void {
    const parts = path.split("/");
    const dir = parts.slice(0, -1).join("/");
    const name = parts[parts.length - 1];
    ensureDir(dir);
    const list = dirChildren.get(dir)!;
    if (!list.includes(name)) list.push(name);
  }

  // Remove a child entry from its parent directory listing
  function removeFromParent(fullPath: string): void {
    const parts = fullPath.split("/");
    const name = parts.pop()!;
    const parent = parts.join("/");
    const siblings = dirChildren.get(parent);
    if (siblings) {
      const idx = siblings.indexOf(name);
      if (idx !== -1) siblings.splice(idx, 1);
    }
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
  const ENOTEMPTY = 55;

  function normalizePath(p: string): string {
    // Resolve ".." segments to prevent path traversal, then clean up "." and slashes
    const parts = p.split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === ".." ) {
        resolved.pop(); // go up — but can't escape root (empty array stays empty)
      } else if (part !== "." && part !== "") {
        resolved.push(part);
      }
    }
    return resolved.join("/");
  }

  function resolvePath(dirFd: number, relPath: string): string | null {
    if (dirFd === FD_PREOPEN) return normalizePath(relPath);
    if (dirFd === FD_DATA_PREOPEN) return normalizePath("data/" + relPath);
    if (dirFd === FD_TMP_PREOPEN) return normalizePath("tmp/" + relPath);
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
        const bytes = _encoder.encode(arg + "\0");
        mem().set(bytes, bufPtr);
        bufPtr += bytes.length;
      }
      return ESUCCESS;
    },

    args_sizes_get(countPtr: number, sizePtr: number): number {
      const v = view();
      v.setUint32(countPtr, args.length, true);
      let size = 0;
      for (const arg of args) size += _encoder.encode(arg + "\0").length;
      v.setUint32(sizePtr, size, true);
      return ESUCCESS;
    },

    environ_get(envPtr: number, bufPtr: number): number {
      const v = view();
      for (const [key, val] of Object.entries(env)) {
        v.setUint32(envPtr, bufPtr, true);
        envPtr += 4;
        const bytes = _encoder.encode(`${key}=${val}\0`);
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
      for (const [key, val] of entries) size += _encoder.encode(`${key}=${val}\0`).length;
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
          const ptr = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          chunks.push(m.slice(ptr, ptr + len));
          written += len;
        }
        v.setUint32(retPtr, written, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file || !file.writable) return EBADF;

      // Gather all iov data
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        const chunk = m.slice(ptr, ptr + len);

        // Grow buffer if needed
        const needed = file.offset + chunk.length;
        if (needed > file.data.length) {
          const grown = new Uint8Array(needed);
          grown.set(file.data);
          file.data = grown;
          writtenFiles.set(file.path, grown);
        }
        file.data.set(chunk, file.offset);
        file.offset += chunk.length;
        written += chunk.length;
      }

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
        // Read from stdin buffer
        let totalRead = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovsPtr + i * 8, true);
          const len = v.getUint32(iovsPtr + i * 8 + 4, true);
          const remaining = stdinData.length - stdinOffset;
          const toRead = Math.min(len, remaining);
          if (toRead > 0) {
            m.set(stdinData.subarray(stdinOffset, stdinOffset + toRead), ptr);
            stdinOffset += toRead;
            totalRead += toRead;
          }
          if (toRead < len) break;
        }
        v.setUint32(retPtr, totalRead, true);
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
      let newOffset: number;
      if (whence === 0) newOffset = off;
      else if (whence === 1) newOffset = file.offset + off;
      else if (whence === 2) newOffset = file.data.length + off;
      else return EINVAL;
      if (newOffset < 0) return EINVAL;
      file.offset = newOffset;
      view().setBigUint64(retPtr, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_close(fd: number): number {
      if (fd <= FD_TMP_PREOPEN) return ESUCCESS;
      openFiles.delete(fd);
      return ESUCCESS;
    },

    fd_prestat_get(fd: number, retPtr: number): number {
      const preopen = preopenPaths[fd];
      if (preopen) {
        const v = view();
        v.setUint8(retPtr, 0); // PREOPENTYPE_DIR
        v.setUint32(retPtr + 4, preopen.bytes.length, true);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
      const preopen = preopenPaths[fd];
      if (preopen) {
        mem().set(preopen.bytes.subarray(0, pathLen), pathPtr);
        return ESUCCESS;
      }
      return EBADF;
    },

    fd_fdstat_get(fd: number, retPtr: number): number {
      const v = view();
      const m = mem();
      // Zero out the struct (24 bytes)
      m.fill(0, retPtr, retPtr + 24);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr, 2); // CHARACTER_DEVICE
        v.setBigUint64(retPtr + 8, BigInt(0x1FF), true);
        v.setBigUint64(retPtr + 16, BigInt(0x1FF), true);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN || fd === FD_DATA_PREOPEN || fd === FD_TMP_PREOPEN) {
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
      oflags: number, _fsRightsBase: bigint, _fsRightsInheriting: bigint,
      _fdflags: number, retPtr: number
    ): number {
      const pathStr = _decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const OFLAGS_CREAT = 1;
      const OFLAGS_EXCL = 4;
      const OFLAGS_TRUNC = 8;

      // O_CREAT — create a new writable file (or open existing writable file)
      if (oflags & OFLAGS_CREAT) {
        // O_EXCL: fail if file already exists (needed by tempfile.mkstemp)
        if ((oflags & OFLAGS_EXCL) && fileExists(fullPath)) return EEXIST;
        const fd = nextFd++;
        if (!writtenFiles.has(fullPath) || (oflags & OFLAGS_TRUNC)) {
          writtenFiles.set(fullPath, new Uint8Array(0));
        }
        registerFile(fullPath);
        openFiles.set(fd, {
          path: fullPath,
          data: writtenFiles.get(fullPath)!,
          offset: 0,
          isDir: false,
          writable: true,
        });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }

      // Check writable files first, then read-only files
      const data = fileData(fullPath);
      if (data) {
        const fd = nextFd++;
        const writable = writtenFiles.has(fullPath);
        openFiles.set(fd, { path: fullPath, data, offset: 0, isDir: false, writable });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      if (isDir(fullPath)) {
        const fd = nextFd++;
        openFiles.set(fd, { path: fullPath, data: new Uint8Array(0), offset: 0, isDir: true, writable: false });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
      }
      return ENOENT;
    },

    path_filestat_get(
      dirFd: number, _flags: number,
      pathPtr: number, pathLen: number, retPtr: number
    ): number {
      const pathStr = _decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;

      const data = fileData(fullPath);
      const isDirPath = isDir(fullPath);
      if (!data && !isDirPath) return ENOENT;

      const v = view();
      const m = mem();
      m.fill(0, retPtr, retPtr + 64);
      v.setUint8(retPtr + 16, isDirPath && !data ? 3 : 4);
      v.setBigUint64(retPtr + 24, BigInt(1), true);
      v.setBigUint64(retPtr + 32, BigInt(data ? data.length : 0), true);
      return ESUCCESS;
    },

    fd_filestat_get(fd: number, retPtr: number): number {
      const m = mem();
      const v = view();
      m.fill(0, retPtr, retPtr + 64);
      if (fd <= FD_STDERR) {
        v.setUint8(retPtr + 16, 2);
        v.setBigUint64(retPtr + 24, BigInt(1), true);
        return ESUCCESS;
      }
      if (fd === FD_PREOPEN || fd === FD_DATA_PREOPEN || fd === FD_TMP_PREOPEN) {
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
      if (!file && fd !== FD_PREOPEN && fd !== FD_DATA_PREOPEN && fd !== FD_TMP_PREOPEN) return EBADF;
      let dirPath: string;
      if (fd === FD_PREOPEN) dirPath = "";
      else if (fd === FD_DATA_PREOPEN) dirPath = "data";
      else if (fd === FD_TMP_PREOPEN) dirPath = "tmp";
      else dirPath = file!.path;
      const entries = dirChildren.get(dirPath) || [];
      const v = view();
      const m = mem();

      let offset = 0;
      const startIdx = Number(cookie);
      for (let i = startIdx; i < entries.length; i++) {
        const name = entries[i];
        const nameBytes = _encoder.encode(name);
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

    path_create_directory(dirFd: number, pathPtr: number, pathLen: number): number {
      const pathStr = _decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (dirChildren.has(fullPath)) return EEXIST;
      ensureDir(fullPath);
      return ESUCCESS;
    },

    path_filestat_set_times(): number { return ESUCCESS; },
    path_link(): number { return ENOSYS; },
    path_readlink(): number { return ENOSYS; },

    path_remove_directory(dirFd: number, pathPtr: number, pathLen: number): number {
      const pathStr = _decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (!dirChildren.has(fullPath)) return ENOENT;
      const children = dirChildren.get(fullPath)!;
      if (children.length > 0) return ENOTEMPTY;
      dirChildren.delete(fullPath);
      removeFromParent(fullPath);
      return ESUCCESS;
    },

    path_rename(
      oldDirFd: number, oldPathPtr: number, oldPathLen: number,
      newDirFd: number, newPathPtr: number, newPathLen: number
    ): number {
      const m = mem();
      const oldPathStr = _decoder.decode(m.subarray(oldPathPtr, oldPathPtr + oldPathLen));
      const newPathStr = _decoder.decode(m.subarray(newPathPtr, newPathPtr + newPathLen));
      const oldPath = resolvePath(oldDirFd, oldPathStr);
      const newPath = resolvePath(newDirFd, newPathStr);
      if (oldPath === null || newPath === null) return EBADF;

      const data = fileData(oldPath);
      if (!data) return ENOENT;

      // Copy data to new path, remove old
      writtenFiles.set(newPath, data);
      registerFile(newPath);
      writtenFiles.delete(oldPath);
      deletedFiles.add(oldPath);
      removeFromParent(oldPath);
      return ESUCCESS;
    },

    path_symlink(): number { return ENOSYS; },

    path_unlink_file(dirFd: number, pathPtr: number, pathLen: number): number {
      const pathStr = _decoder.decode(mem().subarray(pathPtr, pathPtr + pathLen));
      const fullPath = resolvePath(dirFd, pathStr);
      if (fullPath === null) return EBADF;
      if (!fileExists(fullPath)) return ENOENT;
      writtenFiles.delete(fullPath);
      deletedFiles.add(fullPath);
      removeFromParent(fullPath);
      return ESUCCESS;
    },

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

  function concatChunks(chunks: Uint8Array[]): Uint8Array {
    let len = 0;
    for (const c of chunks) len += c.length;
    const result = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) { result.set(c, off); off += c.length; }
    return result;
  }

  return {
    imports,
    getStdout(): Uint8Array { return concatChunks(stdoutChunks); },
    getStderr(): Uint8Array { return concatChunks(stderrChunks); },
    getWrittenFiles(): Map<string, Uint8Array> {
      return writtenFiles;
    },
  };
}
