// pymode remove <package> — remove a dependency from pyproject.toml

import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

export async function remove(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode remove — remove a Python package dependency

  Usage:
    pymode remove <package> [<package2> ...]

  Examples:
    pymode remove requests
    pymode remove requests jinja2
    `);
    process.exit(0);
  }

  const packages = args.filter(a => !a.startsWith("-"));
  if (packages.length === 0) {
    console.error("Usage: pymode remove <package> [<package2> ...]");
    process.exit(1);
  }

  const projectDir = process.cwd();
  const pyprojectPath = join(projectDir, "pyproject.toml");

  if (!existsSync(pyprojectPath)) {
    console.error("No pyproject.toml found.");
    process.exit(1);
  }

  let content = readFileSync(pyprojectPath, "utf-8");
  const depsMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);

  if (!depsMatch) {
    console.log("  No dependencies found in pyproject.toml");
    return;
  }

  let existingDeps = depsMatch[1]
    .split("\n")
    .map(l => l.trim().replace(/,$/, "").replace(/^["']|["']$/g, ""))
    .filter(l => l && !l.startsWith("#"));

  const getBaseName = (pkg) => pkg.split(/[><=!~\s]/)[0].toLowerCase();
  const toRemove = new Set(packages.map(p => p.toLowerCase()));

  const removed = [];
  existingDeps = existingDeps.filter(dep => {
    const baseName = getBaseName(dep);
    if (toRemove.has(baseName)) {
      removed.push(dep);
      return false;
    }
    return true;
  });

  if (removed.length === 0) {
    console.log("  No matching packages found in dependencies.");
    return;
  }

  // Write back
  const depsStr = existingDeps.length > 0
    ? existingDeps.map(d => `    "${d}",`).join("\n")
    : "";
  const depsSection = `dependencies = [\n${depsStr}\n]`;
  content = content.replace(/dependencies\s*=\s*\[[\s\S]*?\]/, depsSection);
  writeFileSync(pyprojectPath, content);

  for (const pkg of removed) {
    console.log(`  - ${pkg}`);
  }

  // Clean up downloaded packages
  const pkgDir = join(projectDir, ".pymode", "packages");
  if (existsSync(pkgDir)) {
    for (const pkg of packages) {
      // Try to remove matching .whl files
      try {
        const { readdirSync } = await import("fs");
        for (const file of readdirSync(pkgDir)) {
          if (file.toLowerCase().startsWith(pkg.toLowerCase())) {
            rmSync(join(pkgDir, file), { force: true });
          }
        }
      } catch {}
    }
  }

  console.log(`\n  Removed ${removed.length} package(s) from pyproject.toml`);
}
