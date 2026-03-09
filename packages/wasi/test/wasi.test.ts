import { describe, it, expect } from "vitest";
import {
  createWasi,
  ProcExit,
  buildDirIndex,
  WASI_ESUCCESS,
  WASI_EBADF,
  WASI_EEXIST,
  WASI_ENOENT,
  WASI_ENOTEMPTY,
  WASI_ENOSYS,
} from "../src/index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// FD constants matching WASI implementation
const FD_STDIN = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;
const FD_PREOPEN = 3;
const FD_DATA_PREOPEN = 4;
const FD_TMP_PREOPEN = 5;

/** Create a test environment with WASM memory and helpers. */
function setup(opts: {
  args?: string[];
  env?: Record<string, string>;
  files?: Record<string, Uint8Array>;
  stdin?: Uint8Array;
  baseDirIndex?: Map<string, string[]>;
} = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 }); // 64KB
  const getMemory = () => memory;
  const files = opts.files ?? {};
  const wasi = createWasi(
    opts.args ?? [],
    opts.env ?? {},
    files,
    getMemory,
    opts.stdin,
    opts.baseDirIndex
  );
  return {
    wasi,
    imports: wasi.imports,
    memory,
    view: () => new DataView(memory.buffer),
    mem: () => new Uint8Array(memory.buffer),
    files,
  };
}

/** Write a string into WASM memory at the given offset. Returns byte length. */
function writeStr(mem: Uint8Array, offset: number, str: string): number {
  const bytes = encoder.encode(str);
  mem.set(bytes, offset);
  return bytes.length;
}

/** Set up a single iov (ptr, len) at the given memory offset. */
function writeIov(view: DataView, iovOffset: number, ptr: number, len: number): void {
  view.setUint32(iovOffset, ptr, true);
  view.setUint32(iovOffset + 4, len, true);
}

// ─── ProcExit ────────────────────────────────────────────────────

describe("ProcExit", () => {
  it("stores exit code 0", () => {
    const err = new ProcExit(0);
    expect(err.code).toBe(0);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("proc_exit(0)");
  });

  it("stores non-zero exit code", () => {
    const err = new ProcExit(1);
    expect(err.code).toBe(1);
  });

  it("is catchable as Error", () => {
    try {
      throw new ProcExit(42);
    } catch (e) {
      expect(e).toBeInstanceOf(ProcExit);
      expect((e as ProcExit).code).toBe(42);
    }
  });
});

// ─── buildDirIndex ───────────────────────────────────────────────

describe("buildDirIndex", () => {
  it("indexes flat files", () => {
    const files = {
      "os.py": new Uint8Array(1),
      "sys.py": new Uint8Array(1),
    };
    const index = buildDirIndex(files);
    expect(index.get("")).toContain("os.py");
    expect(index.get("")).toContain("sys.py");
  });

  it("indexes nested files", () => {
    const files = {
      "stdlib/os.py": new Uint8Array(1),
      "stdlib/json/__init__.py": new Uint8Array(1),
    };
    const index = buildDirIndex(files);
    expect(index.get("")).toContain("stdlib");
    expect(index.get("stdlib")).toContain("os.py");
    expect(index.get("stdlib")).toContain("json");
    expect(index.get("stdlib/json")).toContain("__init__.py");
  });

  it("always creates tmp and data dirs", () => {
    const index = buildDirIndex({});
    expect(index.has("tmp")).toBe(true);
    expect(index.has("data")).toBe(true);
    expect(index.get("")).toContain("tmp");
    expect(index.get("")).toContain("data");
  });

  it("does not duplicate entries", () => {
    const files = {
      "stdlib/a.py": new Uint8Array(1),
      "stdlib/b.py": new Uint8Array(1),
    };
    const index = buildDirIndex(files);
    const root = index.get("")!;
    expect(root.filter((x) => x === "stdlib").length).toBe(1);
  });

  it("handles deeply nested paths", () => {
    const files = {
      "a/b/c/d/e.py": new Uint8Array(1),
    };
    const index = buildDirIndex(files);
    expect(index.has("a")).toBe(true);
    expect(index.has("a/b")).toBe(true);
    expect(index.has("a/b/c")).toBe(true);
    expect(index.has("a/b/c/d")).toBe(true);
    expect(index.get("a/b/c/d")).toContain("e.py");
  });
});

