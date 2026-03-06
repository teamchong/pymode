// pymode build — compile C extension recipes and link WASM variants
//
// Usage:
//   pymode build                  Build variant needed by current project's deps
//   pymode build numpy            Build specific recipe
//   pymode build --all            Build all recipes

import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseDeps, resolveVariant } from "../lib/variants.js";

function findRepoRoot() {
  const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = dirname(cliDir);
  if (existsSync(join(repoRoot, "scripts", "build-recipe.sh"))) {
    return repoRoot;
  }
  return null;
}

function listRecipes(repoRoot) {
  const recipesDir = join(repoRoot, "recipes");
  if (!existsSync(recipesDir)) return [];
  return readdirSync(recipesDir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const recipe = JSON.parse(readFileSync(join(recipesDir, f), "utf-8"));
      return { name: recipe.name, version: recipe.version, file: f };
    });
}

export async function build(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  pymode build — compile C extension recipes into WASM variants

  Usage:
    pymode build                  Build variant needed by project dependencies
    pymode build <recipe>         Build a specific recipe (e.g. numpy, markupsafe)
    pymode build --all            Build all available recipes
    pymode build --list           List available recipes

  Recipes are in recipes/*.json. Each recipe defines how to compile
  a C extension package for wasm32-wasi using zig cc.
    `);
    process.exit(0);
  }

  const repoRoot = findRepoRoot();
  if (!repoRoot) {
    console.error("PyMode repo not found. Run from the pymode directory.");
    process.exit(1);
  }

  if (args.includes("--list")) {
    const recipes = listRecipes(repoRoot);
    console.log("\n  Available recipes:\n");
    for (const r of recipes) {
      const built = existsSync(join(repoRoot, "build", "recipes", r.name, "obj"));
      console.log(`    ${r.name} ${r.version}${built ? " (built)" : ""}`);
    }
    console.log("");
    process.exit(0);
  }

  if (args.includes("--all")) {
    const recipes = listRecipes(repoRoot);
    console.log(`\n  Building all ${recipes.length} recipes...\n`);
    for (const r of recipes) {
      const result = spawnSync("bash", [join(repoRoot, "scripts", "build-recipe.sh"), r.name, "--objects-only"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      if (result.status !== 0) {
        console.error(`  Failed to build ${r.name}`);
      }
    }
    process.exit(0);
  }

  // Build specific recipe(s) or auto-detect from project deps
  const positional = args.filter(a => !a.startsWith("-"));

  if (positional.length > 0) {
    // Build specific recipe(s) and link variant
    console.log(`\n  Building variant: ${positional.join(", ")}...\n`);
    const result = spawnSync("bash", [join(repoRoot, "scripts", "build-variant.sh"), ...positional], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    process.exit(result.status || 0);
  }

  // Auto-detect from pyproject.toml
  const projectDir = process.cwd();
  const deps = parseDeps(projectDir);

  if (deps.length === 0) {
    console.log("\n  No dependencies found in pyproject.toml. Nothing to build.\n");
    process.exit(0);
  }

  const { variant, unsupported } = resolveVariant(deps);

  if (unsupported.length > 0) {
    console.error(`\n  Unsupported packages: ${unsupported.join(", ")}`);
    console.error("  These need recipes. Create recipes/*.json for them.\n");
  }

  if (variant === "base") {
    console.log("\n  All dependencies are pure Python. No variant build needed.\n");
    process.exit(0);
  }

  console.log(`\n  Project needs variant: ${variant}`);
  console.log(`  Building...\n`);

  const result = spawnSync("bash", [join(repoRoot, "scripts", "build-variant.sh"), variant], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  process.exit(result.status || 0);
}
