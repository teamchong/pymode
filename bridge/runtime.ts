/**
 * Python WASM Runtime for Cloudflare Workers
 *
 * Manages the lifecycle of a CPython WASM instance within a Worker.
 * Provides the bridge between JavaScript and Python by:
 * 1. Instantiating the WASM module with WASI imports
 * 2. Mapping Cloudflare services (R2, D1, KV) to Python I/O
 * 3. Converting between JS objects and Python objects
 */

import type { Env } from "./worker";
import { createBindings } from "./bindings";

interface PythonResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

export class PythonRuntime {
  private instance: WebAssembly.Instance;
  private memory: WebAssembly.Memory;
  private env: Env;

  private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, env: Env) {
    this.instance = instance;
    this.memory = memory;
    this.env = env;
  }

  static async create(env: Env): Promise<PythonRuntime> {
    // @ts-expect-error - WASM module imported via bundler
    const wasmModule = await import("../build/python.wasm");

    const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024 });
    const bindings = createBindings(env, memory);

    const instance = await WebAssembly.instantiate(wasmModule.default, {
      wasi_snapshot_preview1: bindings.wasi,
      env: bindings.env,
      zigpython: bindings.bridge,
    });

    const runtime = new PythonRuntime(instance, memory, env);
    runtime.initialize();
    return runtime;
  }

  private initialize(): void {
    // Call CPython's Py_Initialize via exported WASM function
    const exports = this.instance.exports as Record<string, WebAssembly.ExportValue>;
    const pyInit = exports["Py_Initialize"] as CallableFunction;
    if (pyInit) {
      pyInit();
    }
  }

  async callHandler(
    moduleName: string,
    functionName: string,
    requestDict: Record<string, unknown>
  ): Promise<PythonResponse> {
    const exports = this.instance.exports as Record<string, WebAssembly.ExportValue>;

    // Serialize request to JSON, pass to Python, get JSON response back
    const requestJson = JSON.stringify(requestDict);
    const requestBytes = new TextEncoder().encode(requestJson);

    // Write request JSON into WASM memory
    const mallocFn = exports["malloc"] as (size: number) => number;
    const ptr = mallocFn(requestBytes.length + 1);
    const view = new Uint8Array(this.memory.buffer, ptr, requestBytes.length + 1);
    view.set(requestBytes);
    view[requestBytes.length] = 0; // null terminate

    // Call the Python handler bridge function
    // This is a C function exported from our bridge that:
    // 1. Imports the handler module
    // 2. Calls handle() with the request dict
    // 3. Returns a pointer to JSON response
    const callHandlerFn = exports["zigpython_call_handler"] as (
      modulePtr: number,
      moduleLen: number,
      funcPtr: number,
      funcLen: number,
      requestPtr: number,
      requestLen: number,
    ) => number;

    const moduleBytes = new TextEncoder().encode(moduleName);
    const funcBytes = new TextEncoder().encode(functionName);

    const modulePtr = mallocFn(moduleBytes.length);
    new Uint8Array(this.memory.buffer, modulePtr, moduleBytes.length).set(moduleBytes);

    const funcPtr = mallocFn(funcBytes.length);
    new Uint8Array(this.memory.buffer, funcPtr, funcBytes.length).set(funcBytes);

    const responsePtr = callHandlerFn(
      modulePtr, moduleBytes.length,
      funcPtr, funcBytes.length,
      ptr, requestBytes.length,
    );

    // Read response JSON from WASM memory
    const freeFn = exports["free"] as (ptr: number) => void;

    // Response is a null-terminated JSON string at responsePtr
    const responseView = new Uint8Array(this.memory.buffer, responsePtr);
    let responseEnd = 0;
    while (responseView[responseEnd] !== 0) responseEnd++;
    const responseJson = new TextDecoder().decode(responseView.slice(0, responseEnd));

    // Free allocated memory
    freeFn(ptr);
    freeFn(modulePtr);
    freeFn(funcPtr);
    freeFn(responsePtr);

    return JSON.parse(responseJson) as PythonResponse;
  }

  async cleanup(): Promise<void> {
    const exports = this.instance.exports as Record<string, WebAssembly.ExportValue>;
    const pyFinalize = exports["Py_FinalizeEx"] as CallableFunction;
    if (pyFinalize) {
      pyFinalize();
    }
  }
}
