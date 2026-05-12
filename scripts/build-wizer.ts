#!/usr/bin/env npx tsx
/**
 * Build a Wizer-pre-initialized python.wasm.
 *
 * Replaces Programs/python.o with pymode_wizer.o so the binary exports
 * wizer.initialize (CPython init + pre-imports) and a _start that
 * skips init when the snapshot flag is set.
 *
 * Produces: build/zig-wasi/python-wizer.wasm + worker/src/python-wizer.wasm
 *
 * Prerequisites:
 *     - build-phase2.ts completed (all .o files exist)
 *     - wizer installed (cargo install wizer --all-features)
 *     - wasm-opt installed (brew install binaryen)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const CPYTHON = path.join(ROOT_DIR, "cpython");
const BUILD_DIR = path.join(ROOT_DIR, "build", "zig-wasi");
const ZIG_CC = path.join(ROOT_DIR, "build", "zig-wrappers", "zig-cc");
const WIZER_DIR = path.join(ROOT_DIR, "lib", "wizer");
const IMPORTS_DIR = path.join(ROOT_DIR, "lib", "pymode-imports");
const OUTPUT = path.join(BUILD_DIR, "python-wizer.wasm");

// Build mode coordinated with build-phase2.ts via env vars. See the
// header comment in build-phase2.ts for what each mode means.
const BUILD_MODE = (process.env.PYMODE_BUILD_MODE || "test") as "test" | "app" | "variant";
const APP_PREIMPORTS_HEADER = process.env.PYMODE_APP_PREIMPORTS_HEADER || "";
const APP_PROJECT_DIR = process.env.PYMODE_APP_PROJECT_DIR || "";
const APP_ENTRY_MODULE = process.env.PYMODE_APP_ENTRY_MODULE || "";

// Variant mode: include exactly the listed recipes (comma-separated) and
// produce python-<variant-name>.wasm. The variant name itself is also
// the preimport target (e.g., "ujson" → import ujson at wizer time).
const VARIANT_NAME = process.env.PYMODE_VARIANT_NAME || "";
const VARIANT_RECIPES = (process.env.PYMODE_VARIANT_RECIPES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WORKER_WASM_FILENAME =
  BUILD_MODE === "test" ? "python.wasm"
  : BUILD_MODE === "variant" ? `python-${VARIANT_NAME}.wasm`
  : "python-app.wasm";

// Asyncify removed — fan-out replay handles async imports at runtime.

function mb(size: number): string {
  return `${(size / 1048576).toFixed(1)}MB`;
}

function which(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0;
}

function run(args: string[], opts?: { captureOutput?: boolean }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(args[0], args.slice(1), {
    stdio: opts?.captureOutput ? "pipe" : "inherit",
    encoding: opts?.captureOutput ? "utf-8" : undefined,
  });
  if (!opts?.captureOutput && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return {
    status: result.status,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  // Check prerequisites
  if (!fs.existsSync(path.join(BUILD_DIR, "python.wasm"))) {
    console.log("Error: python.wasm not found. Run build-phase2.ts first.");
    process.exit(1);
  }
  try {
    fs.accessSync(ZIG_CC, fs.constants.X_OK);
  } catch {
    console.log("Error: zig-cc wrapper not found. Run build-phase2.ts first.");
    process.exit(1);
  }
  if (!which("wizer")) {
    console.log(
      "Error: wizer not found. Install: cargo install wizer --all-features"
    );
    process.exit(1);
  }

  console.log("=== Building Wizer-pre-initialized python.wasm ===");
  console.log();

  // Step 1: Compile pymode_wizer.c. Mode-dependent defines pick which
  // preimport set goes into the wizer snapshot.
  console.log(`  [1/6] Compiling pymode_wizer.c (mode=${BUILD_MODE})...`);
  fs.mkdirSync(path.join(BUILD_DIR, "Programs"), { recursive: true });
  const wizerCompileFlags = [
    "bash", ZIG_CC,
    "-c", "-Os", "-DPy_BUILD_CORE",
    `-I${IMPORTS_DIR}`,
    `-I${CPYTHON}/Include`,
    `-I${CPYTHON}/Include/internal`,
    `-I${BUILD_DIR}`,
  ];
  if (BUILD_MODE === "test") {
    wizerCompileFlags.push("-DPYMODE_HEAVY_PREIMPORTS=1");
  }
  if (BUILD_MODE === "app" && APP_PREIMPORTS_HEADER) {
    wizerCompileFlags.push("-DPYMODE_APP_PREIMPORTS=1");
    // The header sits next to pymode_wizer.c so #include "pymode_wizer_app_preimports.h" resolves.
    wizerCompileFlags.push(`-I${path.dirname(APP_PREIMPORTS_HEADER)}`);
  }
  if (BUILD_MODE === "variant" && VARIANT_NAME && process.env.PYMODE_VARIANT_PREIMPORT === "1") {
    // Optional variant pre-import. Disabled by default because pre-importing
    // numpy/pandas adds ~12 MB of snapshot state, pushing the wasm over CF
    // Workers' 10 MiB compressed bundle limit. The runtime cost of importing
    // these packages on first request is significant (multiple seconds), but
    // not so bad that the binary becomes unusable. When you've trimmed enough
    // elsewhere to make room, set PYMODE_VARIANT_PREIMPORT=1 to opt in.
    //
    // Dashes are normalised for Python module names: "pydantic-core" ->
    // "pydantic_core".
    const importName = VARIANT_NAME.replace(/-/g, "_");
    wizerCompileFlags.push(`-DPYMODE_VARIANT_PREIMPORT="${importName}"`);
  }
  wizerCompileFlags.push(
    path.join(WIZER_DIR, "pymode_wizer.c"),
    "-o",
    path.join(BUILD_DIR, "Programs", "pymode_wizer.o"),
  );
  run(wizerCompileFlags);

  // Step 2: Compile clean config.o (without variant module entries like numpy)
  console.log("  [2/6] Compiling clean config.o...");
  const configBase = path.join(BUILD_DIR, "Modules", "config.c.base");
  const configWizerC = path.join(BUILD_DIR, "Modules", "config_wizer.c");
  const configWizerO = path.join(BUILD_DIR, "Modules", "config_wizer.o");

  // Prefer variant config (has pydantic-core, numpy registered)
  const configVariantO = path.join(BUILD_DIR, "Modules", "config_variant.o");
  if (fs.existsSync(configVariantO)) {
    fs.copyFileSync(configVariantO, configWizerO);
    console.log("    Using variant config (pydantic-core + numpy)");
  } else if (fs.existsSync(configBase)) {
    fs.copyFileSync(configBase, configWizerC);
    run([
      "bash",
      ZIG_CC,
      "-c",
      "-Os",
      "-DPy_BUILD_CORE",
      `-I${CPYTHON}/Include`,
      `-I${CPYTHON}/Include/internal`,
      `-I${BUILD_DIR}`,
      "-o",
      configWizerO,
      configWizerC,
    ]);
    fs.unlinkSync(configWizerC);
  } else {
    fs.copyFileSync(
      path.join(BUILD_DIR, "Modules", "config.o"),
      configWizerO
    );
  }

  // Step 3: Collect all .o files, swapping python.o for pymode_wizer.o
  console.log("  [3/6] Collecting link objects...");
  const skipNames = new Set([
    "python.o",
    "config.o",
    "config_variant.o",
    "config_wizer.o",
    "dynload_shlib.o",
  ]);
  const linkObjs: string[] = [];

  // Modules/<recipe>/ subdirectories hold objects from custom recipe build
  // scripts (numpy, pandas, pillow, etc.). The customRecipeDirs loop below
  // picks up only the ones the current build wants; skip every such dir
  // here to avoid grabbing leftover objects from a previously built variant.
  const modulesDir = path.join(BUILD_DIR, "Modules");
  const customRecipeRoots = new Set<string>();
  if (fs.existsSync(modulesDir)) {
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Recipe dirs match recipes/<name>.json; CPython tree dirs (_io,
      // _decimal, _sqlite, …) don't have a corresponding recipe.
      const recipeJson = path.join(ROOT_DIR, "recipes", `${entry.name}.json`);
      if (fs.existsSync(recipeJson)) customRecipeRoots.add(entry.name);
    }
  }

  for (const filePath of walkDir(BUILD_DIR)) {
    const rel = filePath.slice(BUILD_DIR.length);
    if (rel.includes("/recipes/")) continue;
    const recipeRootMatch = rel.match(/^\/Modules\/([^/]+)\//);
    if (recipeRootMatch && customRecipeRoots.has(recipeRootMatch[1])) {
      continue;
    }
    // Skip in-tree native modules in slim deploys — they're for the test
    // runtime (xxhash, regex, msgpack, markupsafe speedups, _simd, …).
    if (BUILD_MODE !== "test") {
      const baseName = path.basename(filePath);
      if (baseName.endsWith(".o") && /^(_xxhash|xxhash__|_regex|_regex_unicode__|_cmsgpack|_speedups__markupsafe_speedups|_simd|_zerobuf)\b/.test(baseName)) {
        continue;
      }
    }
    const basename = path.basename(filePath);
    if (
      basename.endsWith(".o") &&
      !skipNames.has(basename) &&
      basename !== "pymode_wizer.o"
    ) {
      linkObjs.push(filePath);
    }
  }

  linkObjs.push(path.join(BUILD_DIR, "Programs", "pymode_wizer.o"));
  linkObjs.push(configWizerO);

  // Include recipe static archives:
  //   test mode    — include every built recipe (kitchen sink).
  //   variant mode — include only the recipes listed in
  //                  PYMODE_VARIANT_RECIPES.
  //   app mode     — include none (slim deploy).
  const skipRecipes = new Set(["regex", "msgpack", "xxhash", "markupsafe"]);
  const recipesDir = path.join(ROOT_DIR, "build", "recipes");
  const recipesToInclude: string[] =
    BUILD_MODE === "test" && fs.existsSync(recipesDir)
      ? fs.readdirSync(recipesDir).filter((r) => !skipRecipes.has(r))
      : BUILD_MODE === "variant"
      ? VARIANT_RECIPES
      : [];
  for (const recipe of recipesToInclude) {
    const objDir = path.join(recipesDir, recipe, "obj");
    if (!fs.existsSync(objDir)) {
      console.log(`    WARN: variant recipe ${recipe} has no built objects at ${objDir}`);
      continue;
    }
    for (const f of fs.readdirSync(objDir)) {
      if (f.endsWith(".a") || f.endsWith(".o")) {
        linkObjs.push(path.join(objDir, f));
        console.log(`    Including recipe: ${recipe}/${f}`);
      }
    }
  }

  // Custom-recipe objects live in BUILD_DIR/Modules/<recipe>/ (numpy and pandas
  // use this layout because their build scripts dump straight there). Pull
  // them in for either:
  //   - test mode  — include numpy by default (matches legacy behavior)
  //   - variant mode — include any recipe listed in PYMODE_VARIANT_RECIPES
  //                    that has a Modules/<name>/ directory
  const customRecipeDirs = new Set<string>();
  if (BUILD_MODE === "test") customRecipeDirs.add("numpy");
  if (BUILD_MODE === "variant") {
    for (const r of VARIANT_RECIPES) customRecipeDirs.add(r);
  }
  for (const name of customRecipeDirs) {
    const dir = path.join(BUILD_DIR, "Modules", name);
    if (!fs.existsSync(dir)) continue;
    const objs = fs.readdirSync(dir).filter((f) => f.endsWith(".o"));
    for (const f of objs) linkObjs.push(path.join(dir, f));
    if (objs.length > 0) console.log(`    Including ${name}: ${objs.length} objects`);
  }

  console.log(`    ${linkObjs.length} total link inputs`);

  // Step 4: Link. Mirror the side-module export logic from build-phase2.ts —
  // build-wizer.ts produces its own pre-snapshot binary via a fresh link
  // command, so flags applied to phase2's Makefile-driven link don't carry
  // over. We re-derive the export list from the bundled side modules so
  // the wizer binary (which becomes the runtime python.wasm) exposes the
  // libc / libpython symbols the dynamic linker will need.
  console.log("  [4/6] Linking...");
  const wizerRaw = path.join(BUILD_DIR, "python-wizer-raw.wasm");

  const extensionsDir = path.join(ROOT_DIR, "worker", "src", "extensions");
  const sideModuleWasms: string[] = [];
  if (fs.existsSync(extensionsDir)) {
    const collect = (d: string) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) collect(p);
        else if (f.endsWith(".wasm")) sideModuleWasms.push(p);
      }
    };
    collect(extensionsDir);
  }
  const exportFlagArgs: string[] = [];
  // Always export the basic wasm metadata symbols. The persistent-DO
  // path needs __stack_pointer to reset SP between requests, and it
  // calls pymode_warm_run as a bypass for wasi-libc's one-shot _start.
  // PyMem_RawMalloc/Free are also called from JS to pass the module
  // name into wasm memory.
  exportFlagArgs.push(
    "-Wl,--export-dynamic",
    "-Wl,--export-table",
    "-Wl,--export=__stack_pointer",
    "-Wl,--export=__heap_base",
    "-Wl,--export=__heap_end",
    "-Wl,--export=pymode_warm_run",
    "-Wl,--export=PyMem_RawMalloc",
    "-Wl,--export=PyMem_RawFree",
  );
  // Side-module dynamic-linker exports only matter for the test runtime —
  // deploys don't carry the .wasm side modules, so don't bloat the binary
  // with 550+ libc/libpython exports they'd reference.
  if (BUILD_MODE === "test" && sideModuleWasms.length > 0) {
    const extractScript = path.join(ROOT_DIR, "scripts", "extract-side-module-imports.mjs");
    const extractResult = run(["node", extractScript, ...sideModuleWasms], { captureOutput: true });
    if (extractResult.status !== 0) {
      console.error(`    WARN: extract-side-module-imports failed: ${extractResult.stderr}`);
    } else {
      const symbols = (extractResult.stdout || "")
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean);
      console.log(`    Side-module exports: ${symbols.length} symbols`);
      exportFlagArgs.push(
        // The dynamic linker needs `table.grow()` at runtime for side
        // modules, but zig's wasm-ld wrapper rejects `--growable-table`.
        // The post-wizer `wizer-restore-exports.mjs` step patches the
        // table to remove its max limit instead.
        ...symbols.map(s => `-Wl,--export=${s}`),
      );
    }
  }

  run([
    "bash",
    ZIG_CC,
    "-s",
    // --gc-sections drops unreachable functions/data sections from the
    // link. Pairs with -ffunction-sections / -fdata-sections in the
    // recipe builds; saves ~1-2 MB on numpy/pandas variants.
    "-Wl,--gc-sections",
    "-o",
    wizerRaw,
    ...linkObjs,
    ...exportFlagArgs,
    "-ldl",
    "-lwasi-emulated-signal",
    "-lwasi-emulated-getpid",
    "-lwasi-emulated-process-clocks",
    "-lm",
    "-lc++",
    "-lc++abi",
  ]);

  const rawSize = fs.statSync(wizerRaw).size;
  console.log(`    Raw: ${mb(rawSize)}`);

  // Verify wizer.initialize is exported
  if (which("wasm-objdump")) {
    const result = run(["wasm-objdump", "-x", wizerRaw], {
      captureOutput: true,
    });
    if (result.stdout.includes("wizer")) {
      console.log("    wizer.initialize export: OK");
    } else {
      console.log("    ERROR: wizer.initialize not found in exports!");
      process.exit(1);
    }
  }

  // Step 5: wasm-opt size-tuning (matches edgesharp/capnwasm flag set).
  if (which("wasm-opt")) {
    console.log("  [5/6] Optimize with wasm-opt -Oz --converge...");
    const optOutput = wizerRaw + ".opt";
    run([
      "wasm-opt",
      "-Oz",
      "--converge",
      "--strip-debug",
      "--strip-producers",
      "--strip-target-features",
      "--enable-simd",
      "--enable-relaxed-simd",
      "--enable-nontrapping-float-to-int",
      "--enable-bulk-memory",
      "--enable-bulk-memory-opt",
      "--enable-sign-ext",
      "--enable-mutable-globals",
      "--enable-multivalue",
      "--enable-tail-call",
      "--enable-reference-types",
      "--enable-extended-const",
      wizerRaw,
      "-o",
      optOutput,
    ]);
    fs.renameSync(optOutput, wizerRaw);
    const optSize = fs.statSync(wizerRaw).size;
    console.log(`    Optimized: ${mb(optSize)}`);
  } else {
    console.log("  [5/6] SKIP: wasm-opt not found");
  }

  // Step 6: Run Wizer to snapshot CPython init
  console.log(
    "  [6/6] Wizer snapshot (booting CPython + pre-importing stdlib + packages)..."
  );

  const stdlibDir = path.join(CPYTHON, "Lib");
  const wizerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "wizer-"));

  // Build a merged stdlib dir: cpython/Lib + polyfills (polyfills override)
  const mergedStdlib = path.join(wizerTmp, "stdlib");
  fs.mkdirSync(mergedStdlib, { recursive: true });

  // Copy stdlib data from generate-stdlib-fs output (includes polyfills + patches)
  const stdlibDat = path.join(ROOT_DIR, "worker", "src", "stdlib-data.dat");
  if (fs.existsSync(stdlibDat)) {
    const data = JSON.parse(fs.readFileSync(stdlibDat, "utf-8"));
    for (const [relPath, content] of Object.entries(data)) {
      const fullPath = path.join(mergedStdlib, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content as string);
    }
    console.log(`    Merged stdlib: ${Object.keys(data).length} files`);
  }

  // Extract site-packages.zip for wizer to access
  const sitePackagesZip = path.join(ROOT_DIR, "worker", "src", "site-packages.zip");
  const sitePackagesDir = path.join(wizerTmp, "site-packages");
  if (fs.existsSync(sitePackagesZip)) {
    fs.mkdirSync(sitePackagesDir, { recursive: true });
    const unzipResult = spawnSync("python3", [
      "-c",
      `import zipfile, sys; z=zipfile.ZipFile("${sitePackagesZip}"); z.extractall("${sitePackagesDir}")`,
    ], { stdio: "pipe" });
    if (unzipResult.status === 0) {
      const count = spawnSync("find", [sitePackagesDir, "-name", "*.py"], { encoding: "utf-8", stdio: "pipe" });
      const fileCount = (count.stdout || "").split("\n").filter(Boolean).length;
      console.log(`    Site-packages: ${fileCount} Python files`);
    }
  }

  // Extension site-packages
  const extZip = path.join(ROOT_DIR, "worker", "src", "extension-site-packages.zip");
  const extDir = path.join(wizerTmp, "ext-site-packages");
  if (fs.existsSync(extZip) && fs.statSync(extZip).size > 22) {
    fs.mkdirSync(extDir, { recursive: true });
    spawnSync("python3", [
      "-c",
      `import zipfile; z=zipfile.ZipFile("${extZip}"); z.extractall("${extDir}")`,
    ], { stdio: "pipe" });
  }

  // App project source (for --mode=app builds). We copy the user's .py
  // files into mergedStdlib/app/ so they sit at /stdlib/app/ inside the
  // wasm — matching the runtime VFS layout user-files.ts produces. The
  // wizer init imports the entry module from here so its top-level code
  // (e.g. `_md = MarkdownIt()`, `_tmpl = Template(...)`) executes ONCE
  // at build time and the resulting objects live in the snapshot.
  if (BUILD_MODE === "app" && APP_PROJECT_DIR && fs.existsSync(APP_PROJECT_DIR)) {
    const appDest = path.join(mergedStdlib, "app");
    fs.mkdirSync(appDest, { recursive: true });
    const copyTree = (src: string, dst: string) => {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__pycache__" || entry.name === ".venv" ||
              entry.name === ".pymode" || entry.name === "node_modules") continue;
          fs.mkdirSync(d, { recursive: true });
          copyTree(s, d);
          continue;
        }
        if (entry.name.endsWith(".py")) {
          fs.copyFileSync(s, d);
        }
      }
    };
    copyTree(APP_PROJECT_DIR, appDest);
    const pyCount = spawnSync("find", [appDest, "-name", "*.py"], { encoding: "utf-8", stdio: "pipe" });
    console.log(`    App source: ${(pyCount.stdout || "").split("\n").filter(Boolean).length} .py files (entry=${APP_ENTRY_MODULE})`);
  }

  try {
    // Set PYTHONPATH so wizer init can find all packages
    const wizerEnv = { ...process.env };
    const pythonPaths = [mergedStdlib];
    if (fs.existsSync(sitePackagesDir)) pythonPaths.push(sitePackagesDir);
    if (fs.existsSync(extDir)) pythonPaths.push(extDir);
    wizerEnv.PYTHONPATH = pythonPaths.join(":");

    const result = run(
      [
        "wizer",
        wizerRaw,
        "-o",
        OUTPUT,
        "--allow-wasi",
        "--wasm-bulk-memory",
        "true",
        "--wasm-simd",
        "true",
        // Mount site-packages contents at /wizer-sp (NOT /stdlib/site-packages.zip)
        // so wasi-libc's preopen table doesn't bake a directory entry at the
        // path where the runtime mounts the zip bytes as a file. Without this,
        // the snapshot's frozen preopen makes runtime os.stat return S_IFDIR
        // for the file mount, breaking zipimport. /wizer-ext-sp likewise.
        `--mapdir=/stdlib::${mergedStdlib}`,
        `--mapdir=/wizer-sp::${sitePackagesDir}`,
        ...(fs.existsSync(extDir) ? [`--mapdir=/wizer-ext-sp::${extDir}`] : []),
        `--mapdir=/tmp::${wizerTmp}`,
        `--mapdir=/data::${wizerTmp}`,
      ],
      { captureOutput: true }
    );

    if (result.status === 0) {
      // Wizer strips all exports except _start/memory. Re-attach every
      // export from the pre-wizer binary, remapping function indices for
      // the imports Wizer dropped. The dynamic linker depends on these.
      const restoreScript = path.join(ROOT_DIR, "scripts", "wizer-restore-exports.mjs");
      if (fs.existsSync(restoreScript)) {
        const restored = OUTPUT + ".restored";
        const restoreResult = run(
          ["node", restoreScript, wizerRaw, OUTPUT, restored],
          { captureOutput: true },
        );
        if (restoreResult.status === 0 && fs.existsSync(restored)) {
          fs.renameSync(restored, OUTPUT);
          console.log(`    Restored exports stripped by Wizer`);
        } else {
          console.log(`    WARN: export-restore failed: ${restoreResult.stderr}`);
        }
      }
      const preOptSize = fs.statSync(OUTPUT).size;
      console.log(`    Snapshot: ${mb(preOptSize)}`);

      // Note: a post-wizer wasm-opt pass would shave ~5% off the binary
      // by deduping the wizer-inflated data segment, but it strips the
      // restored exports (including __stack_pointer) which the
      // persistent-DO path needs to reset stack state between requests.
      // The 5% size win isn't worth losing the warm-latency win, so we
      // skip post-wizer optimization. wizer-restore-exports has already
      // re-attached all pre-wizer exports above.
    } else {
      console.log();
      console.log("    Wizer snapshot failed.");
      console.log(result.stderr);
      console.log(
        "    The binary still works without wizer (falls back to full init)."
      );
      if (fs.existsSync(wizerRaw)) {
        fs.unlinkSync(wizerRaw);
      }
      fs.rmSync(wizerTmp, { recursive: true, force: true });
      process.exit(1);
    }
  } finally {
    fs.rmSync(wizerTmp, { recursive: true, force: true });
  }

  // Cleanup intermediate
  if (fs.existsSync(wizerRaw)) {
    fs.unlinkSync(wizerRaw);
  }

  // Replace python.wasm -- the wizer binary IS the default now.
  const workerWasm = path.join(ROOT_DIR, "worker", "src", WORKER_WASM_FILENAME);
  fs.copyFileSync(OUTPUT, workerWasm);
  // Mirror to the .dat sidecar (the dynamic linker reads raw bytes from
  // a Data binding while WebAssembly.Module compiles the same file).
  // Only the test runtime ships the .dat for python.wasm.

  console.log();
  console.log("Done! python.wasm (wizer snapshot)");
  console.log(`  Size: ${mb(fs.statSync(OUTPUT).size)}`);
  console.log();
  console.log("Cold start: ~5ms (vs ~28ms without snapshot)");
}

main();
