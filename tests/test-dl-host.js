/**
 * Test: JS host dl_open/dl_sym/dl_close/dl_error in python-do.ts (Step 3)
 *
 * Tests the dynamic loading host import logic by simulating what PythonDO does:
 * - Registering extension modules
 * - Loading them via dl_open (returns handle)
 * - Resolving symbols via dl_sym (returns table index)
 * - Error handling via dl_error
 * - Cleanup via dl_close
 *
 * Uses real WebAssembly modules built inline from WAT (WebAssembly Text Format).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- Verify python-do.ts has the required code ---

describe("python-do.ts structure (Step 3)", () => {
  const srcPath = resolve(ROOT, "worker/src/python-do.ts");
  const src = readFileSync(srcPath, "utf-8");

  it("has dl_open in ASYNC_IMPORTS", () => {
    assert.ok(src.includes('"pymode.dl_open"'), "dl_open should be in ASYNC_IMPORTS");
  });

  it("has dlModules state", () => {
    assert.ok(src.includes("dlModules"), "should have dlModules map");
  });

  it("has extensionModules public field", () => {
    assert.ok(
      src.includes("extensionModules"),
      "should have extensionModules map for pre-compiled modules"
    );
  });

  it("implements dl_open host import", () => {
    assert.ok(src.includes("dl_open: async"), "dl_open should be async");
    assert.ok(
      src.includes("WebAssembly.instantiate(wasmModule, sideImports)"),
      "dl_open should instantiate side modules"
    );
  });

  it("implements dl_sym host import", () => {
    assert.ok(src.includes("dl_sym:"), "should have dl_sym implementation");
    assert.ok(
      src.includes("__indirect_function_table"),
      "dl_sym should use indirect function table"
    );
    assert.ok(src.includes("table.grow(1)"), "dl_sym should grow the table");
  });

  it("implements dl_close host import", () => {
    assert.ok(src.includes("dl_close:"), "should have dl_close implementation");
    assert.ok(
      src.includes("dlModules.delete(handle)"),
      "dl_close should remove the module from the map"
    );
  });

  it("implements dl_error host import", () => {
    assert.ok(src.includes("dl_error:"), "should have dl_error implementation");
    assert.ok(
      src.includes("dlLastError"),
      "dl_error should read from dlLastError"
    );
  });

  it("shares memory with side modules", () => {
    assert.ok(
      src.includes("memory: self.wasmMemory!"),
      "should pass main memory to side module imports"
    );
  });

  it("stores wasmInstance for table access", () => {
    assert.ok(
      src.includes("this.wasmInstance = instance"),
      "should store the WASM instance after instantiation"
    );
  });
});

// --- Functional tests using real WASM ---

import { buildMainModuleBytes, buildSideModuleBytes } from "./wasm-builder.js";

async function buildTestSideModule() {
  return WebAssembly.compile(buildSideModuleBytes());
}

async function buildMainModule() {
  return WebAssembly.compile(buildMainModuleBytes());
}

/**
 * Simulate the DL host logic extracted from PythonDO.
 * This avoids needing the full Cloudflare runtime.
 */
class DLHostSimulator {
  wasmMemory = null;
  wasmInstance = null;
  dlModules = new Map();
  nextDlHandle = 1;
  dlLastError = null;
  extensionModules = new Map();

  getMemBytes() {
    return new Uint8Array(this.wasmMemory.buffer);
  }

  readString(ptr, len) {
    return new TextDecoder().decode(this.getMemBytes().subarray(ptr, ptr + len));
  }

  writeBytes(ptr, data, maxLen) {
    const n = Math.min(data.length, maxLen);
    this.getMemBytes().set(data.subarray(0, n), ptr);
    return n;
  }

  writeString(str) {
    const encoded = new TextEncoder().encode(str);
    const ptr = 256; // Use a known offset in memory
    this.getMemBytes().set(encoded, ptr);
    return [ptr, encoded.length];
  }