// ─── proc_exit ───────────────────────────────────────────────────

describe("proc_exit", () => {
  it("throws ProcExit with code", () => {
    const { imports } = setup();
    expect(() => imports.proc_exit(0)).toThrow(ProcExit);
  });

  it("preserves exit code", () => {
    const { imports } = setup();
    try {
      imports.proc_exit(42);
    } catch (e) {
      expect((e as ProcExit).code).toBe(42);
    }
  });
});

// ─── args ────────────────────────────────────────────────────────

describe("args_sizes_get / args_get", () => {
  it("returns zero for no args", () => {
    const { imports, view } = setup({ args: [] });
    const result = imports.args_sizes_get(0, 4);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint32(0, true)).toBe(0); // count
    expect(view().getUint32(4, true)).toBe(0); // size
  });

  it("returns correct count and size", () => {
    const { imports, view } = setup({ args: ["python", "-c", "print('hi')"] });
    const result = imports.args_sizes_get(0, 4);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint32(0, true)).toBe(3);
    // Each arg is null-terminated: "python\0" + "-c\0" + "print('hi')\0"
    const expectedSize = 7 + 3 + 12;
    expect(view().getUint32(4, true)).toBe(expectedSize);
  });

  it("writes args to memory", () => {
    const { imports, view, mem } = setup({ args: ["a", "bb"] });
    // argvPtr at 1000, bufPtr at 2000
    const result = imports.args_get(1000, 2000);
    expect(result).toBe(WASI_ESUCCESS);
    // First argv pointer should point to 2000
    expect(view().getUint32(1000, true)).toBe(2000);
    // Read the first arg
    expect(decoder.decode(mem().subarray(2000, 2001))).toBe("a");
  });
});

// ─── environ ─────────────────────────────────────────────────────

describe("environ_sizes_get / environ_get", () => {
  it("returns zero for empty env", () => {
    const { imports, view } = setup({ env: {} });
    const result = imports.environ_sizes_get(0, 4);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint32(0, true)).toBe(0);
  });

  it("returns correct count", () => {
    const { imports, view } = setup({ env: { A: "1", B: "2" } });
    imports.environ_sizes_get(0, 4);
    expect(view().getUint32(0, true)).toBe(2);
  });

  it("writes env vars to memory", () => {
    const { imports, view, mem } = setup({ env: { KEY: "val" } });
    // envPtr at 1000, bufPtr at 2000
    imports.environ_get(1000, 2000);
    expect(view().getUint32(1000, true)).toBe(2000);
    // "KEY=val\0" at offset 2000
    expect(decoder.decode(mem().subarray(2000, 2007))).toBe("KEY=val");
  });
});

// ─── fd_write (stdout/stderr) ────────────────────────────────────

describe("fd_write", () => {
  it("writes to stdout", () => {
    const { imports, wasi, view, mem } = setup();
    // Put "hello" at offset 100
    const len = writeStr(mem(), 100, "hello");
    // iov at offset 0
    writeIov(view(), 0, 100, len);
    // retPtr at 200
    const result = imports.fd_write(FD_STDOUT, 0, 1, 200);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint32(200, true)).toBe(5);
    expect(decoder.decode(wasi.getStdout())).toBe("hello");
  });

  it("writes to stderr", () => {
    const { imports, wasi, view, mem } = setup();
    const len = writeStr(mem(), 100, "error!");
    writeIov(view(), 0, 100, len);
    imports.fd_write(FD_STDERR, 0, 1, 200);
    expect(decoder.decode(wasi.getStderr())).toBe("error!");
  });

  it("handles multiple iovs", () => {
    const { imports, wasi, view, mem } = setup();
    writeStr(mem(), 100, "he");
    writeStr(mem(), 200, "llo");
    writeIov(view(), 0, 100, 2);
    writeIov(view(), 8, 200, 3);
    imports.fd_write(FD_STDOUT, 0, 2, 300);
    expect(decoder.decode(wasi.getStdout())).toBe("hello");
    expect(view().getUint32(300, true)).toBe(5);
  });

  it("returns EBADF for invalid fd", () => {
    const { imports, view, mem } = setup();
    writeStr(mem(), 100, "x");
    writeIov(view(), 0, 100, 1);
    expect(imports.fd_write(99, 0, 1, 200)).toBe(WASI_EBADF);
  });
});

