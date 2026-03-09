#!/usr/bin/env npx tsx
/**
 * Build a python.wasm variant by linking base CPython + recipe objects.
 *
 * Usage:
 *     npx tsx scripts/build-variant.ts <recipe-name> [<recipe-name>...]
 *
 * Example:
 *     npx tsx scripts/build-variant.ts numpy                    # python-numpy.wasm
 *     npx tsx scripts/build-variant.ts markupsafe frozenlist     # python-markupsafe-frozenlist.wasm
 *
 * Produces: worker/src/python-<variant>.wasm
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { unzipSync, zipSync, type Unzipped } from "fflate";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const CPYTHON = path.join(ROOT_DIR, "cpython");
const BUILD_DIR = path.join(ROOT_DIR, "build", "zig-wasi");
const RECIPES_DIR = path.join(ROOT_DIR, "recipes");
const ZIG_CC = path.join(ROOT_DIR, "build", "zig-wrappers", "zig-cc");

const ASYNC_IMPORTS =
  "pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put," +
  "pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec," +
  "pymode.thread_spawn,pymode.thread_join,pymode.dl_open";

function globFiles(dir: string, pattern: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => {
      if (pattern === "*.o") return f.endsWith(".o");
      if (pattern === "*.a") return f.endsWith(".a");
      if (pattern === "*.json") return f.endsWith(".json");
      return false;
    })
    .map((f) => path.join(dir, f));
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
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

function run(cmd: string[], opts?: { captureOutput?: boolean }): {
  status: number;
  stderr: string;
} {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: opts?.captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: opts?.captureOutput ? "utf-8" : undefined,
  });
  return {
    status: result.status ?? 1,
    stderr: opts?.captureOutput ? (result.stderr as string) ?? "" : "",
  };
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: build-variant.ts <recipe-name> [<recipe-name>...]");
    console.log();
    console.log("Available recipes:");
    for (const r of globFiles(RECIPES_DIR, "*.json").sort()) {
      const name = path.basename(r).replace(".json", "");
      const recipe = JSON.parse(fs.readFileSync(r, "utf-8"));
      console.log(`  ${name} (${recipe.version})`);
    }
    process.exit(0);
  }

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

  const recipeNames = args;
  const variantName = recipeNames.join("-");
  const output = path.join(ROOT_DIR, "worker", "src", `python-${variantName}.wasm`);

  console.log(`Building variant: python-${variantName}.wasm`);
  console.log(`  Recipes: ${recipeNames.join(" ")}`);
  console.log();

  // Step 1: Build each recipe (compile objects)
  const allObjs: string[] = [];
  const allModules: Array<[string, string]> = []; // [mod_path, init_func]
  const extraLinkFlags: string[] = [];
  const sitePackages: string[] = [];

  for (const recipeName of recipeNames) {
    const recipePath = path.join(RECIPES_DIR, `${recipeName}.json`);
    if (!fs.existsSync(recipePath)) {
      console.log(`Recipe not found: ${recipeName}`);
      process.exit(1);
    }

    const recipe = JSON.parse(fs.readFileSync(recipePath, "utf-8"));
    const rtype: string = recipe.type;

    if (rtype === "custom") {
      console.log(`  [${recipeName}] Custom build -- checking for pre-built objects...`);
      const objDir = path.join(BUILD_DIR, "Modules", "numpy");
      const objs = globFiles(objDir, "*.o");
      if (objs.length > 0) {
        allObjs.push(...objs);
        console.log(`    Found ${objs.length} objects`);
      } else {
        console.log(`    No pre-built objects. Run build-recipe.ts ${recipeName} first.`);
        process.exit(1);
      }
    } else if (rtype === "rust") {
      const objDir = path.join(ROOT_DIR, "build", "recipes", recipeName, "obj");
      if (!fs.existsSync(objDir) || !fs.statSync(objDir).isDirectory()) {
        console.log(`  [${recipeName}] Building Rust extension...`);
        const buildScript: string = recipe.build_script;
        const res = run(["bash", path.join(ROOT_DIR, buildScript)]);
        if (res.status !== 0) process.exit(1);
      }
      for (const archive of globFiles(objDir, "*.a")) {
        allObjs.push(archive);
      }
      for (const obj of globFiles(objDir, "*.o")) {
        allObjs.push(obj);
      }
      const archives = globFiles(objDir, "*.a");
      if (archives.length > 0) {
        const size = fs.statSync(archives[0]).size;
        console.log(`  [${recipeName}] Rust archive: ${Math.floor(size / 1024)}KB`);
      }
    } else {
      const objDir = path.join(ROOT_DIR, "build", "recipes", recipeName, "obj");
      let objs = globFiles(objDir, "*.o");
      if (objs.length === 0) {
        console.log(`  [${recipeName}] Compiling...`);
        const res = run([
          "npx", "tsx",
          path.join(SCRIPT_DIR, "build-recipe.ts"),
          recipeName,
          "--objects-only",
        ]);
        if (res.status !== 0) process.exit(1);
        objs = globFiles(objDir, "*.o");
      }
      allObjs.push(...objs);
      console.log(`  [${recipeName}] ${objs.length} objects`);
    }

    // Collect module registrations
    const modules: Record<string, string> = recipe.modules ?? {};
    for (const [modPath, initFunc] of Object.entries(modules)) {
      allModules.push([modPath, initFunc]);
    }

    // Collect extra link flags
    if (Array.isArray(recipe.extra_link_flags)) {
      extraLinkFlags.push(...recipe.extra_link_flags);
    }

    // Collect site-packages zips
    const siteZip = path.join(
      ROOT_DIR,
      "build",
      "recipes",
      recipeName,
      `${recipeName}-site-packages.zip`
    );
    if (fs.existsSync(siteZip)) {
      sitePackages.push(siteZip);
    }
  }

  // Step 2: Generate config.c with module registrations
  console.log();
  console.log("  Generating config.c...");

  const configVariant = path.join(BUILD_DIR, "Modules", "config_variant.c");
  const configBase = path.join(BUILD_DIR, "Modules", "config.c.base");
  const configFallback = path.join(BUILD_DIR, "Modules", "config.c");

  if (fs.existsSync(configBase)) {
    fs.copyFileSync(configBase, configVariant);
  } else {
    fs.copyFileSync(configFallback, configVariant);
  }

  // Build extern declarations and inittab entries
  let externDecls = "";
  let inittabEntries = "";
  for (const [modPath, initFunc] of allModules) {
    externDecls += `extern PyObject* ${initFunc}(void);\n`;
    inittabEntries += `    {"${modPath}", ${initFunc}},\n`;
  }

  // Also add _pymode if not already there
  let configContent = fs.readFileSync(configVariant, "utf-8");

  if (!configContent.includes("PyInit__pymode")) {
    externDecls = "extern PyObject* PyInit__pymode(void);\n" + externDecls;
    inittabEntries = '    {"_pymode", PyInit__pymode},\n' + inittabEntries;
  }

  // Insert before markers
  configContent = configContent.replace(
    "/* -- ADDMODULE MARKER 1 -- */",
    externDecls + "/* -- ADDMODULE MARKER 1 -- */"
  );
  configContent = configContent.replace(
    "/* -- ADDMODULE MARKER 2 -- */",
    inittabEntries + "/* -- ADDMODULE MARKER 2 -- */"
  );

  fs.writeFileSync(configVariant, configContent);

  // Compile config_variant.c
  console.log("  Compiling config_variant.c...");
  const compileRes = run([
    "bash",
    ZIG_CC,
    "-c",
    "-Os",
    "-DPy_BUILD_CORE",
    `-I${CPYTHON}/Include`,
    `-I${CPYTHON}/Include/internal`,
    `-I${BUILD_DIR}`,
    "-o",
    path.join(BUILD_DIR, "Modules", "config_variant.o"),
    configVariant,
  ]);
  if (compileRes.status !== 0) process.exit(1);

  // Step 3: Collect all base .o files (excluding config.o and dynload_shlib.o)
  console.log("  Collecting link objects...");
  const linkObjs: string[] = [];
  const skipNames = new Set(["config.o", "dynload_shlib.o", "config_variant.o", "config_wizer.o", "pymode_wizer.o"]);

  for (const filePath of walkDir(BUILD_DIR)) {
    // Skip recipe and numpy directories
    if (filePath.includes("/recipes/") || filePath.includes("/Modules/numpy/")) {
      continue;
    }
    const basename = path.basename(filePath);
    if (basename.endsWith(".o") && !skipNames.has(basename)) {
      linkObjs.push(filePath);
    }
  }

  // Add our variant config
  linkObjs.push(path.join(BUILD_DIR, "Modules", "config_variant.o"));

  // Add recipe objects
  linkObjs.push(...allObjs);

  console.log(`  Total objects: ${linkObjs.length}`);

  // Step 4: Link
  console.log(`  Linking python-${variantName}.wasm...`);
  const linkCmd = [
    "bash",
    ZIG_CC,
    "-s",
    "-o",
    output,
    ...linkObjs,
    "-ldl",
    "-lwasi-emulated-signal",
    "-lwasi-emulated-getpid",
    "-lwasi-emulated-process-clocks",
    "-lm",
    ...extraLinkFlags,
  ];

  const linkResult = run(linkCmd, { captureOutput: true });
  if (linkResult.status !== 0) {
    console.log();
    console.log("  ERROR: Link failed!");
    console.log(linkResult.stderr);
    process.exit(1);
  }

  const preSize = fs.statSync(output).size;
  console.log(`  Raw size: ${(preSize / 1048576).toFixed(1)}MB`);

  // Step 5: Asyncify with wasm-opt
  const wasmOptPath = spawnSync("which", ["wasm-opt"], { encoding: "utf-8" });
  if (wasmOptPath.status === 0) {
    console.log("  Running wasm-opt --asyncify...");
    const optOutput = output + ".opt";
    const optRes = run([
      "wasm-opt",
      "-O2",
      "--asyncify",
      "--enable-simd",
      "--enable-nontrapping-float-to-int",
      "--enable-bulk-memory",
      "--enable-sign-ext",
      "--enable-mutable-globals",
      `--pass-arg=asyncify-imports@${ASYNC_IMPORTS}`,
      "--pass-arg=asyncify-ignore-indirect",
      output,
      "-o",
      optOutput,
    ]);
    if (optRes.status !== 0) process.exit(1);
    fs.renameSync(optOutput, output);
    const postSize = fs.statSync(output).size;
    console.log(`  Asyncified: ${(postSize / 1048576).toFixed(1)}MB`);
  } else {
    console.log("  WARNING: wasm-opt not found, skipping asyncify");
  }

  // Step 6: Merge site-packages
  if (sitePackages.length > 0) {
    console.log("  Merging site-packages...");
    const mergedZip = path.join(ROOT_DIR, "worker", "src", "extension-site-packages.zip");
    const seen = new Set<string>();
    const merged: Unzipped = {};

    for (const zipPath of sitePackages) {
      if (!fs.existsSync(zipPath)) continue;
      const zipData = fs.readFileSync(zipPath);
      const entries = unzipSync(new Uint8Array(zipData));
      for (const [name, data] of Object.entries(entries)) {
        if (!seen.has(name)) {
          seen.add(name);
          merged[name] = data;
        }
      }
    }

    // Write with ZIP_STORED (level 0)
    const levelOpts: Record<string, { level: 0 }> = {};
    for (const name of Object.keys(merged)) {
      levelOpts[name] = { level: 0 };
    }
    const zipped = zipSync(merged, levelOpts as any);
    fs.writeFileSync(mergedZip, zipped);
    console.log(`  ${seen.size} files in extension-site-packages.zip`);
  }

  console.log();
  console.log(`Done! python-${variantName}.wasm -> worker/src/`);
  console.log(`  Size: ${(fs.statSync(output).size / 1048576).toFixed(1)}MB`);
}

main();
