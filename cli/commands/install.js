// pymode install — download pure-python wheels for all dependencies

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { checkPackage } from "../lib/variants.js";

function findPip() {
  for (const cmd of ["pip3", "pip", "python3 -m pip"]) {
    const parts = cmd.split(" ");
    const result = spawnSync(parts[0], [...parts.slice(1), "--version"], {
      stdio: "pipe",
    });
    if (result.status === 0) return parts;
  }
  return null;
}

function parseDependencies(projectDir) {
  const pyprojectPath = join(projectDir, "pyproject.toml");
  if (!existsSync(pyprojectPath)) return [];

  const content = readFileSync(pyprojectPath, "utf-8");
  const match = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];

  return match[1]
    .split("\n")
    .map(l => l.trim().replace(/,$/, "").replace(/^["']|["']$/g, ""))
    .filter(l => l && !l.startsWith("#"));
}

export async function install(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode install — install Python package dependencies

  Usage:
    pymode install              Install from pyproject.toml
    pymode install <package>    Install a specific package

  Downloads pure-Python wheels to .pymode/packages/.
  These are available in dev mode and bundled at deploy time.
    `);
    process.exit(0);
  }

  const projectDir = process.cwd();
  const extraPkgs = args.filter(a => !a.startsWith("-"));

  // Get deps from pyproject.toml + CLI args
  const deps = [...parseDependencies(projectDir), ...extraPkgs];

  if (deps.length === 0) {
    console.log("  No dependencies found. Add packages with: pymode add <package>");
    return;
  }

  const pip = findPip();
  if (!pip) {
    console.error("  pip not found. Install Python 3.10+ with pip.");
    process.exit(1);
  }

  const pkgDir = join(projectDir, ".pymode", "packages");
  mkdirSync(pkgDir, { recursive: true });

  // Separate C extension packages (handled by WASM variants) from pure-Python
  const pureDeps = [];
  const extensionDeps = [];
  for (const dep of deps) {
    const extInfo = checkPackage(dep);
    if (extInfo) {
      extensionDeps.push(dep);
    } else {
      pureDeps.push(dep);
    }
  }

  if (extensionDeps.length > 0) {
    console.log(`  C extension packages (provided by WASM variant): ${extensionDeps.join(", ")}`);
  }

  if (pureDeps.length === 0) {
    console.log("  No pure-Python packages to download.");
    return;
  }

  console.log(`  Installing ${pureDeps.length} pure-Python package(s)...\n`);

  // Download pure-python wheels
  // --only-binary :all: ensures we only get wheels (no source builds)
  // --platform any ensures pure-python only (no C extensions)
  const pipArgs = [
    ...pip.slice(1),
    "download",
    "--only-binary", ":all:",
    "--python-version", "3.13",
    "--platform", "any",
    "--dest", pkgDir,
    ...pureDeps,
  ];

  const result = spawnSync(pip[0], pipArgs, {
    stdio: "inherit",
    cwd: projectDir,
  });

  if (result.status !== 0) {
    console.error("\n  Some packages may not be available as pure-Python wheels.");
    console.error("  Only pure-Python packages work on Cloudflare Workers (no C extensions).");
    process.exit(1);
  }

  // List installed wheels
  const { readdirSync } = await import("fs");
  const wheels = readdirSync(pkgDir).filter(f => f.endsWith(".whl"));
  console.log(`\n  ${wheels.length} wheel(s) in .pymode/packages/`);
  for (const w of wheels) {
    console.log(`    ${w}`);
  }

  console.log(`\n  Packages available in dev mode and will be bundled on deploy.`);
}
