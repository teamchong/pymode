/**
 * Test: dynload_pymode.c — structural validation
 *
 * Verifies that the C shim file exists, declares the correct WASM host imports,
 * and implements _PyImport_FindSharedFuncptr with the pymode.dl_* imports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("dynload_pymode.c (Step 1)", () => {
  const shimPath = resolve(ROOT, "lib/wasi-shims/dynload_pymode.c");

  it("file exists", () => {
    assert.ok(existsSync(shimPath), "dynload_pymode.c should exist");
  });

  const src = existsSync(shimPath) ? readFileSync(shimPath, "utf-8") : "";

  it("declares dl_open host import", () => {
    assert.ok(src.includes('import_name("dl_open")'), "should declare dl_open import");
    assert.ok(src.includes("pymode_dl_open"), "should have pymode_dl_open function");
  });

  it("declares dl_sym host import", () => {
    assert.ok(src.includes('import_name("dl_sym")'), "should declare dl_sym import");
    assert.ok(src.includes("pymode_dl_sym"), "should have pymode_dl_sym function");
  });

  it("declares dl_close host import", () => {
    assert.ok(src.includes('import_name("dl_close")'), "should declare dl_close import");
    assert.ok(src.includes("pymode_dl_close"), "should have pymode_dl_close function");
  });

  it("declares dl_error host import", () => {
    assert.ok(src.includes('import_name("dl_error")'), "should declare dl_error import");
    assert.ok(src.includes("pymode_dl_error"), "should have pymode_dl_error function");
  });

  it("implements _PyImport_FindSharedFuncptr", () => {
    assert.ok(
      src.includes("_PyImport_FindSharedFuncptr"),
      "should implement _PyImport_FindSharedFuncptr"
    );
  });

  it("supports .wasm file extension", () => {
    assert.ok(
      src.includes('".wasm"'),
      "should list .wasm in _PyImport_DynLoadFiletab"
    );
  });

  it("calls pymode_dl_open with pathname", () => {
    assert.ok(
      src.includes("pymode_dl_open(pathname"),
      "should call pymode_dl_open with the pathname argument"
    );
  });

  it("constructs PyInit function name", () => {
    assert.ok(
      src.includes("PyOS_snprintf(funcname"),
      "should construct the PyInit_<name> function name"
    );
  });

  it("calls pymode_dl_sym to resolve symbol", () => {
    assert.ok(
      src.includes("pymode_dl_sym(handle, funcname"),
      "should call pymode_dl_sym with handle and funcname"
    );
  });

  it("sets import error on failure", () => {
    assert.ok(
      src.includes("PyErr_SetImportError"),
      "should set import error when module not found"
    );
  });
});

describe("pymode_imports.h (Step 2)", () => {
  const headerPath = resolve(ROOT, "lib/pymode-imports/pymode_imports.h");

  it("file exists", () => {
    assert.ok(existsSync(headerPath), "pymode_imports.h should exist");
  });

  const src = existsSync(headerPath) ? readFileSync(headerPath, "utf-8") : "";

  it("declares dl_open", () => {
    assert.ok(src.includes("pymode_dl_open"), "should declare pymode_dl_open");
  });

  it("declares dl_sym", () => {
    assert.ok(src.includes("pymode_dl_sym"), "should declare pymode_dl_sym");
  });

  it("declares dl_close", () => {
    assert.ok(src.includes("pymode_dl_close"), "should declare pymode_dl_close");
  });

  it("declares dl_error", () => {
    assert.ok(src.includes("pymode_dl_error"), "should declare pymode_dl_error");
  });

  it("uses pymode import module", () => {
    // Count occurrences of dl_ imports with pymode module
    const dlImports = src.match(/import_module\("pymode"\).*import_name\("dl_/g);
    assert.ok(dlImports && dlImports.length >= 4, "should have 4 dl_* imports in pymode module");
  });
});