// ─── fd_read (stdin) ─────────────────────────────────────────────

describe("fd_read", () => {
  it("reads from stdin", () => {
    const stdinData = encoder.encode("input data");
    const { imports, view, mem } = setup({ stdin: stdinData });
    // iov: read into offset 500, up to 20 bytes
    writeIov(view(), 0, 500, 20);
    const result = imports.fd_read(FD_STDIN, 0, 1, 200);
    expect(result).toBe(WASI_ESUCCESS);
    const bytesRead = view().getUint32(200, true);
    expect(bytesRead).toBe(10);
    expect(decoder.decode(mem().subarray(500, 500 + bytesRead))).toBe("input data");
  });

  it("returns 0 bytes when stdin is empty", () => {
    const { imports, view } = setup();
    writeIov(view(), 0, 500, 20);
    imports.fd_read(FD_STDIN, 0, 1, 200);
    expect(view().getUint32(200, true)).toBe(0);
  });

  it("reads stdin in chunks", () => {
    const stdinData = encoder.encode("abcdefghij");
    const { imports, view, mem } = setup({ stdin: stdinData });
    // First read: 4 bytes
    writeIov(view(), 0, 500, 4);
    imports.fd_read(FD_STDIN, 0, 1, 200);
    expect(view().getUint32(200, true)).toBe(4);
    expect(decoder.decode(mem().subarray(500, 504))).toBe("abcd");
    // Second read: 4 bytes
    imports.fd_read(FD_STDIN, 0, 1, 200);
    expect(view().getUint32(200, true)).toBe(4);
    expect(decoder.decode(mem().subarray(500, 504))).toBe("efgh");
    // Third read: remaining 2 bytes
    imports.fd_read(FD_STDIN, 0, 1, 200);
    expect(view().getUint32(200, true)).toBe(2);
  });

  it("returns EBADF for invalid fd", () => {
    const { imports, view } = setup();
    writeIov(view(), 0, 500, 20);
    expect(imports.fd_read(99, 0, 1, 200)).toBe(WASI_EBADF);
  });
});

// ─── fd_prestat ──────────────────────────────────────────────────

describe("fd_prestat_get / fd_prestat_dir_name", () => {
  it("returns prestat for stdlib fd", () => {
    const { imports, view } = setup();
    const result = imports.fd_prestat_get(FD_PREOPEN, 0);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint8(0)).toBe(0); // PREOPENTYPE_DIR
    expect(view().getUint32(4, true)).toBe(7); // "/stdlib".length
  });

  it("returns prestat for data fd", () => {
    const { imports, view } = setup();
    imports.fd_prestat_get(FD_DATA_PREOPEN, 0);
    expect(view().getUint32(4, true)).toBe(5); // "/data".length
  });

  it("returns prestat for tmp fd", () => {
    const { imports, view } = setup();
    imports.fd_prestat_get(FD_TMP_PREOPEN, 0);
    expect(view().getUint32(4, true)).toBe(4); // "/tmp".length
  });

  it("returns EBADF for non-preopen fd", () => {
    const { imports } = setup();
    expect(imports.fd_prestat_get(6, 0)).toBe(WASI_EBADF);
  });

  it("writes preopen dir name", () => {
    const { imports, mem } = setup();
    const result = imports.fd_prestat_dir_name(FD_PREOPEN, 100, 7);
    expect(result).toBe(WASI_ESUCCESS);
    expect(decoder.decode(mem().subarray(100, 107))).toBe("/stdlib");
  });
});