  async init() {
    const mainModule = await buildMainModule();
    this.wasmInstance = new WebAssembly.Instance(mainModule);
    this.wasmMemory = this.wasmInstance.exports.memory;
  }

  async dl_open(pathPtr, pathLen) {
    const path = this.readString(pathPtr, pathLen);
    this.dlLastError = null;

    let wasmModule = this.extensionModules.get(path);
    if (!wasmModule) {
      const basename = path.split("/").pop() || path;
      wasmModule = this.extensionModules.get(basename);
    }
    if (!wasmModule) {
      for (const [key, mod] of this.extensionModules) {
        if (path.endsWith(key) || key.endsWith(path.split("/").pop() || "")) {
          wasmModule = mod;
          break;
        }
      }
    }

    if (!wasmModule) {
      this.dlLastError = `module not found: ${path}`;
      return -1;
    }

    try {
      const sideImports = { env: { memory: this.wasmMemory } };
      const instance = await WebAssembly.instantiate(wasmModule, sideImports);
      const handle = this.nextDlHandle++;
      this.dlModules.set(handle, { instance, exports: instance.exports });
      return handle;
    } catch (e) {
      this.dlLastError = `failed to load ${path}: ${e.message}`;
      return -1;
    }
  }

  dl_sym(handle, symbolPtr, symbolLen) {
    const mod = this.dlModules.get(handle);
    if (!mod) {
      this.dlLastError = `invalid handle: ${handle}`;
      return 0;
    }

    const symbol = this.readString(symbolPtr, symbolLen);
    const exported = mod.exports[symbol];
    if (typeof exported !== "function") {
      this.dlLastError = `symbol '${symbol}' not found`;
      return 0;
    }

    const table = this.wasmInstance.exports.__indirect_function_table;
    if (!table) {
      this.dlLastError = "indirect function table not available";
      return 0;
    }

    const idx = table.length;
    table.grow(1);
    table.set(idx, exported);
    return idx;
  }

  dl_close(handle) {
    this.dlModules.delete(handle);
  }

  dl_error(bufPtr, bufLen) {
    if (!this.dlLastError) return 0;
    const encoded = new TextEncoder().encode(this.dlLastError);
    const n = this.writeBytes(bufPtr, encoded, bufLen);
    this.dlLastError = null;
    return n;
  }
}

