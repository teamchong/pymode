/**
 * ThreadDO — Child Durable Object for parallel Python execution.
 *
 * Spawned by PythonDO when Python calls pymode.parallel.spawn().
 * Each ThreadDO runs a separate python.wasm instance with its own
 * 30s CPU budget and 128MB memory.
 *
 * Communication:
 *   - Receives: Python code (string) + serialized input (Uint8Array)
 *   - The code reads input from stdin, processes it, writes output to stdout
 *   - Returns: stdout bytes (serialized result)
 */

import { DurableObject } from "cloudflare:workers";

interface ThreadDOEnv {
  [key: string]: unknown;
}

export class ThreadDO extends DurableObject<ThreadDOEnv> {
  /**
   * Execute Python code with input data.
   * The code should read from stdin and write results to stdout.
   *
   * @param wasmModule - The compiled python.wasm module
   * @param createWasi - Factory for WASI imports (same as PythonDO uses)
   * @param code - Python source code to execute
   * @param input - Serialized input data (piped as stdin)
   * @returns stdout bytes (the serialized result)
   */
  async execute(
    wasmModule: WebAssembly.Module,
    createWasi: (
      getMemory: () => WebAssembly.Memory,
      stdinData?: Uint8Array
    ) => {
      imports: Record<string, Function>;
      getStdout: () => Uint8Array;
      getStderr: () => Uint8Array;
    },
    code: string,
    input: Uint8Array
  ): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    let memory: WebAssembly.Memory | undefined;

    // Create WASI with input piped as stdin
    const wasi = createWasi(() => memory!, input);

    // ThreadDO runs without pymode host imports — child threads don't get
    // their own TCP/KV/R2 access (they'd need to go through the parent).
    // For Phase 3, we provide minimal pymode imports that log to console.
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
      console_log: (msgPtr: number, msgLen: number) => {
        if (memory) {
          const bytes = new Uint8Array(memory.buffer, msgPtr, msgLen);
          console.log(new TextDecoder().decode(bytes));
        }
      },
    };

    // Also need asyncify control imports if the binary was asyncified
    const asyncifyNoop: Record<string, Function> = {
      start_unwind: () => {},
      stop_unwind: () => {},
      start_rewind: () => {},
      stop_rewind: () => {},
    };

    try {
      const instance = new WebAssembly.Instance(wasmModule, {
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
      if (e && typeof e.code === "number") {
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