// ─── fd_fdstat_get ───────────────────────────────────────────────

describe("fd_fdstat_get", () => {
  it("returns CHARACTER_DEVICE for stdin", () => {
    const { imports, view } = setup();
    imports.fd_fdstat_get(FD_STDIN, 0);
    expect(view().getUint8(0)).toBe(2); // CHARACTER_DEVICE
  });

  it("returns DIRECTORY for preopen", () => {
    const { imports, view } = setup();
    imports.fd_fdstat_get(FD_PREOPEN, 0);
    expect(view().getUint8(0)).toBe(3); // DIRECTORY
  });

  it("returns EBADF for unknown fd", () => {
    const { imports } = setup();
    expect(imports.fd_fdstat_get(99, 0)).toBe(WASI_EBADF);
  });
});

// ─── path_open / fd_close ────────────────────────────────────────

describe("path_open", () => {
  it("opens an existing file", () => {
    const files = { "test.py": encoder.encode("print('hi')") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.py");
    // path_open(dirFd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInheriting, fdflags, retPtr)
    const result = imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    expect(result).toBe(WASI_ESUCCESS);
    const fd = view().getUint32(200, true);
    expect(fd).toBeGreaterThan(FD_TMP_PREOPEN);
  });

  it("returns ENOENT for missing file", () => {
    const { imports, mem } = setup();
    const pathLen = writeStr(mem(), 100, "missing.py");
    const result = imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    expect(result).toBe(WASI_ENOENT);
  });

  it("creates a file with O_CREAT", () => {
    const { imports, view, mem } = setup();
    const pathLen = writeStr(mem(), 100, "new.txt");
    const result = imports.path_open(FD_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200); // oflags=1 = O_CREAT
    expect(result).toBe(WASI_ESUCCESS);
    const fd = view().getUint32(200, true);
    expect(fd).toBeGreaterThan(FD_TMP_PREOPEN);
  });

  it("O_CREAT + O_EXCL fails if file exists", () => {
    const files = { "exists.txt": encoder.encode("data") };
    const { imports, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "exists.txt");
    const result = imports.path_open(FD_PREOPEN, 0, 100, pathLen, 5, 0n, 0n, 0, 200); // 5 = CREAT|EXCL
    expect(result).toBe(WASI_EEXIST);
  });

  it("opens directory", () => {
    const files = { "mydir/file.py": encoder.encode("x") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "mydir");
    const result = imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    expect(result).toBe(WASI_ESUCCESS);
  });

  it("resolves paths under /data preopen", () => {
    const files = { "data/key.txt": encoder.encode("value") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "key.txt");
    const result = imports.path_open(FD_DATA_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    expect(result).toBe(WASI_ESUCCESS);
  });

  it("resolves paths under /tmp preopen", () => {
    const { imports, view, mem } = setup();
    const pathLen = writeStr(mem(), 100, "scratch.txt");
    const result = imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200); // O_CREAT
    expect(result).toBe(WASI_ESUCCESS);
  });
});

describe("fd_close", () => {
  it("closes an open fd", () => {
    const files = { "test.py": encoder.encode("x") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.py");
    imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);
    expect(imports.fd_close(fd)).toBe(WASI_ESUCCESS);
  });

  it("silently succeeds for preopen fds", () => {
    const { imports } = setup();
    expect(imports.fd_close(FD_PREOPEN)).toBe(WASI_ESUCCESS);
    expect(imports.fd_close(FD_STDIN)).toBe(WASI_ESUCCESS);
  });
});

// ─── fd_seek / fd_tell ───────────────────────────────────────────

describe("fd_seek / fd_tell", () => {
  it("seeks from start (SEEK_SET)", () => {
    const files = { "test.txt": encoder.encode("hello world") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.txt");
    imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);

    const result = imports.fd_seek(fd, 5n, 0, 300); // whence=0 = SEEK_SET
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getBigUint64(300, true)).toBe(5n);
  });

  it("seeks relative (SEEK_CUR)", () => {
    const files = { "test.txt": encoder.encode("hello world") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.txt");
    imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);

    imports.fd_seek(fd, 3n, 0, 300); // SEEK_SET to 3
    imports.fd_seek(fd, 2n, 1, 300); // SEEK_CUR +2
    expect(view().getBigUint64(300, true)).toBe(5n);
  });

  it("seeks from end (SEEK_END)", () => {
    const files = { "test.txt": encoder.encode("hello") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.txt");
    imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);

    imports.fd_seek(fd, -2n, 2, 300); // SEEK_END -2
    expect(view().getBigUint64(300, true)).toBe(3n);
  });

  it("fd_tell reports current position", () => {
    const files = { "test.txt": encoder.encode("abcdef") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.txt");
    imports.path_open(FD_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);

    imports.fd_seek(fd, 4n, 0, 300);
    imports.fd_tell(fd, 400);
    expect(view().getBigUint64(400, true)).toBe(4n);
  });
});

// ─── File read/write round-trip ──────────────────────────────────

describe("file read/write round-trip", () => {
  it("creates, writes, reads back a file", () => {
    const { imports, view, mem, wasi } = setup();

    // Create file under /tmp
    let pathLen = writeStr(mem(), 100, "output.txt");
    imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200); // O_CREAT
    const writeFd = view().getUint32(200, true);

    // Write "test data" to the file
    const dataLen = writeStr(mem(), 300, "test data");
    writeIov(view(), 0, 300, dataLen);
    imports.fd_write(writeFd, 0, 1, 400);
    expect(view().getUint32(400, true)).toBe(9);
    imports.fd_close(writeFd);

    // Re-open and read back
    pathLen = writeStr(mem(), 100, "output.txt");
    imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 0, 0n, 0n, 0, 200);
    const readFd = view().getUint32(200, true);

    writeIov(view(), 0, 500, 20);
    imports.fd_read(readFd, 0, 1, 400);
    const bytesRead = view().getUint32(400, true);
    expect(bytesRead).toBe(9);
    expect(decoder.decode(mem().subarray(500, 500 + bytesRead))).toBe("test data");
  });

  it("written files are tracked", () => {
    const { imports, view, mem, wasi } = setup();

    const pathLen = writeStr(mem(), 100, "tracked.txt");
    imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);

    const dataLen = writeStr(mem(), 300, "hello");
    writeIov(view(), 0, 300, dataLen);
    imports.fd_write(fd, 0, 1, 400);

    const written = wasi.getWrittenFiles();
    expect(written.has("tmp/tracked.txt")).toBe(true);
    expect(decoder.decode(written.get("tmp/tracked.txt")!)).toBe("hello");
  });
});