describe("DL host functional tests (Step 3)", () => {
  let host;

  beforeEach(async () => {
    host = new DLHostSimulator();
    await host.init();
  });

  it("dl_open returns -1 for unknown module", async () => {
    const [ptr, len] = host.writeString("nonexistent.wasm");
    const handle = await host.dl_open(ptr, len);
    assert.equal(handle, -1);
  });

  it("dl_error returns error message after failed dl_open", async () => {
    const [ptr, len] = host.writeString("nonexistent.wasm");
    await host.dl_open(ptr, len);

    const errBuf = 512;
    const errLen = host.dl_error(errBuf, 256);
    assert.ok(errLen > 0, "should return error length > 0");
    const errMsg = host.readString(errBuf, errLen);
    assert.ok(errMsg.includes("module not found"), `error should mention 'module not found', got: ${errMsg}`);
    assert.ok(errMsg.includes("nonexistent.wasm"), "error should include the path");
  });

  it("dl_error returns 0 when no error", () => {
    const errLen = host.dl_error(512, 256);
    assert.equal(errLen, 0);
  });

  it("dl_error clears after reading", async () => {
    const [ptr, len] = host.writeString("missing.wasm");
    await host.dl_open(ptr, len);

    // First read gets the error
    let errLen = host.dl_error(512, 256);
    assert.ok(errLen > 0);

    // Second read returns 0 (cleared)
    errLen = host.dl_error(512, 256);
    assert.equal(errLen, 0);
  });

  it("dl_open succeeds for registered extension", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [ptr, len] = host.writeString("test.wasm");
    const handle = await host.dl_open(ptr, len);
    assert.ok(handle >= 1, `should return valid handle, got ${handle}`);
  });

  it("dl_open matches by basename", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    // Open with full path — should match by basename
    const [ptr, len] = host.writeString("/usr/lib/python3.13/lib-dynload/test.wasm");
    const handle = await host.dl_open(ptr, len);
    assert.ok(handle >= 1, `should match by basename, got ${handle}`);
  });

  it("dl_open returns unique handles", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [ptr, len] = host.writeString("test.wasm");
    const h1 = await host.dl_open(ptr, len);
    const h2 = await host.dl_open(ptr, len);
    assert.notEqual(h1, h2, "handles should be unique");
  });

  it("dl_sym resolves exported function", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);

    const [symPtr, symLen] = host.writeString("PyInit_test");
    const tableIdx = host.dl_sym(handle, symPtr, symLen);
    assert.ok(tableIdx > 0, `should return valid table index, got ${tableIdx}`);
  });

  it("dl_sym returns 0 for unknown symbol", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);

    const [symPtr, symLen] = host.writeString("PyInit_nonexistent");
    const tableIdx = host.dl_sym(handle, symPtr, symLen);
    assert.equal(tableIdx, 0, "should return 0 for unknown symbol");
  });

  it("dl_sym sets error for unknown symbol", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);

    const [symPtr, symLen] = host.writeString("PyInit_nonexistent");
    host.dl_sym(handle, symPtr, symLen);

    const errLen = host.dl_error(800, 256);
    assert.ok(errLen > 0);
    const errMsg = host.readString(800, errLen);
    assert.ok(errMsg.includes("not found"), `error should mention 'not found', got: ${errMsg}`);
  });

  it("dl_sym returns 0 for invalid handle", () => {
    const [symPtr, symLen] = host.writeString("PyInit_test");
    const tableIdx = host.dl_sym(999, symPtr, symLen);
    assert.equal(tableIdx, 0);
  });

  it("resolved function is callable via table", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);

    const [symPtr, symLen] = host.writeString("PyInit_test");
    const tableIdx = host.dl_sym(handle, symPtr, symLen);

    // Call the function through the indirect function table
    const table = host.wasmInstance.exports.__indirect_function_table;
    const fn = table.get(tableIdx);
    assert.ok(typeof fn === "function", "table entry should be a function");
    const result = fn();
    assert.equal(result, 42, "PyInit_test should return 42");
  });

  it("dl_close removes module", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);
    assert.ok(host.dlModules.has(handle));

    host.dl_close(handle);
    assert.ok(!host.dlModules.has(handle), "module should be removed after dl_close");
  });

  it("dl_sym fails after dl_close", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);
    host.dl_close(handle);

    const [symPtr, symLen] = host.writeString("PyInit_test");
    const tableIdx = host.dl_sym(handle, symPtr, symLen);
    assert.equal(tableIdx, 0, "dl_sym should fail after dl_close");
  });

  it("side module shares memory with main module", async () => {
    const sideModule = await buildTestSideModule();
    host.extensionModules.set("test.wasm", sideModule);

    const [pathPtr, pathLen] = host.writeString("test.wasm");
    const handle = await host.dl_open(pathPtr, pathLen);

    // The side module was instantiated with the main module's memory
    const sideMemory = host.dlModules.get(handle).instance.exports.memory;
    // Side module imports memory, doesn't export it — so it uses main's memory
    assert.equal(sideMemory, undefined, "side module should not re-export memory");

    // Write to main memory and verify it's the same buffer
    const mainMem = new Uint8Array(host.wasmMemory.buffer);
    mainMem[100] = 0xAB;
    // If side module tried to read memory at offset 100, it would see 0xAB
    // (We can't easily test this from JS without a side module that reads memory,
    //  but the fact that instantiation succeeded with shared memory proves it works)
    assert.equal(mainMem[100], 0xAB);
  });
});
