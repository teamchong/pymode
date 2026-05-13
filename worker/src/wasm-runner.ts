/**
 * WasmRunner — runs the pymode wasm directly in the worker isolate
 * (not via a Durable Object), avoiding the DO RPC round-trip.
 *
 * Module-scope persistence: this class is instantiated once at worker
 * load time. Each isolate gets its own instance; the cached wasm
 * Instance survives across requests handled by the same isolate.
 *
 * The fast path matches python-do.ts's persistent runner: cache the
 * wasm Instance, reset stdin/stdout/stack-pointer between requests,
 * call the custom `pymode_warm_run` export to bypass wasi-libc's
 * one-shot _start wrapper.
 *
 * Limitations vs PythonDO:
 *  - No /data R2 persistence (worker isolates have no per-isolate id).
 *  - No TcpPoolDO / ThreadDO spawns (would need DO routing).
 *  - No fanout-replay for KV/R2/D1 — those host imports would need
 *    to await synchronously from this path, which is currently driven
 *    by fan-out replay. For workloads that don't touch CF bindings
 *    (the benchmark suite), this isn't needed.
 */

import { getPythonWasm } from "./python-wasm-loader";
import { ProcExit, createWasi, makeWasiState, type WasiState } from "./wasi";
import { encoder as _encoder, decoder as _decoder, stdlibBin, stdlibDirIndex, getExtensionPackagesBin, getStdlibBin, warmExtensionPackages } from "./stdlib-bin";
import { buildHostImports } from "./host-imports";
import { FanoutContext, resolveAll } from "./fanout";

// Site-packages bytes baked at module load (same as python-do.ts).
// @ts-ignore — Data module import (ArrayBuffer)
import sitePackagesZip from "./site-packages.zip";
const _sitePackagesBin: Uint8Array | undefined =
  sitePackagesZip.byteLength > 22 ? new Uint8Array(sitePackagesZip) : undefined;

interface PersistentInstance {
  instance: WebAssembly.Instance;
  wasiState: WasiState;
  wasi: ReturnType<typeof createWasi>;
  userFilesKey: string;
  initialStackPointer: number | undefined;
}

export class WasmRunner {
  private persistent: PersistentInstance | null = null;
  private wasmMemory: WebAssembly.Memory | null = null;
  private wasmInstance: WebAssembly.Instance | null = null;

  // Per-isolate dynamic-loading state (numpy etc. side modules).
  private dlModules = new Map<number, { instance: WebAssembly.Instance; exports: WebAssembly.Exports }>();
  private nextDlHandle = 1;
  private dlLastError: string | null = null;

  // Serialise requests so two concurrent fetch handlers don't trample
  // the shared cached instance.
  private queue: Promise<unknown> = Promise.resolve();

  private writeBytes(ptr: number, bytes: Uint8Array, maxLen: number): number {
    const n = Math.min(bytes.length, maxLen);
    const mem = new Uint8Array(this.wasmMemory!.buffer);
    mem.set(bytes.subarray(0, n), ptr);
    return n;
  }

  private buildMemoryAccessor() {
    const self = this;
    return {
      getMemBytes(): Uint8Array {
        return new Uint8Array(self.wasmMemory!.buffer);
      },
      readString(ptr: number, len: number): string {
        return _decoder.decode(new Uint8Array(self.wasmMemory!.buffer, ptr, len));
      },
      writeBytes(ptr: number, data: Uint8Array, maxLen: number): number {
        return self.writeBytes(ptr, data, maxLen);
      },
    };
  }

