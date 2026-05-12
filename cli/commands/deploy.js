// pymode deploy — bundle project + deploy to Cloudflare Workers
//
// Always AOT-rebuilds python.wasm with the app's imports preimported
// via wizer, then bundles deps + user code and runs `wrangler deploy`.

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync, copyFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseDeps, resolveVariant, checkPackage } from "../lib/variants.js";

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
    pymode deploy [directory]

  Options:
    --help, -h           Show this help

  pymode deploy pipeline:
    1. uv pip download project deps into .pymode/packages/
    2. static-analyse imports, regenerate wizer preimport header,
       rebuild python.wasm with this app's imports baked in (~10 min)
    3. bundle-app-packages: produce site-packages.zip from the wheels
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

  const workerSrc = join(repoRoot, "worker", "src");
  const registryPath = join(repoRoot, "lib", "variants.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  const variant = registry.variants[variantKey];

  console.log(`
  PyMode Deploy

  Project:  ${projectDir}
  Entry:    ${entryPoint}
  Variant:  ${variantKey} (${variant.description})
  `);

  try {
    // Copy extension site-packages if variant needs them (numpy/pillow);
    // otherwise drop an empty zip so the worker bundle stays slim.
    const extDst = join(workerSrc, "extension-site-packages.zip");
    if (variant.sitePackages) {
      const srcZip = join(workerSrc, variant.sitePackages);
      if (existsSync(srcZip)) {
        copyFileSync(srcZip, extDst);
      }
    } else {
      const EMPTY_ZIP = Buffer.from([
        0x50, 0x4b, 0x05, 0x06,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      writeFileSync(extDst, EMPTY_ZIP);
    }

    // python-do.ts unconditionally imports worker/src/extensions/numpy/*.wasm
    // so wrangler bundles them on every deploy. For non-numpy variants,
    // overwrite those with 8-byte stub wasm modules — wrangler still bundles
    // them, but they're tiny instead of 3.5MB each.
    const numpyExtDir = join(workerSrc, "extensions", "numpy");
    if (existsSync(numpyExtDir) && !(variant.extensions || []).includes("numpy")) {
      const STUB_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const stubTargets = ["_multiarray_umath.wasm", "_multiarray_umath.wasm.dat"];
      for (const name of stubTargets) {
        const file = join(numpyExtDir, name);
        if (existsSync(file)) writeFileSync(file, STUB_WASM);
      }
    }

    installDeps(projectDir);

    // C-extension variant detection: if the project depends on a package
    // that needs a pre-built variant (numpy, pillow, pydantic_core, …),
    // the AOT path below won't include the native code and the deploy
    // would fail at runtime with ImportError.
    //
    // The pre-built variant wasms in worker/src/ exist but were built
    // against an older host-import surface; the current worker.ts /
    // wasm-runner.ts don't supply the imports they expect. Until the
    // variants are rebuilt against the current surface (or the worker
    // adds back-compat aliases), variant deploys are not viable.
    //
    // For now, refuse cleanly instead of producing a broken deploy.
    if (variant.wasm) {
      console.error(
        `\n  C-extension variant "${variantKey}" detected but variant deploy isn't wired ` +
        `end-to-end yet. The pre-built ${variant.wasm} exists but uses an older ` +
        `host-import surface than the current worker. See docs/limitations for the ` +
        `current state of C-extension package support.\n`
      );
      process.exit(1);
    }

    console.log("\n  Regenerating wizer preimports + rebuilding python.wasm for this app...\n");
    const headerPath = join(repoRoot, "lib", "wizer", "pymode_wizer_app_preimports.h");
    const genResult = spawnSync(
      "node",
      [join(repoRoot, "scripts", "generate-app-preimports.mjs"), projectDir, headerPath, entryPoint],
      { stdio: "inherit" },
    );
    if (genResult.status !== 0) throw new Error("generate-app-preimports failed");

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
