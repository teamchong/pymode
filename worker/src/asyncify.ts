/**
 * Asyncify runtime for Binaryen-instrumented WASM modules.
 *
 * When a WASM module is built with `wasm-opt --asyncify`, it gets instrumented
 * to support stack unwinding/rewinding. This module provides the JS-side
 * integration: async WASM imports can return Promises, and the WASM stack
 * suspends until the Promise resolves, then resumes where it left off.
 *
 * Based on the asyncify-wasm pattern from Google Chrome Labs.
 * See: https://github.com/GoogleChromeLabs/asyncify
 */

// Asyncify uses a region of linear memory as a scratch buffer for
// saving/restoring the call stack. We allocate this from the WASM
// module's own memory.
const ASYNCIFY_DATA_SIZE = 16384;  // 16KB for stack state

enum AsyncifyState {
  NONE = 0,      // Normal execution
  UNWINDING = 1, // Stack is being unwound (async import was called)
  REWINDING = 2, // Stack is being rewound (async result available)
}

export class AsyncifyRuntime {
  private dataAddr: number = 0;
  private exports: any = null;
  private state: AsyncifyState = AsyncifyState.NONE;
  private memory: WebAssembly.Memory | null = null;

  /**
   * Wrap WASM imports so that async functions trigger Asyncify unwind/rewind.
   * Sync imports pass through unchanged.
   */
  wrapImports(
    imports: Record<string, Record<string, any>>,
    asyncImportNames: Set<string>
  ): Record<string, Record<string, any>> {
    const wrapped: Record<string, Record<string, any>> = {};

    for (const [moduleName, moduleImports] of Object.entries(imports)) {
      wrapped[moduleName] = {};
      for (const [name, fn] of Object.entries(moduleImports)) {
        const fullName = `${moduleName}.${name}`;
        if (asyncImportNames.has(fullName) && typeof fn === "function") {
          wrapped[moduleName][name] = this.wrapAsyncImport(fn);
        } else {
          wrapped[moduleName][name] = fn;
        }
      }
    }

    return wrapped;
  }

  /**
   * Initialize after WASM instantiation. Allocates the asyncify data buffer
   * in linear memory using the module's exported allocator or a fixed region.
   */
  init(instance: WebAssembly.Instance) {
    this.exports = instance.exports;
    this.memory = instance.exports.memory as WebAssembly.Memory;

    // Grow memory first, then place asyncify buffer in the newly allocated region.
    // This ensures the buffer doesn't overlap with CPython's heap allocator.
    const pages = Math.ceil(ASYNCIFY_DATA_SIZE / 65536);
    try {
      this.memory.grow(pages);
    } catch {
      // memory.grow can fail if at maximum — buffer is placed at end of
      // existing memory which must have ASYNCIFY_DATA_SIZE free bytes.
    }

    // Place buffer at end of (possibly grown) memory
    const memSize = this.memory.buffer.byteLength;
    this.dataAddr = memSize - ASYNCIFY_DATA_SIZE;

    // Initialize the data region: first 8 bytes are the stack pointer range
    const view = new DataView(this.memory.buffer);
    view.setInt32(this.dataAddr, this.dataAddr + 8, true);  // stack start
    view.setInt32(this.dataAddr + 4, this.dataAddr + ASYNCIFY_DATA_SIZE, true);  // stack end
  }

  /**
   * Call a WASM export, handling any async suspensions along the way.
   * Returns a Promise that resolves when the export finishes (including
   * all intermediate async operations).
   */
  async callExport(name: string, ...args: any[]): Promise<any> {
    const fn = this.exports[name];
    if (!fn) throw new Error(`Export ${name} not found`);

    this.state = AsyncifyState.NONE;

    // First call — normal execution until an async import suspends
    let result = fn(...args);

    // Loop: each iteration handles one async suspension
    while (this.state === AsyncifyState.UNWINDING) {
      // Finalize the unwind — WASM stack has been saved
      this.exports.asyncify_stop_unwind();
      this.state = AsyncifyState.NONE;

      // An async import was hit — its Promise is stored in this.pendingPromise
      // Wait for it to resolve
      await this.pendingPromise;
      this.pendingPromise = null;

      // Reset the asyncify data buffer for rewinding
      const view = new DataView(this.memory!.buffer);
      view.setInt32(this.dataAddr, this.dataAddr + 8, true);
      view.setInt32(this.dataAddr + 4, this.dataAddr + ASYNCIFY_DATA_SIZE, true);

      // Start rewinding — re-enter the function, it will fast-forward
      // to the point where it suspended
      this.exports.asyncify_start_rewind(this.dataAddr);
      this.state = AsyncifyState.REWINDING;
      result = fn(...args);
    }

    return result;
  }

  private pendingPromise: Promise<void> | null = null;
  private pendingReturnValue: any = null;

  /**
   * Wrap a single async import function.
   *
   * When called during normal execution or rewind-resume:
   * - During REWIND: return the cached result (the async op already completed)
   * - During NONE: call the function. If it returns a Promise, trigger unwind.
   *   If it returns a non-Promise, pass through (it was actually sync).
   */
  private wrapAsyncImport(fn: Function): Function {
    const runtime = this;

    return function (this: any, ...args: any[]) {
      // During rewind, the async op already completed — return cached value
      if (runtime.state === AsyncifyState.REWINDING) {
        runtime.exports.asyncify_stop_rewind();
        runtime.state = AsyncifyState.NONE;
        const val = runtime.pendingReturnValue;
        runtime.pendingReturnValue = null;
        return val;
      }

      // Normal execution — call the actual function
      const result = fn.apply(this, args);

      // If it returned a Promise, we need to suspend
      if (result && typeof result.then === "function") {
        // Store the promise for the run loop to await
        runtime.pendingPromise = result.then((resolvedValue: any) => {
          runtime.pendingReturnValue = resolvedValue;
        });

        // Trigger stack unwinding — WASM will return to JS
        runtime.exports.asyncify_start_unwind(runtime.dataAddr);
        runtime.state = AsyncifyState.UNWINDING;

        // Return value doesn't matter during unwind, but must match type
        return 0;
      }

      // Synchronous result — no suspension needed
      return result;
    };
  }
}
