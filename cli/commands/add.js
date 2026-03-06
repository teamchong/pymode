// pymode add <package> — add a dependency to pyproject.toml and install it

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export async function add(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode add — add a Python package dependency

  Usage:
    pymode add <package> [<package2> ...]

  Examples:
    pymode add requests
    pymode add "requests>=2.28" jinja2
    `);
    process.exit(0);
  }

  const packages = args.filter(a => !a.startsWith("-"));
  if (packages.length === 0) {
    console.error("Usage: pymode add <package> [<package2> ...]");
    process.exit(1);
  }

  const projectDir = process.cwd();
  const pyprojectPath = join(projectDir, "pyproject.toml");

  if (!existsSync(pyprojectPath)) {
    console.error("No pyproject.toml found. Run pymode init first or create one.");
    process.exit(1);
  }

  let content = readFileSync(pyprojectPath, "utf-8");

  // Parse existing dependencies
  const depsMatch = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  let existingDeps = [];

  if (depsMatch) {
    existingDeps = depsMatch[1]
      .split("\n")
      .map(l => l.trim().replace(/,$/, "").replace(/^["']|["']$/g, ""))
      .filter(l => l && !l.startsWith("#"));
  }

  // Add new packages (avoid duplicates by base name)
  const getBaseName = (pkg) => pkg.split(/[><=!~\s]/)[0].toLowerCase();
  const existingNames = new Set(existingDeps.map(getBaseName));

  const added = [];
  for (const pkg of packages) {
    const baseName = getBaseName(pkg);
    if (existingNames.has(baseName)) {
      console.log(`  ${baseName} already in dependencies, skipping`);
      continue;
    }
    existingDeps.push(pkg);
    existingNames.add(baseName);
    added.push(pkg);
  }

  if (added.length === 0) {
    console.log("  No new packages to add.");
    return;
  }

  // Write back to pyproject.toml
  const depsStr = existingDeps.map(d => `    "${d}",`).join("\n");
  const depsSection = `dependencies = [\n${depsStr}\n]`;

  if (depsMatch) {
    // Replace existing dependencies
    content = content.replace(
      /dependencies\s*=\s*\[[\s\S]*?\]/,
      depsSection
    );
  } else if (content.includes("[project]")) {
    // Add dependencies after [project] section
    content = content.replace(
      /(\[project\][^\[]*)/,
      `$1${depsSection}\n`
    );
  } else {
    // No [project] section — add one
    content += `\n[project]\n${depsSection}\n`;
  }

  writeFileSync(pyprojectPath, content);

  for (const pkg of added) {
    console.log(`  + ${pkg}`);
  }

  // Auto-install
  console.log("\n  Installing packages...");
  const { install } = await import("./install.js");
  await install([]);
}
