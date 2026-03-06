// pymode deploy — bundle project + deploy to Cloudflare Workers
//
// Chains: install deps → build wizer snapshot → bundle-project.sh → wrangler deploy

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, cpSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

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

  console.log(`  Installing ${deps.length} package(s)...`);
  const result = spawnSync("python3", ["-m", "pip", "download",
    "--only-binary", ":all:",
    "--python-version", "3.13",
    "--platform", "any",
    "--dest", join(projectDir, ".pymode", "packages"),
    ...deps,
  ], { stdio: "inherit", cwd: projectDir });

  if (result.status !== 0) {
    console.log("  Warning: some packages failed to download.\n");
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
    --wizer              Build Wizer snapshot for ~5ms cold starts
    --no-wizer           Skip Wizer even if enabled in pyproject.toml
    --help, -h           Show this help

  Wizer can also be enabled in pyproject.toml:
    [tool.pymode]
    wizer = true

  Requires python.wasm (build with ./scripts/build-phase2.sh).
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

  // Check python.wasm exists
  const wasmPath = join(repoRoot, "worker", "src", "python.wasm");
  if (!existsSync(wasmPath)) {
    console.error(`python.wasm not found at ${wasmPath}`);
    console.error("Build it with: ./scripts/build-phase2.sh");
    console.error("Or download a pre-built release from the GitHub releases page.");
    process.exit(1);
  }

  const wizerEnabled = isWizerEnabled(projectDir, args);

  console.log(`
  PyMode Deploy

  Project: ${projectDir}
  Entry:   ${entryPoint}
  Wizer:   ${wizerEnabled ? "enabled" : "disabled"}
  `);

  try {
    installDeps(projectDir);
    if (wizerEnabled) {
      buildWizerSnapshot(repoRoot);
    }
    bundleProject(projectDir, repoRoot);
    ensureWorkerDeps(repoRoot);
    deployWorker(repoRoot);
    console.log("\n  Deploy complete!\n");
  } catch (err) {
    console.error(`\n  Deploy failed: ${err.message}\n`);
    process.exit(1);
  }
}
