/**
 * ThreadDO — Child Durable Object for parallel Python execution.
 *
 * Spawned by PythonDO when Python calls pymode.parallel.spawn().
 * Each ThreadDO runs a separate python.wasm instance with its own
 * 30s CPU budget and 128MB memory.
 *
 * Has full access to CF bindings (KV, R2, D1, HTTP, TCP) via host imports
 * and fan-out replay — child threads can do I/O, not just pure compute.
 *
 * Does NOT support thread_spawn (no recursive fan-out) to prevent
 * unbounded DO chains.
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
import { buildHostImports } from "./host-imports";
import type { MemoryAccessor } from "./host-imports";
import { FanoutContext, resolveAll } from "./fanout";

interface ThreadDOEnv {
  [key: string]: unknown;
}

export class ThreadDO extends DurableObject<ThreadDOEnv> {
  private wasmMemory: WebAssembly.Memory | null = null;
  private _memView: Uint8Array | null = null;
  private _memBuffer: ArrayBuffer | null = null;

  private getMemBytes(): Uint8Array {
    const buf = this.wasmMemory!.buffer;
    if (buf !== this._memBuffer) {
      this._memBuffer = buf;
      this._memView = new Uint8Array(buf);
    }
    return this._memView!;
  }

  private readString(ptr: number, len: number): string {
    return _decoder.decode(this.getMemBytes().subarray(ptr, ptr + len));
  }

  private writeBytes(ptr: number, data: Uint8Array, maxLen: number): number {
    const n = Math.min(data.length, maxLen);
    this.getMemBytes().set(data.subarray(0, n), ptr);
    return n;
  }

  /**
   * Execute Python code with input data.
   * The code should read from stdin and write results to stdout.
   *
   * Uses fan-out replay: WASM runs synchronously, async imports record
   * calls and return sentinels, JS resolves all pending calls in parallel,
   * then replays with cached results.
   *
   * @param code - Python source code to execute
   * @param input - Serialized input data (piped as stdin)
   * @returns stdout/stderr bytes and exit code
   */
  async execute(
    code: string,
    input: Uint8Array
  ): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    const fanout = new FanoutContext();
    const MAX_REPLAY_PASSES = 10;

    const args = ["python", "-S", "-c", code];
    const env = {
      PYTHONPATH: "/stdlib",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    };

    let stdout: Uint8Array = new Uint8Array(0);
    let stderr: Uint8Array = new Uint8Array(0);
    let exitCode = 0;

    for (let pass = 0; pass < MAX_REPLAY_PASSES; pass++) {
      fanout.resetPass();

      const files: Record<string, Uint8Array> = { ...stdlibBin };
      const wasi = createWasi(args, env, files, () => this.wasmMemory!, input, stdlibDirIndex);

      const mem: MemoryAccessor = {
        getMemBytes: () => this.getMemBytes(),
        readString: (ptr, len) => this.readString(ptr, len),
        writeBytes: (ptr, data, maxLen) => this.writeBytes(ptr, data, maxLen),
      };

      // Full host imports except threading (no recursive fan-out)
      const pymodeImports = buildHostImports({
        mem,
        env: this.env,
        fanout,
        // threading: undefined — prevents recursive DO spawning
        // dynamicLoading: undefined — no extension modules in thread context
      });

      const imports = {
        wasi_snapshot_preview1: wasi.imports,
        pymode: pymodeImports,
      };

      const result = await WebAssembly.instantiate(pythonWasm, imports);
      const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
      this.wasmMemory = instance.exports.memory as WebAssembly.Memory;

      exitCode = 0;
      try {
        (instance.exports._start as Function)();
      } catch (e: unknown) {
        if (e instanceof ProcExit) exitCode = e.code;
        else throw e;
      }

      stdout = wasi.getStdout();
      stderr = wasi.getStderr();

      // If no pending async calls, we're done
      if (!fanout.hasPending) break;

      // Resolve all pending calls in parallel, then replay
      await resolveAll(fanout, this.env as Record<string, unknown>);
    }

    return { stdout, stderr, exitCode };
  }
}