// ─── path_filestat_get ───────────────────────────────────────────

describe("path_filestat_get", () => {
  it("stats an existing file", () => {
    const content = encoder.encode("file content");
    const files = { "test.txt": content };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "test.txt");
    const result = imports.path_filestat_get(FD_PREOPEN, 0, 100, pathLen, 200);
    expect(result).toBe(WASI_ESUCCESS);
    // filetype at offset +16: 4 = REGULAR_FILE
    expect(view().getUint8(200 + 16)).toBe(4);
    // size at offset +32
    expect(Number(view().getBigUint64(200 + 32, true))).toBe(content.length);
  });

  it("stats a directory", () => {
    const files = { "mydir/file.py": encoder.encode("x") };
    const { imports, view, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "mydir");
    const result = imports.path_filestat_get(FD_PREOPEN, 0, 100, pathLen, 200);
    expect(result).toBe(WASI_ESUCCESS);
    expect(view().getUint8(200 + 16)).toBe(3); // DIRECTORY
  });

  it("returns ENOENT for missing path", () => {
    const { imports, mem } = setup();
    const pathLen = writeStr(mem(), 100, "missing.txt");
    expect(imports.path_filestat_get(FD_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ENOENT);
  });
});

// ─── path_create_directory ───────────────────────────────────────

