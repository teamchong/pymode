/**
 * Test: build-extension.sh and build-phase2.sh integration (Steps 4-5)
 *
 * Step 4: Validates the build script exists and has correct structure
 * Step 5: Validates the full pipeline — config.site, build-phase2, dynload shim
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("build-extension.sh (Step 4)", () => {
  const scriptPath = resolve(ROOT, "scripts/build-extension.sh");

  it("script exists and is executable", () => {
    assert.ok(existsSync(scriptPath), "build-extension.sh should exist");
    const stat = execSync(`stat -f '%A' "${scriptPath}"`).toString().trim();
    assert.ok(stat.endsWith("5") || stat.endsWith("7"), `should be executable, got mode ${stat}`);
  });

  const src = readFileSync(scriptPath, "utf-8");

  it("compiles to .wasm side modules (not static .a)", () => {
    assert.ok(src.includes(".wasm"), "should produce .wasm output");
    assert.ok(!src.includes("rcs") || !src.includes("libmarkupsafe.a"),
      "should NOT produce static archives with the old approach");
  });

  it("uses --import-memory for shared memory", () => {
    assert.ok(src.includes("--import-memory"),
      "side modules must import memory from host (shared with python.wasm)");
  });

  it("uses --allow-undefined for CPython API symbols", () => {
    assert.ok(src.includes("--allow-undefined"),
      "CPython API symbols are resolved at runtime");
  });

  it("uses --no-entry (library, not executable)", () => {
    assert.ok(src.includes("--no-entry"),
      "side modules are libraries, not executables");
  });

  it("uses --export-dynamic for PyInit symbols", () => {
    assert.ok(src.includes("--export-dynamic"),
      "PyInit_* symbols must be exported");
  });

  it("supports markupsafe", () => {
    assert.ok(src.includes("markupsafe"), "should support markupsafe");
    assert.ok(src.includes("_speedups"), "should handle _speedups.c");
  });

  it("supports simplejson", () => {
    assert.ok(src.includes("simplejson"), "should support simplejson");
  });

  it("supports msgpack", () => {
    assert.ok(src.includes("msgpack"), "should support msgpack");
  });

  it("has --list flag", () => {
    assert.ok(src.includes("--list"), "should support --list");
  });

  it("has --all flag", () => {
    assert.ok(src.includes("--all"), "should support --all to build all extensions");
  });

  it("outputs to .pymode/extensions/", () => {
    assert.ok(src.includes(".pymode/extensions"),
      "output should go to .pymode/extensions/ directory");
  });

  it("--list prints help without errors", () => {
    const result = execSync(`bash "${scriptPath}" --list 2>&1`).toString();
    assert.ok(result.includes("markupsafe"), "--list should mention markupsafe");
    assert.ok(result.includes("simplejson"), "--list should mention simplejson");
  });
});

describe("build-phase2.sh integration (Step 5)", () => {
  const buildScript = readFileSync(resolve(ROOT, "scripts/build-phase2.sh"), "utf-8");
  const configSite = readFileSync(resolve(ROOT, "scripts/config.site-wasi"), "utf-8");

  it("config.site sets DYNLOADFILE to dynload_pymode.o", () => {
    assert.ok(
      configSite.includes('DYNLOADFILE="dynload_pymode.o"'),
      "config.site-wasi should set DYNLOADFILE to dynload_pymode.o"
    );
  });

  it("config.site enables dlopen for HAVE_DYNAMIC_LOADING", () => {
    assert.ok(
      configSite.includes("ac_cv_func_dlopen=yes"),
      "should enable dlopen detection so importdl.c compiles"
    );
  });

  it("build script compiles dynload_pymode.c with CPython headers", () => {
    assert.ok(
      buildScript.includes("dynload_pymode"),
      "should handle dynload_pymode.c compilation"
    );
    assert.ok(
      buildScript.includes('CPython headers'),
      "should compile dynload_pymode with CPython include paths"
    );
  });

  it("asyncify imports include dl_open", () => {
    assert.ok(
      buildScript.includes("pymode.dl_open"),
      "ASYNC_IMPORTS in build script should include pymode.dl_open"
    );
  });

  it("dynload_pymode.c exists in wasi-shims", () => {
    assert.ok(
      existsSync(resolve(ROOT, "lib/wasi-shims/dynload_pymode.c")),
      "dynload_pymode.c should exist in lib/wasi-shims/"
    );
  });
});

describe("End-to-end pipeline validation (Step 5)", () => {
  it("all pieces connect: config.site -> dynload shim -> host imports -> JS host", () => {
    // Verify the full chain exists
    const pieces = [
      "scripts/config.site-wasi",          // Sets DYNLOADFILE=dynload_pymode.o
      "lib/wasi-shims/dynload_pymode.c",   // C shim: calls pymode.dl_open/dl_sym
      "lib/pymode-imports/pymode_imports.h",// Declares dl_open/dl_sym/dl_close/dl_error
      "worker/src/python-do.ts",           // JS host: implements dl_open/dl_sym
      "scripts/build-extension.sh",        // Builds C extensions to .wasm side modules
    ];
    for (const piece of pieces) {
      assert.ok(existsSync(resolve(ROOT, piece)), `${piece} should exist`);
    }
  });

  it("dynload_pymode.c imports match python-do.ts exports", () => {
    const cShim = readFileSync(resolve(ROOT, "lib/wasi-shims/dynload_pymode.c"), "utf-8");
    const jsHost = readFileSync(resolve(ROOT, "worker/src/python-do.ts"), "utf-8");

    // C shim imports these functions via WASM host imports
    const cImports = ["dl_open", "dl_sym", "dl_close", "dl_error"];
    for (const imp of cImports) {
      assert.ok(
        cShim.includes(`import_name("${imp}")`),
        `C shim should import ${imp}`
      );
      assert.ok(
        jsHost.includes(`${imp}:`),
        `JS host should implement ${imp}`
      );
    }
  });

  it("asyncify imports are consistent between build script and JS", () => {
    const buildScript = readFileSync(resolve(ROOT, "scripts/build-phase2.sh"), "utf-8");
    const jsHost = readFileSync(resolve(ROOT, "worker/src/python-do.ts"), "utf-8");

    // dl_open must be in both
    assert.ok(buildScript.includes("pymode.dl_open"), "build script asyncify should include dl_open");
    assert.ok(jsHost.includes('"pymode.dl_open"'), "JS ASYNC_IMPORTS should include dl_open");
  });

  it("build-extension.sh produces wasm with shared memory (not static lib)", () => {
    const script = readFileSync(resolve(ROOT, "scripts/build-extension.sh"), "utf-8");

    // Should use --import-memory (shared with python.wasm)
    assert.ok(script.includes("--import-memory"), "must share memory with main module");

    // Should NOT produce .a static archives
    assert.ok(
      !script.includes("zig ar rcs"),
      "should not produce static archives (old approach)"
    );
  });

  it("README reflects C extension support", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8");

    // Should mention C extensions are supported
    assert.ok(
      readme.includes("C extension") || readme.includes("c extension"),
      "README should mention C extension support"
    );
    assert.ok(
      readme.includes("build-extension"),
      "README should mention build-extension script"
    );
  });
});
