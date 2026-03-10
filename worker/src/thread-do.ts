/**
 * ThreadDO — Child Durable Object for parallel Python execution.
 *
 * Spawned by PythonDO when Python calls pymode.parallel.spawn().
 * Each ThreadDO runs a separate python.wasm instance with its own
 * 30s CPU budget and 128MB memory.
 *
 * Imports python.wasm and stdlib directly — WebAssembly.Module and
 * closures can't be sent via DO RPC, so each ThreadDO is self-contained.
 *
 * Communication:
 *   - Receives: Python code (string) + serialized input (Uint8Array)
 *   - The code reads input from stdin, processes it, writes output to stdout
 *   - Returns: stdout bytes (serialized result)
 */

import { DurableObject } from "cloudflare:workers";
import pythonWasm from "./python.wasm";
import { ProcExit, createWasi } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex } from "./stdlib-bin";

interface ThreadDOEnv {
  [key: string]: unknown;
}

export class ThreadDO extends DurableObject<ThreadDOEnv> {
  /**
   * Execute Python code with input data.
   * The code should read from stdin and write results to stdout.
   *
   * @param code - Python source code to execute
   * @param input - Serialized input data (piped as stdin)
   * @returns stdout/stderr bytes and exit code
   */
  async execute(
    code: string,
    input: Uint8Array
  ): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    let memory: WebAssembly.Memory | undefined;

    const args = ["python", "-S", "-c", code];
    const env = {
      PYTHONPATH: "/stdlib",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    };

    const files: Record<string, Uint8Array> = { ...stdlibBin };
    const wasi = createWasi(args, env, files, () => memory!, input, stdlibDirIndex);

    // ThreadDO doesn't have CF bindings — host imports throw immediately
    // so Python code gets a clear error instead of silent data loss.
    const unavailable = (name: string) => () => {
      throw new Error(`${name} is not available in ThreadDO`);
    };
    const minimalPymode: Record<string, Function> = {
      tcp_connect: unavailable("tcp_connect"),
      tcp_send: unavailable("tcp_send"),
      tcp_recv: unavailable("tcp_recv"),
      tcp_close: unavailable("tcp_close"),
      http_fetch_full: unavailable("http_fetch_full"),
      kv_get: unavailable("kv_get"),
      kv_put: unavailable("kv_put"),
      kv_delete: unavailable("kv_delete"),
      kv_multi_get: unavailable("kv_multi_get"),
      kv_multi_put: unavailable("kv_multi_put"),
      r2_get: unavailable("r2_get"),
      r2_put: unavailable("r2_put"),
      d1_exec: unavailable("d1_exec"),
      d1_batch: unavailable("d1_batch"),
      env_get: unavailable("env_get"),
      thread_spawn: unavailable("thread_spawn"),
      thread_join: unavailable("thread_join"),
      dl_open: unavailable("dl_open"),
      dl_sym: unavailable("dl_sym"),
      dl_close: unavailable("dl_close"),
      dl_error: () => 0,
      console_log: (msgPtr: number, msgLen: number) => {
        if (memory) {
          const bytes = new Uint8Array(memory.buffer, msgPtr, msgLen);
          console.log(_decoder.decode(bytes));
        }
      },
    };

    // Asyncify noop — ThreadDO uses sync instantiation (no async imports)
    const asyncifyNoop: Record<string, Function> = {
      start_unwind: () => {},
      stop_unwind: () => {},
      start_rewind: () => {},
      stop_rewind: () => {},
    };

    let exitCode = 0;
    try {
      const instance = new WebAssembly.Instance(pythonWasm, {
        wasi_snapshot_preview1: wasi.imports,
        pymode: minimalPymode,
        asyncify: asyncifyNoop,
      });
      memory = instance.exports.memory as WebAssembly.Memory;
      (instance.exports._start as () => void)();
    } catch (e: unknown) {
      if (e instanceof ProcExit) exitCode = e.code;
      else throw e;
    }
    return {
      stdout: wasi.getStdout(),
      stderr: wasi.getStderr(),
      exitCode,
    };
  }
}
