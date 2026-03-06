// NumPy integration tests — verifies numpy works end-to-end in workerd.
//
// Uses python-numpy.wasm (CPython 3.13 + numpy 2.4.2 C extension statically linked)
// and numpy-site-packages.zip (numpy's Python layer loaded via zipimport).

import { describe, it, expect } from "vitest";
import pythonNumpyWasm from "../worker/src/python-numpy.wasm";
import { stdlibFS } from "../worker/src/stdlib-fs";
import { ProcExit, createWasi } from "../worker/src/wasi";
// @ts-ignore
import numpyPackagesData from "../worker/src/numpy-site-packages.zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function runNumpy(code: string): Promise<{ text: string; stderr: string; status: number }> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(stdlibFS)) {
    files[path] = encoder.encode(content);
  }

  // Mount numpy Python files
  let pythonPath = "/stdlib";
  if (numpyPackagesData) {
    files["numpy-site-packages.zip"] = new Uint8Array(numpyPackagesData);
    pythonPath += ":/stdlib/numpy-site-packages.zip";
  }

  let memory: WebAssembly.Memory | undefined;
  const wasi = createWasi(
    ["python", "-S", "-c", code],
    { PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
    files,
    () => memory!
  );

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

  const asyncify: Record<string, Function> = {
    start_unwind: () => {},
    stop_unwind: () => {},
    start_rewind: () => {},
    stop_rewind: () => {},
  };

  try {
    const result = await WebAssembly.instantiate(pythonNumpyWasm, {
      wasi_snapshot_preview1: wasi.imports,
      pymode,
      asyncify,
    });
    const instance = (result as any).exports
      ? (result as WebAssembly.Instance)
      : (result as any).instance;
    memory = instance.exports.memory as WebAssembly.Memory;
    const start = instance.exports._start as () => void;
    start();
    return {
      text: decoder.decode(wasi.getStdout()).trim(),
      stderr: decoder.decode(wasi.getStderr()).trim(),
      status: 0,
    };
  } catch (e: unknown) {
    if (e instanceof ProcExit) {
      return {
        text: decoder.decode(wasi.getStdout()).trim(),
        stderr: decoder.decode(wasi.getStderr()).trim(),
        status: e.code,
      };
    }
    throw e;
  }
}

describe("numpy", () => {
  it("should verify _multiarray_umath is a builtin module", async () => {
    const { text } = await runNumpy(`
import sys
builtins = [m for m in sys.builtin_module_names if 'multiarray' in m]
print(builtins)
`);
    expect(text).toContain("numpy._core._multiarray_umath");
  });

  it("should import numpy successfully", async () => {
    const { text, stderr, status } = await runNumpy(`
import numpy as np
print(f"numpy {np.__version__}")
`);
    console.log("numpy import stdout:", text);
    console.log("numpy import stderr:", stderr);
    console.log("numpy import status:", status);
    expect(status).toBe(0);
    expect(text).toContain("numpy");
  });

  it("should create arrays and compute mean", async () => {
    const { text, status, stderr } = await runNumpy(`
import numpy as np
arr = np.array([1, 2, 3, 4, 5])
print(f"mean={arr.mean()}")
print(f"sum={arr.sum()}")
print(f"shape={arr.shape}")
`);
    if (status !== 0) {
      console.error("array test stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("mean=3.0");
    expect(text).toContain("sum=15");
    expect(text).toContain("shape=(5,)");
  });

  it("should do matrix operations", async () => {
    const { text, status, stderr } = await runNumpy(`
import numpy as np
a = np.array([[1, 2], [3, 4]])
b = np.array([[5, 6], [7, 8]])
c = a @ b
print(f"dot={c.tolist()}")
print(f"transpose={a.T.tolist()}")
print(f"trace={int(np.trace(a))}")
`);
    if (status !== 0) {
      console.error("matrix test stderr:", stderr);
    }
    expect(status).toBe(0);
    expect(text).toContain("dot=[[19, 22], [43, 50]]");
    expect(text).toContain("transpose=[[1, 3], [2, 4]]");
    expect(text).toContain("trace=5");
  });

  it("should compute standard deviation", async () => {
    const { text, status } = await runNumpy(`
import numpy as np
data = np.array([10.0, 20.0, 30.0, 40.0, 50.0])
print(f"std={data.std():.1f}")
print(f"var={data.var():.1f}")
`);
    expect(status).toBe(0);
    expect(text).toContain("std=14.1");
    expect(text).toContain("var=200.0");
  });
});