  async handleRequest(
    entryModule: string,
    userFiles: Record<string, string>,
    pythonPath: string,
    requestJson: string,
    env: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Warm the gzip-decompressed stdlib + assets-hosted extension zip
    // before the first run. Worker.ts already awaited these in the entry
    // path, but the persistent path can land here cold.
    const envAssets = env as { ASSETS?: { fetch: (r: Request) => Promise<Response> } };
    await Promise.all([
      getStdlibBin(envAssets),
      warmExtensionPackages(envAssets),
    ]);
    // Serialise — wasm execution is synchronous within an isolate, but
    // the async setup around it can interleave between calls.
    const turn = this.queue.then(() => this._run(entryModule, userFiles, pythonPath, requestJson, env));
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async _run(
    entryModule: string,
    userFiles: Record<string, string>,
    pythonPath: string,
    requestJson: string,
    env: Record<string, unknown>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const wasmEnv = {
      PYTHONPATH: pythonPath,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    };
    const stdinData = _encoder.encode(requestJson);
    const args = ["python", "-S", "-m", "pymode._handler", entryModule];

    const userFilesKey = Object.keys(userFiles).sort().join("\n");

    // ── Persistent fast path ────────────────────────────────────────
    const warmRunFn = this.persistent?.instance.exports.pymode_warm_run as
      ((ptr: number, len: number) => number) | undefined;
    if (this.persistent && this.persistent.userFilesKey === userFilesKey && warmRunFn && entryModule) {
      const { instance, wasiState, wasi, initialStackPointer } = this.persistent;
      wasiState.stdinData = stdinData;
      wasiState.stdinOffset = 0;
      wasiState.stdoutChunks.length = 0;
      wasiState.stderrChunks.length = 0;
      wasiState.exited = false;
      wasiState.exitCode = 0;
      const sp = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
      if (sp && initialStackPointer !== undefined) sp.value = initialStackPointer;
      try {
        const enc = _encoder.encode(entryModule);
        const malloc = instance.exports.PyMem_RawMalloc as ((n: number) => number);
        const free = instance.exports.PyMem_RawFree as ((p: number) => void);
        const ptr = malloc(enc.length);
        const memBytes = new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);
        memBytes.set(enc, ptr);
        let warmExitCode = 0;
        try {
          warmExitCode = warmRunFn(ptr, enc.length);
        } finally {
          free(ptr);
        }
        const stdout = _decoder.decode(wasi.getStdout());
        const stderr = _decoder.decode(wasi.getStderr());
        return { stdout, stderr, exitCode: warmExitCode };
      } catch (e) {
        console.log("[WasmRunner] persistent path trap:", e instanceof Error ? e.message : String(e));
        this.persistent = null;
        // Fall through to slow path.
      }
    }

    // ── Slow path: fresh wasm instance ──────────────────────────────
    const baseFiles: Record<string, Uint8Array> = { ...stdlibBin };
    for (const [path, content] of Object.entries(userFiles)) {
      baseFiles[path] = _encoder.encode(content);
    }
    if (_sitePackagesBin) baseFiles["site-packages.zip"] = _sitePackagesBin;
    if (getExtensionPackagesBin()) {
      baseFiles["extension-site-packages.zip"] = getExtensionPackagesBin();
    }

    const fanout = new FanoutContext();
    const MAX_REPLAY_PASSES = 10;
    const slowPathWasiState = makeWasiState(stdinData);

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (let pass = 0; pass < MAX_REPLAY_PASSES; pass++) {
      fanout.resetPass();
      slowPathWasiState.stdinData = stdinData;
      slowPathWasiState.stdinOffset = 0;
      slowPathWasiState.stdoutChunks.length = 0;
      slowPathWasiState.stderrChunks.length = 0;
      slowPathWasiState.exited = false;
      slowPathWasiState.exitCode = 0;

      const files = { ...baseFiles };
      const wasi = createWasi(args, wasmEnv, files, () => this.wasmMemory!, slowPathWasiState, stdlibDirIndex);
      const zbOpts: { memory?: WebAssembly.Memory } = {};

      const pymodeImports = buildHostImports({
        mem: this.buildMemoryAccessor(),
        env,
        get memory() { return zbOpts.memory; },
        zerobufRequest: undefined,
        zbExchangePtrRef: undefined,
        fanout,
        dynamicLoading: {
          open: () => -1,
          sym: () => 0,
          close: () => undefined,
          error: () => 0,
        },
      });

      const imports = {
        wasi_snapshot_preview1: wasi.imports,
        pymode: pymodeImports,
      };

      const result = await WebAssembly.instantiate(await getPythonWasm(), imports);
      const instance = (result as any).exports ? result as WebAssembly.Instance : (result as any).instance;
      this.wasmInstance = instance;
      this.wasmMemory = instance.exports.memory as WebAssembly.Memory;
      zbOpts.memory = this.wasmMemory;

      const spExport = instance.exports.__stack_pointer as WebAssembly.Global | undefined;
      const freshStackPointer = spExport ? (spExport.value as number) : undefined;

      exitCode = 0;
      try {
        (instance.exports._start as Function)();
      } catch (e: unknown) {
        if (e instanceof ProcExit) exitCode = e.code;
        else throw e;
      }
      if (slowPathWasiState.exited) exitCode = slowPathWasiState.exitCode;

      stdout = _decoder.decode(wasi.getStdout());
      stderr = _decoder.decode(wasi.getStderr());

      if (!fanout.hasPending) {
        this.persistent = {
          instance,
          wasiState: slowPathWasiState,
          wasi,
          userFilesKey,
          initialStackPointer: freshStackPointer,
        };
        break;
      }
      await resolveAll(fanout, env);
    }

    return { stdout, stderr, exitCode };
  }
}