describe("path_create_directory", () => {
  it("creates a directory", () => {
    const { imports, mem } = setup();
    const pathLen = writeStr(mem(), 100, "newdir");
    const result = imports.path_create_directory(FD_TMP_PREOPEN, 100, pathLen);
    expect(result).toBe(WASI_ESUCCESS);

    // Verify it exists via path_filestat_get
    const pathLen2 = writeStr(mem(), 100, "newdir");
    expect(imports.path_filestat_get(FD_TMP_PREOPEN, 0, 100, pathLen2, 200)).toBe(WASI_ESUCCESS);
  });

  it("returns EEXIST for existing directory", () => {
    const files = { "mydir/file.py": encoder.encode("x") };
    const { imports, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "mydir");
    expect(imports.path_create_directory(FD_PREOPEN, 100, pathLen)).toBe(WASI_EEXIST);
  });
});

// ─── path_remove_directory ───────────────────────────────────────

describe("path_remove_directory", () => {
  it("removes an empty directory", () => {
    const { imports, mem } = setup();
    // Create dir
    let pathLen = writeStr(mem(), 100, "rmdir");
    imports.path_create_directory(FD_TMP_PREOPEN, 100, pathLen);
    // Remove it
    pathLen = writeStr(mem(), 100, "rmdir");
    expect(imports.path_remove_directory(FD_TMP_PREOPEN, 100, pathLen)).toBe(WASI_ESUCCESS);
    // Verify it's gone
    pathLen = writeStr(mem(), 100, "rmdir");
    expect(imports.path_filestat_get(FD_TMP_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ENOENT);
  });

  it("returns ENOTEMPTY for non-empty directory", () => {
    const files = { "mydir/file.py": encoder.encode("x") };
    const { imports, mem } = setup({ files });
    const pathLen = writeStr(mem(), 100, "mydir");
    expect(imports.path_remove_directory(FD_PREOPEN, 100, pathLen)).toBe(WASI_ENOTEMPTY);
  });

  it("returns ENOENT for missing directory", () => {
    const { imports, mem } = setup();
    const pathLen = writeStr(mem(), 100, "nope");
    expect(imports.path_remove_directory(FD_TMP_PREOPEN, 100, pathLen)).toBe(WASI_ENOENT);
  });
});

// ─── path_unlink_file ────────────────────────────────────────────

describe("path_unlink_file", () => {
  it("unlinks a written file", () => {
    const { imports, view, mem } = setup();
    // Create a file
    let pathLen = writeStr(mem(), 100, "delme.txt");
    imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200);
    imports.fd_close(view().getUint32(200, true));
    // Unlink it
    pathLen = writeStr(mem(), 100, "delme.txt");
    expect(imports.path_unlink_file(FD_TMP_PREOPEN, 100, pathLen)).toBe(WASI_ESUCCESS);
    // Verify it's gone
    pathLen = writeStr(mem(), 100, "delme.txt");
    expect(imports.path_filestat_get(FD_TMP_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ENOENT);
  });

  it("returns ENOENT for missing file", () => {
    const { imports, mem } = setup();
    const pathLen = writeStr(mem(), 100, "nope.txt");
    expect(imports.path_unlink_file(FD_TMP_PREOPEN, 100, pathLen)).toBe(WASI_ENOENT);
  });
});

// ─── path_rename ─────────────────────────────────────────────────

describe("path_rename", () => {
  it("renames a file", () => {
    const { imports, view, mem } = setup();
    // Create a file
    let pathLen = writeStr(mem(), 100, "old.txt");
    imports.path_open(FD_TMP_PREOPEN, 0, 100, pathLen, 1, 0n, 0n, 0, 200);
    const fd = view().getUint32(200, true);
    const dataLen = writeStr(mem(), 300, "content");
    writeIov(view(), 0, 300, dataLen);
    imports.fd_write(fd, 0, 1, 400);
    imports.fd_close(fd);

    // Rename
    const oldLen = writeStr(mem(), 1000, "old.txt");
    const newLen = writeStr(mem(), 1100, "new.txt");
    const result = imports.path_rename(FD_TMP_PREOPEN, 1000, oldLen, FD_TMP_PREOPEN, 1100, newLen);
    expect(result).toBe(WASI_ESUCCESS);

    // Old is gone
    pathLen = writeStr(mem(), 100, "old.txt");
    expect(imports.path_filestat_get(FD_TMP_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ENOENT);

    // New exists
    pathLen = writeStr(mem(), 100, "new.txt");
    expect(imports.path_filestat_get(FD_TMP_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ESUCCESS);
  });
});

// ─── clock ───────────────────────────────────────────────────────

describe("clock_time_get / clock_res_get", () => {
  it("returns a reasonable timestamp", () => {
    const { imports, view } = setup();
    imports.clock_time_get(0, 0n, 0);
    const ns = Number(view().getBigUint64(0, true));
    // Should be after year 2020 in nanoseconds
    expect(ns).toBeGreaterThan(1577836800000 * 1_000_000);
  });

  it("returns 1ms resolution", () => {
    const { imports, view } = setup();
    imports.clock_res_get(0, 0);
    expect(Number(view().getBigUint64(0, true))).toBe(1_000_000);
  });
});

// ─── random_get ──────────────────────────────────────────────────

describe("random_get", () => {
  it("fills buffer with random bytes", () => {
    const { imports, mem } = setup();
    // Zero out area first
    mem().fill(0, 100, 116);
    const result = imports.random_get(100, 16);
    expect(result).toBe(WASI_ESUCCESS);
    // Extremely unlikely that 16 random bytes are all zero
    const randomBytes = mem().subarray(100, 116);
    const allZero = randomBytes.every((b) => b === 0);
    expect(allZero).toBe(false);
  });
});

// ─── noop/unsupported syscalls ───────────────────────────────────

describe("noop/unsupported syscalls", () => {
  it("noop syscalls return ESUCCESS", () => {
    const { imports } = setup();
    expect(imports.fd_advise()).toBe(WASI_ESUCCESS);
    expect(imports.fd_datasync()).toBe(WASI_ESUCCESS);
    expect(imports.fd_sync()).toBe(WASI_ESUCCESS);
    expect(imports.sched_yield()).toBe(WASI_ESUCCESS);
  });

  it("unsupported syscalls return ENOSYS", () => {
    const { imports } = setup();
    expect(imports.fd_pread()).toBe(WASI_ENOSYS);
    expect(imports.fd_pwrite()).toBe(WASI_ENOSYS);
    expect(imports.poll_oneoff()).toBe(WASI_ENOSYS);
    expect(imports.sock_recv()).toBe(WASI_ENOSYS);
    expect(imports.sock_send()).toBe(WASI_ENOSYS);
  });
});

// ─── baseDirIndex reuse ──────────────────────────────────────────

describe("baseDirIndex", () => {
  it("uses pre-built index when provided", () => {
    const files = { "stdlib/os.py": encoder.encode("x") };
    const baseIndex = buildDirIndex(files);

    const { imports, mem } = setup({ files, baseDirIndex: baseIndex });
    const pathLen = writeStr(mem(), 100, "stdlib/os.py");
    expect(imports.path_filestat_get(FD_PREOPEN, 0, 100, pathLen, 200)).toBe(WASI_ESUCCESS);
  });

  it("does not mutate the base index", () => {
    const files = { "stdlib/os.py": encoder.encode("x") };
    const baseIndex = buildDirIndex(files);
    const origSize = baseIndex.size;

    const { imports, mem } = setup({ files, baseDirIndex: baseIndex });
    // Create a new directory — should only affect the clone
    const pathLen = writeStr(mem(), 100, "newdir");
    imports.path_create_directory(FD_TMP_PREOPEN, 100, pathLen);

    expect(baseIndex.size).toBe(origSize);
  });
});
