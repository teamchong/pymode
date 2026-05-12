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

// Asyncify removed — fan-out replay handles async imports at runtime.

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

/**
 * Build a variant by delegating to build-wizer.ts in variant mode.
 * Produces a wizer-warmed python-<variant>.wasm that boots fast on CF
 * (the legacy no-wizer link path skipped this and ended up over the
 * cold-start budget).
 */
function buildVariantViaWizer(recipeNames: string[]): void {
  const variantName = recipeNames.join("-");

  // Resolve transitive depends. A recipe like pandas declares `depends:
  // ["numpy"]` — the variant name stays "pandas" (so the deploy looks for
  // python-pandas.wasm) but the link must pull numpy's objects too.
  const allRecipes: string[] = [];
  const visited = new Set<string>();
  function addRecipe(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const recipePath = path.join(ROOT_DIR, "recipes", `${name}.json`);
    if (!fs.existsSync(recipePath)) {
      console.log(`  ERROR: recipe ${name}.json not found`);
      process.exit(1);
    }
    const recipe = JSON.parse(fs.readFileSync(recipePath, "utf-8"));
    for (const dep of recipe.depends ?? []) addRecipe(dep);
    allRecipes.push(name);
  }
  for (const r of recipeNames) addRecipe(r);

  console.log(`Building variant via wizer: python-${variantName}.wasm`);
  console.log(`  Primary: ${recipeNames.join(" ")}`);
  if (allRecipes.length !== recipeNames.length) {
    const extra = allRecipes.filter((r) => !recipeNames.includes(r));
    console.log(`  Depends: ${extra.join(" ")}`);
  }
  console.log();

  // Custom-recipe build scripts (numpy, pandas) stash objects under
  // BUILD_DIR/Modules/<name>/; other recipes use build/recipes/<name>/obj/.
  // Trigger a rebuild for any recipe that has neither.
  for (const r of allRecipes) {
    const objDirA = path.join(ROOT_DIR, "build", "recipes", r, "obj");
    const objDirB = path.join(BUILD_DIR, "Modules", r);
    const hasObjs =
      (fs.existsSync(objDirA) && fs.readdirSync(objDirA).some((f) => f.endsWith(".o"))) ||
      (fs.existsSync(objDirB) && fs.readdirSync(objDirB).some((f) => f.endsWith(".o")));
    if (!hasObjs) {
      console.log(`  Recipe ${r} not built — invoking build-recipe.ts...`);
      const res = spawnSync("npx", ["tsx", path.join(SCRIPT_DIR, "build-recipe.ts"), r], {
        stdio: "inherit",
        cwd: ROOT_DIR,
      });
      if (res.status !== 0) {
        console.log(`  ERROR: build-recipe.ts ${r} failed`);
        process.exit(1);
      }
    }
  }

  // Generate config_variant.c so each recipe's PyInit_<module> is in
  // the CPython inittab. Without this, every variant build inherits
  // the prior variant's module list — leading to "undefined symbol:
  // PyInit_<previous-recipe-module>" at link time. Walk transitive
  // depends so pandas pulls in numpy's PyInit__multiarray_umath too.
  const allModules: Array<[string, string]> = [];
  for (const r of allRecipes) {
    const recipeFile = path.join(ROOT_DIR, "recipes", `${r}.json`);
    if (!fs.existsSync(recipeFile)) {
      console.log(`  ERROR: recipe ${r}.json not found`);
      process.exit(1);
    }
    const recipe = JSON.parse(fs.readFileSync(recipeFile, "utf-8"));
    const modules = (recipe.modules ?? {}) as Record<string, string>;
    for (const [modPath, initFunc] of Object.entries(modules)) {
      allModules.push([modPath, initFunc]);
    }
  }

  const configVariantC = path.join(BUILD_DIR, "Modules", "config_variant.c");
  const configBase = path.join(BUILD_DIR, "Modules", "config.c.base");
  const configFallback = path.join(BUILD_DIR, "Modules", "config.c");
  fs.copyFileSync(fs.existsSync(configBase) ? configBase : configFallback, configVariantC);

  let externDecls = "";
  let inittabEntries = "";
  for (const [modPath, initFunc] of allModules) {
    externDecls += `extern PyObject* ${initFunc}(void);\n`;
    inittabEntries += `    {"${modPath}", ${initFunc}},\n`;
  }
  let configContent = fs.readFileSync(configVariantC, "utf-8");
  if (!configContent.includes("PyInit__pymode")) {
    externDecls = "extern PyObject* PyInit__pymode(void);\n" + externDecls;
    inittabEntries = '    {"_pymode", PyInit__pymode},\n' + inittabEntries;
  }
  configContent = configContent
    .replace("/* -- ADDMODULE MARKER 1 -- */", externDecls + "/* -- ADDMODULE MARKER 1 -- */")
    .replace("/* -- ADDMODULE MARKER 2 -- */", inittabEntries + "/* -- ADDMODULE MARKER 2 -- */");
  fs.writeFileSync(configVariantC, configContent);

  // Compile config_variant.c -> config_variant.o (build-wizer.ts copies
  // it into its link inputs).
  const compileRes = spawnSync(
    "bash",
    [ZIG_CC, "-c", "-Os", "-DPy_BUILD_CORE",
     `-I${CPYTHON}/Include`,
     `-I${CPYTHON}/Include/internal`,
     `-I${BUILD_DIR}`,
     "-o", path.join(BUILD_DIR, "Modules", "config_variant.o"),
     configVariantC],
    { stdio: "inherit" },
  );
  if (compileRes.status !== 0) {
    console.log("  ERROR: config_variant.c compile failed");
    process.exit(1);
  }
  console.log(`  Generated config_variant.c with ${allModules.length} module(s): ${allModules.map(([m]) => m).join(", ")}`);

  // Merge every dependent recipe's *-site-packages.zip into
  // extension-site-packages.zip so build-wizer.ts mounts the union at
  // /wizer-ext-sp during wizer init. Without this the variant's Python
  // files (pandas/, numpy/, pytz/, dateutil/) aren't all visible, and
  // the _preimport call in pymode_wizer.c fails silently (e.g. pandas
  // top-level imports numpy — both zips need to be on the path).
  const registryPath = path.join(ROOT_DIR, "lib", "variants.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  const extSitePackagesDst = path.join(ROOT_DIR, "worker", "src", "extension-site-packages.zip");
  const zipsToMerge: string[] = [];
  for (const r of allRecipes) {
    const candidates = [
      path.join(ROOT_DIR, "build", "recipes", r, `${r}-site-packages.zip`),
      path.join(ROOT_DIR, "worker", "src", `${r}-site-packages.zip`),
      path.join(ROOT_DIR, "worker", "src", "extensions", r, `${r}-site-packages.zip`),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (src) zipsToMerge.push(src);
  }
  if (zipsToMerge.length > 0) {
    // Concatenate every recipe's zip entries into one ZIP_STORED archive.
    // Use the same mtime epoch as build-pandas-wasm.sh to keep entries
    // valid for the ZipInfo constraint (pre-1980 dates throw).
    const allEntries: Record<string, Uint8Array> = {};
    let totalBytes = 0;
    for (const z of zipsToMerge) {
      const buf = fs.readFileSync(z);
      const entries: Unzipped = unzipSync(new Uint8Array(buf));
      for (const [name, data] of Object.entries(entries)) {
        // Last writer wins on collision — but if numpy and pandas both
        // shipped a sibling __init__.py, that's a real conflict and
        // we'd rather know via test failures.
        allEntries[name] = data;
        totalBytes += data.length;
      }
    }
    const merged = zipSync(allEntries, { level: 0 });
    fs.writeFileSync(extSitePackagesDst, merged);
    // Also overwrite worker/src/<variantName>-site-packages.zip so
    // deploy.js (which copies <variant.sitePackages> -> ext zip) picks
    // up the merged version. Without this, depending on the deploy
    // order, deploy.js could replace the merged zip with a single-recipe
    // zip — and numpy code would disappear at runtime.
    const variantSpName = registry.variants[variantName]?.sitePackages;
    if (variantSpName) {
      fs.writeFileSync(
        path.join(ROOT_DIR, "worker", "src", variantSpName),
        merged,
      );
    }
    console.log(`  Staged ${zipsToMerge.length} site-packages zip(s) (${Object.keys(allEntries).length} entries, ${Math.round(totalBytes/1024)} KB raw)`);
  }

  // Hand off to build-wizer.ts in variant mode. It will compile
  // pymode_wizer.c with -DPYMODE_VARIANT_PREIMPORT, link all .o files
  // + the variant recipe objects, run wizer, and write the result to
  // worker/src/python-<variant>.wasm.
  const env = {
    ...process.env,
    PYMODE_BUILD_MODE: "variant",
    PYMODE_VARIANT_NAME: variantName,
    PYMODE_VARIANT_RECIPES: allRecipes.join(","),
  };
  const res = spawnSync("npx", ["tsx", path.join(SCRIPT_DIR, "build-wizer.ts")], {
    stdio: "inherit",
    cwd: ROOT_DIR,
    env,
  });
  if (res.status !== 0) {
    console.log("  ERROR: build-wizer.ts failed");
    process.exit(1);
  }
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: build-variant.ts <recipe-name> [<recipe-name>...] [--no-wizer]");
    console.log();
    console.log("Available recipes:");
    for (const r of globFiles(RECIPES_DIR, "*.json").sort()) {
      const name = path.basename(r).replace(".json", "");
      const recipe = JSON.parse(fs.readFileSync(r, "utf-8"));
      console.log(`  ${name} (${recipe.version})`);
    }
    process.exit(0);
  }

  // --no-wizer skips the wizer warm-up pass. By default we delegate the
  // final link + wizer step to build-wizer.ts so the variant wasm has
  // wizer.initialize and starts within CF's cold-start budget.
  const skipWizer = args.includes("--no-wizer");
  const recipeArgs = args.filter((a) => !a.startsWith("--"));

  if (!skipWizer) {
    return buildVariantViaWizer(recipeArgs);
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

  // Step 5: Optimize with wasm-opt (fan-out replay replaces asyncify)
  const wasmOptPath = spawnSync("which", ["wasm-opt"], { encoding: "utf-8" });
  if (wasmOptPath.status === 0) {
    console.log("  Running wasm-opt -O1...");
    const optOutput = output + ".opt";
    const optRes = run([
      "wasm-opt",
      "-O1",
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
      output,
      "-o",
      optOutput,
    ]);
    if (optRes.status !== 0) process.exit(1);
    fs.renameSync(optOutput, output);
    const postSize = fs.statSync(output).size;
    console.log(`  Optimized: ${(postSize / 1048576).toFixed(1)}MB`);
  } else {
    console.log("  WARNING: wasm-opt not found, skipping optimization");
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
