// pymode deploy — bundle project + deploy to Cloudflare Workers
//
// Chains: install deps → build wizer snapshot → bundle-project.sh → wrangler deploy

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync, copyFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseDeps, resolveVariant, applyVariant, checkPackage } from "../lib/variants.js";

function findRepoRoot() {
  const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
  // In repo: cli/ is inside the repo
  const repoRoot = dirname(cliDir);
  if (existsSync(join(repoRoot, "worker", "src", "worker.ts"))) {
    return repoRoot;
  }
  // As npm package: look for node_modules/pymode
  return null;
}

function findEntryPoint(projectDir) {
  const pyproject = join(projectDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const content = readFileSync(pyproject, "utf-8");
    const match = content.match(/main\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  for (const candidate of ["src/entry.py", "entry.py", "app.py", "main.py"]) {
    if (existsSync(join(projectDir, candidate))) return candidate;
  }
  return null;
}

function isWizerEnabled(projectDir, args) {
  // Check CLI flag
  if (args.includes("--wizer")) return true;
  if (args.includes("--no-wizer")) return false;

  // Check pyproject.toml
  const pyproject = join(projectDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const content = readFileSync(pyproject, "utf-8");
    const match = content.match(/wizer\s*=\s*(true|false)/i);
    if (match) return match[1].toLowerCase() === "true";
  }

  return false;
}

function buildWizerSnapshot(repoRoot) {
  // Check if wizer is available
  const wizerCheck = spawnSync("which", ["wizer"], { stdio: "pipe" });
  if (wizerCheck.status !== 0) {
    console.log("  wizer not found. Install with: cargo install wizer --all-features");
    console.log("  Deploying without snapshot (slower cold starts).\n");
    return false;
  }

  const wizerScript = join(repoRoot, "scripts", "build-wizer.sh");
  if (!existsSync(wizerScript)) {
    console.log("  build-wizer.sh not found, skipping snapshot.\n");
    return false;
  }

  console.log("  Building Wizer snapshot for fast cold starts...\n");
  const result = spawnSync("bash", [wizerScript], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.log("\n  Wizer build failed, continuing without snapshot.\n");
    return false;
  }

  return true;
}

function installDeps(projectDir) {
  const pyproject = join(projectDir, "pyproject.toml");
  if (!existsSync(pyproject)) return;

  const content = readFileSync(pyproject, "utf-8");
  const match = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return;

  const deps = match[1]
    .split("\n")
    .map(l => l.trim().replace(/,$/, "").replace(/^["']|["']$/g, ""))
    .filter(l => l && !l.startsWith("#"));

  if (deps.length === 0) return;

  // Filter out C extension packages — they're provided by the WASM variant
  const pureDeps = deps.filter(dep => {
    const info = checkPackage(dep);
    return !info; // null = pure Python
  });

  if (pureDeps.length === 0) {
    console.log("  No pure-Python packages to download.");
    return;
  }

  console.log(`  Installing ${pureDeps.length} pure-Python package(s) via uv...`);

  // Prefer uv pip install --target — produces an unpacked package tree
  // (jinja2/, markdown_it/, …) ready to be zipped. uv handles transitive
  // pure-Python deps automatically (markupsafe for jinja2, mdurl for
  // markdown-it-py, etc.). Falls back to pip download if uv isn't
  // installed.
  const hasUv = spawnSync("which", ["uv"], { stdio: "pipe" }).status === 0;
  const destDir = join(projectDir, ".pymode", "packages");
  // Clean slate — old packages may shadow new versions when re-deploying.
  if (existsSync(destDir)) {
    spawnSync("rm", ["-rf", destDir], { stdio: "pipe" });
  }
  mkdirSync(destDir, { recursive: true });

  let result;
  if (hasUv) {
    result = spawnSync("uv", ["pip", "install",
      "--target", destDir,
      "--python-version", "3.13",
      "--only-binary", ":all:",
      ...pureDeps,
    ], { stdio: "inherit", cwd: projectDir });
  } else {
    console.log("  (install uv for ~10× faster deploys: https://docs.astral.sh/uv/)");
    result = spawnSync("python3", ["-m", "pip", "install",
      "--target", destDir,
      "--no-deps",
      "--only-binary", ":all:",
      "--python-version", "3.13",
      "--platform", "any",
      ...pureDeps,
    ], { stdio: "inherit", cwd: projectDir });
  }

  if (result.status !== 0) {
    console.log("  Warning: some packages failed to install.\n");
  }
}

function bundleProject(projectDir, repoRoot) {
  const bundleScript = join(repoRoot, "scripts", "bundle-project.sh");
  if (!existsSync(bundleScript)) {
    throw new Error("bundle-project.sh not found. Are you in the pymode repo?");
  }

  console.log("  Bundling project files...");
  const result = spawnSync("bash", [bundleScript, projectDir], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Failed to bundle project files");
  }
}

function ensureWorkerDeps(repoRoot) {
  const workerDir = join(repoRoot, "worker");
  if (!existsSync(join(workerDir, "node_modules"))) {
    console.log("  Installing worker dependencies...");
    spawnSync("npm", ["install"], { cwd: workerDir, stdio: "inherit" });
  }
}

/**
 * Build the Astro docs site so its static files are ready for the
 * worker's [assets] binding to serve. Skipped when the docs/ directory
 * isn't present (e.g. when running pymode from an npm package install
 * without the repo).
 */
function buildDocs(repoRoot) {
  const docsDir = join(repoRoot, "docs");
  if (!existsSync(docsDir) || !existsSync(join(docsDir, "package.json"))) {
    return;
  }
  console.log("\n  Building Astro docs...");
  if (!existsSync(join(docsDir, "node_modules"))) {
    console.log("  Installing docs dependencies...");
    spawnSync("npm", ["install"], { cwd: docsDir, stdio: "inherit" });
  }
  // ASTRO_DEPLOY_TARGET=worker switches the Astro base from "/pymode"
  // (the github-pages default) to "/" so paths match the worker URL.
  const result = spawnSync("npm", ["run", "build"], {
    cwd: docsDir,
    stdio: "inherit",
    env: { ...process.env, ASTRO_DEPLOY_TARGET: "worker" },
  });
  if (result.status !== 0) {
    throw new Error("Astro docs build failed");
  }
}

function deployWorker(repoRoot) {
  const workerDir = join(repoRoot, "worker");
  console.log("\n  Deploying to Cloudflare Workers...\n");
  const result = spawnSync("npx", ["wrangler", "deploy"], {
    cwd: workerDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("wrangler deploy failed");
  }
}

export async function deploy(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode deploy — bundle and deploy to Cloudflare Workers

  Usage:
    pymode deploy [directory] [options]

  Options:
    --aot                Rebuild python.wasm with this app's imports
                         preimported (~10 min build, ~5ms cold start).
                         Default: use the prebuilt slim base wasm
                         (~28ms cold start, no rebuild).
    --no-aot             Force prebuilt base mode even if --aot would
                         otherwise be implied.
    --help, -h           Show this help

  pymode deploy pipeline:
    1. uv pip download project deps into .pymode/packages/
    2. (--aot only) static-analyse imports, regenerate wizer preimport
       header, rebuild python.wasm tailored to this app
    3. bundle-app-packages: produce slim site-packages.zip from the
       downloaded wheels (replaces the test-runtime 40MB zip)
    4. bundle-project: emit user-files.ts with the .py files
    5. wrangler deploy
    `);
    process.exit(0);
  }

  const positional = args.filter(a => !a.startsWith("-"));
  const projectDir = resolve(positional[0] || ".");

  if (!existsSync(projectDir)) {
    console.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  const entryPoint = findEntryPoint(projectDir);
  if (!entryPoint) {
    console.error("No entry point found. Create src/entry.py or set [tool.pymode] main in pyproject.toml");
    process.exit(1);
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error("PyMode worker not found. Run from the pymode repo or install the pymode npm package.");
    process.exit(1);
  }

  // Resolve WASM variant based on project dependencies
  const deps = parseDeps(projectDir);
  const { variant: variantKey, unsupported } = resolveVariant(deps);

  if (unsupported.length > 0) {
    console.error(`\n  Unsupported C extension packages: ${unsupported.join(", ")}`);
    console.error("  These packages require C extensions not yet available for WASM.");
    console.error("  Only pure-Python packages and supported extensions (numpy) work.\n");
    process.exit(1);
  }

  // Check that the variant binary exists
  const workerSrc = join(repoRoot, "worker", "src");
  const registryPath = join(repoRoot, "lib", "variants.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  const variant = registry.variants[variantKey];
  const variantWasm = join(workerSrc, variant.wasm);

  if (!existsSync(variantWasm)) {
    console.error(`\n  WASM binary not found: ${variant.wasm}`);
    if (variantKey === "base") {
      console.error("  Build it with: ./scripts/build-phase2.sh");
    } else {
      console.error(`  Build it with: ./scripts/build-${variantKey}-wasm.sh`);
    }
    process.exit(1);
  }

  const wizerEnabled = isWizerEnabled(projectDir, args);

  console.log(`
  PyMode Deploy

  Project:  ${projectDir}
  Entry:    ${entryPoint}
  Variant:  ${variantKey} (${variant.description})
  Wizer:    ${wizerEnabled ? "enabled" : "disabled"}
  `);

  // Per-app AOT (rebuild python.wasm with this app's imports preimported).
  // Costs ~10 min on first deploy; subsequent deploys with the same import
  // set are cached. Without --aot we use the prebuilt slim base wasm.
  const aotRequested = args.includes("--aot") && !args.includes("--no-aot");

  try {
    // Select and copy the right WASM binary based on dependencies.
    // For native-extension-using apps this is a no-op for slim mode
    // (the deploy stays on base) — those apps should use --aot for the
    // tailored binary that includes their recipe(s).
    applyVariant(repoRoot, variantKey);

    // Copy extension site-packages if variant needs them; otherwise replace
    // with an empty zip so the test-runtime numpy bundle doesn't bloat the
    // deploy artifact.
    const extDst = join(workerSrc, "extension-site-packages.zip");
    if (variant.sitePackages) {
      const srcZip = join(workerSrc, variant.sitePackages);
      if (existsSync(srcZip)) {
        copyFileSync(srcZip, extDst);
      }
    } else {
      // Minimal valid empty zip (EOCDR only): 22 bytes
      const EMPTY_ZIP = Buffer.from([
        0x50, 0x4b, 0x05, 0x06,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      writeFileSync(extDst, EMPTY_ZIP);
    }

    installDeps(projectDir);

    if (aotRequested) {
      console.log("\n  --aot: regenerating wizer preimports + rebuilding python.wasm for this app...\n");
      const headerPath = join(repoRoot, "lib", "wizer", "pymode_wizer_app_preimports.h");
      // Pass the entry module name so generate-app-preimports also adds
      // _preimport("<entry>"), which forces the user's top-level code
      // (template construction, etc.) to run at wizer time. Otherwise
      // it'd run on every request.
      const genResult = spawnSync(
        "node",
        [join(repoRoot, "scripts", "generate-app-preimports.mjs"), projectDir, headerPath, entryPoint],
        { stdio: "inherit" },
      );
      if (genResult.status !== 0) throw new Error("generate-app-preimports failed");

      // Convert "src/entry.py" → "src.entry" so wizer can preimport via
      // PyImport_ImportModule. The runtime user-files.ts already uses
      // this convention for entryModule.
      const entryModuleName = entryPoint
        .replace(/\.py$/, "")
        .replace(/\//g, ".");

      const buildEnv = {
        ...process.env,
        PYMODE_APP_PROJECT_DIR: projectDir,
        PYMODE_APP_ENTRY_MODULE: entryModuleName,
      };
      const buildResult = spawnSync(
        "npx",
        ["tsx", join(repoRoot, "scripts", "build-phase2.ts"), "--mode=app", `--app-preimports=${headerPath}`],
        { stdio: "inherit", cwd: repoRoot, env: buildEnv },
      );
      if (buildResult.status !== 0) throw new Error("build-phase2 --mode=app failed");

      const appWasm = join(workerSrc, "python-app.wasm");
      if (!existsSync(appWasm)) throw new Error("python-app.wasm not produced");
      copyFileSync(appWasm, join(workerSrc, "python.wasm"));
    } else if (wizerEnabled) {
      buildWizerSnapshot(repoRoot);
    }

    // Replace the test-runtime site-packages.zip with one assembled from
    // this app's wheels only. Empty zip if the app has no PyPI deps.
    const wheelsDir = join(projectDir, ".pymode", "packages");
    const slimZip = join(workerSrc, "site-packages.zip");
    console.log("\n  Bundling app deps into site-packages.zip...");
    const slimResult = spawnSync(
      "node",
      [join(repoRoot, "scripts", "bundle-app-packages.mjs"), wheelsDir, slimZip],
      { stdio: "inherit" },
    );
    if (slimResult.status !== 0) {
      console.log("  WARN: bundle-app-packages failed — keeping existing site-packages.zip\n");
    }

    bundleProject(projectDir, repoRoot);
    buildDocs(repoRoot);
    ensureWorkerDeps(repoRoot);
    deployWorker(repoRoot);
    console.log("\n  Deploy complete!\n");
  } catch (err) {
    console.error(`\n  Deploy failed: ${err.message}\n`);
    process.exit(1);
  }
}
