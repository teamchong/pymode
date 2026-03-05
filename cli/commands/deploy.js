// pymode deploy — bundle project + deploy to Cloudflare Workers
//
// Chains: bundle-project.sh → wrangler deploy
// If python.wasm isn't built, downloads the pre-built binary.

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
  const projectDir = resolve(args[0] || ".");

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

  console.log(`
  PyMode Deploy

  Project: ${projectDir}
  Entry:   ${entryPoint}
  `);

  try {
    bundleProject(projectDir, repoRoot);
    ensureWorkerDeps(repoRoot);
    deployWorker(repoRoot);
    console.log("\n  Deploy complete!\n");
  } catch (err) {
    console.error(`\n  Deploy failed: ${err.message}\n`);
    process.exit(1);
  }
}
