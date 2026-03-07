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
import { stdlibFS } from "./stdlib-fs";
import { ProcExit, createWasi, buildDirIndex } from "./wasi";

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// Pre-encode stdlib once at module load (shared across all ThreadDO instances).
const stdlibBin: Record<string, Uint8Array> = {};
for (const [path, content] of Object.entries(stdlibFS)) {
  stdlibBin[path] = _encoder.encode(content);
}
const stdlibDirIndex = buildDirIndex(stdlibBin);

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

    // ThreadDO runs without pymode host imports — child threads don't get
    // their own TCP/KV/R2 access (they'd need to go through the parent).
    const minimalPymode: Record<string, Function> = {
      tcp_connect: () => -1,
      tcp_send: () => -1,
      tcp_recv: () => -1,
      tcp_close: () => {},
      http_fetch: () => -1,
      http_response_status: () => -1,
      http_response_read: () => -1,
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
      dl_sym: () => -1,
      dl_close: () => {},
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

    try {
      const instance = new WebAssembly.Instance(pythonWasm, {
        wasi_snapshot_preview1: wasi.imports,
        pymode: minimalPymode,
        asyncify: asyncifyNoop,
      });
      memory = instance.exports.memory as WebAssembly.Memory;

      const start = instance.exports._start as () => void;
      start();

      return {
        stdout: wasi.getStdout(),
        stderr: wasi.getStderr(),
        exitCode: 0,
      };
    } catch (e: any) {
      if (e instanceof ProcExit) {
        return {
          stdout: wasi.getStdout(),
          stderr: wasi.getStderr(),
          exitCode: e.code,
        };
      }
      throw e;
    }
  }
}
