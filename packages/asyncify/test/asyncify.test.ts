import { describe, it, expect } from "vitest";
import { AsyncifyRuntime } from "../src/index";

describe("AsyncifyRuntime", () => {
  describe("wrapImports", () => {
    it("passes through sync imports unchanged", () => {
      const runtime = new AsyncifyRuntime();
      const syncFn = () => 42;
      const wrapped = runtime.wrapImports(
        { mymod: { sync_fn: syncFn } },
        new Set() // no async imports
      );
      expect(wrapped["mymod"]["sync_fn"]).toBe(syncFn);
    });

    it("wraps async imports", () => {
      const runtime = new AsyncifyRuntime();
      const asyncFn = async () => 42;
      const wrapped = runtime.wrapImports(
        { mymod: { async_fn: asyncFn } },
        new Set(["mymod.async_fn"])
      );
      // Should be wrapped — not the same function
      expect(wrapped["mymod"]["async_fn"]).not.toBe(asyncFn);
      expect(typeof wrapped["mymod"]["async_fn"]).toBe("function");
    });

    it("does not wrap non-function values", () => {
      const runtime = new AsyncifyRuntime();
      const wrapped = runtime.wrapImports(
        { mymod: { memory: new WebAssembly.Memory({ initial: 1 }) } },
        new Set(["mymod.memory"])
      );
      // Memory objects should pass through even if listed as async
      expect(wrapped["mymod"]["memory"]).toBeInstanceOf(WebAssembly.Memory);
    });

    it("adds asyncify control imports", () => {
      const runtime = new AsyncifyRuntime();
      const wrapped = runtime.wrapImports({ mymod: {} }, new Set());
      expect(wrapped["asyncify"]).toBeDefined();
      expect(typeof wrapped["asyncify"]["start_unwind"]).toBe("function");
      expect(typeof wrapped["asyncify"]["stop_unwind"]).toBe("function");
      expect(typeof wrapped["asyncify"]["start_rewind"]).toBe("function");
      expect(typeof wrapped["asyncify"]["stop_rewind"]).toBe("function");
    });

    it("preserves multiple modules", () => {
      const runtime = new AsyncifyRuntime();
      const wrapped = runtime.wrapImports(
        {
          wasi: { fd_write: () => 0, fd_read: () => 0 },
          pymode: { tcp_recv: async () => 0, env_get: () => 0 },
        },
        new Set(["pymode.tcp_recv"])
      );
      // wasi functions should pass through
      expect(typeof wrapped["wasi"]["fd_write"]).toBe("function");
      expect(typeof wrapped["wasi"]["fd_read"]).toBe("function");
      // pymode.env_get is sync — should pass through
      expect(typeof wrapped["pymode"]["env_get"]).toBe("function");
      // pymode.tcp_recv is async — should be wrapped
      expect(typeof wrapped["pymode"]["tcp_recv"]).toBe("function");
    });

    it("only wraps imports listed in asyncImportNames", () => {
      const runtime = new AsyncifyRuntime();
      const fn1 = async () => 1;
      const fn2 = async () => 2;
      const wrapped = runtime.wrapImports(
        { mod: { listed: fn1, unlisted: fn2 } },
        new Set(["mod.listed"])
      );
      // listed should be wrapped
      expect(wrapped["mod"]["listed"]).not.toBe(fn1);
      // unlisted should pass through (even though it's async)
      expect(wrapped["mod"]["unlisted"]).toBe(fn2);
    });
  });

  describe("init", () => {
    it("initializes with a WASM instance", () => {
      const runtime = new AsyncifyRuntime();
      const memory = new WebAssembly.Memory({ initial: 2 }); // 128KB

      // Create a mock instance with required exports
      const mockInstance = {
        exports: {
          memory,
          asyncify_start_rewind: () => {},
        },
      } as unknown as WebAssembly.Instance;

      // Should not throw
      expect(() => runtime.init(mockInstance)).not.toThrow();
    });

    it("writes valid stack bounds to memory", () => {
      const runtime = new AsyncifyRuntime();
      const memory = new WebAssembly.Memory({ initial: 2 });

      const mockInstance = {
        exports: {
          memory,
          asyncify_start_rewind: () => {},
        },
      } as unknown as WebAssembly.Instance;

      runtime.init(mockInstance);

      // The data region should have valid start < end pointers
      const view = new DataView(memory.buffer);
      const memSize = memory.buffer.byteLength;
      const dataAddr = memSize - 16384; // ASYNCIFY_DATA_SIZE

      const stackStart = view.getInt32(dataAddr, true);
      const stackEnd = view.getInt32(dataAddr + 4, true);

      expect(stackStart).toBe(dataAddr + 8);
      expect(stackEnd).toBe(dataAddr + 16384);
      expect(stackStart).toBeLessThan(stackEnd);
    });
  });

  describe("callExport", () => {
    it("throws for missing export", async () => {
      const runtime = new AsyncifyRuntime();
      const memory = new WebAssembly.Memory({ initial: 2 });

      const mockInstance = {
        exports: { memory },
      } as unknown as WebAssembly.Instance;

      runtime.init(mockInstance);

      await expect(runtime.callExport("nonexistent")).rejects.toThrow(
        "Export nonexistent not found"
      );
    });

    it("calls a sync export directly", async () => {
      const runtime = new AsyncifyRuntime();
      const memory = new WebAssembly.Memory({ initial: 2 });

      let called = false;
      const mockInstance = {
        exports: {
          memory,
          my_func: () => {
            called = true;
            return 42;
          },
        },
      } as unknown as WebAssembly.Instance;

      runtime.init(mockInstance);
      const result = await runtime.callExport("my_func");
      expect(called).toBe(true);
      expect(result).toBe(42);
    });
  });
});
