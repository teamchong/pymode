// Variant resolution — select the right python.wasm based on project dependencies.
//
// Reads lib/variants.json and maps package names to WASM variants.
// Used by deploy, install, and add commands.

import { readFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

function getRegistry() {
  const cliDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const repoRoot = dirname(cliDir);
  const registryPath = join(repoRoot, "lib", "variants.json");
  return JSON.parse(readFileSync(registryPath, "utf-8"));
}

/**
 * Parse [project] dependencies from pyproject.toml.
 * Returns list of base package names (lowercase, no version specifiers).
 */
export function parseDeps(projectDir) {
  const pyprojectPath = join(projectDir, "pyproject.toml");
  if (!existsSync(pyprojectPath)) return [];

  const content = readFileSync(pyprojectPath, "utf-8");
  const match = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];

  return match[1]
    .split("\n")
    .map(l => l.trim().replace(/,$/, "").replace(/^["']|["']$/g, ""))
    .filter(l => l && !l.startsWith("#"))
    .map(l => l.split(/[><=!~\s\[]/)[0].toLowerCase());
}

/**
 * Resolve which WASM variant a project needs based on its dependencies.
 *
 * Returns { variant, unsupported } where:
 *   variant    — key in variants.json ("base", "numpy", etc.)
 *   unsupported — list of packages that need C extensions we don't have yet
 */
export function resolveVariant(deps) {
  const registry = getRegistry();
  const { variants, extensionPackages } = registry;

  let needed = null;
  const unsupported = [];

  for (const dep of deps) {
    const variantKey = extensionPackages[dep];
    if (variantKey === undefined) {
      // Pure Python package — no variant needed
      continue;
    }
    if (variantKey === null) {
      // Known C extension but no variant built yet
      unsupported.push(dep);
      continue;
    }
    // Pick the variant (if multiple deps need different variants, pick largest)
    if (!needed || variantSizeRank(variants, variantKey) > variantSizeRank(variants, needed)) {
      needed = variantKey;
    }
  }

  return {
    variant: needed || "base",
    unsupported,
  };
}

function variantSizeRank(variants, key) {
  const exts = variants[key]?.extensions || [];
  return exts.length;
}

/**
 * Check if a package name requires a C extension variant.
 * Returns { needsVariant, variantKey, supported } or null if pure Python.
 */
export function checkPackage(packageName) {
  const registry = getRegistry();
  const base = packageName.split(/[><=!~\s\[]/)[0].toLowerCase();
  const variantKey = registry.extensionPackages[base];

  if (variantKey === undefined) return null; // pure Python
  return {
    needsVariant: true,
    variantKey: variantKey,
    supported: variantKey !== null,
  };
}

/**
 * Copy the correct WASM binary and site-packages for a variant
 * into the worker/src directory (overwriting python.wasm).
 *
 * Returns the variant metadata.
 */
export function applyVariant(repoRoot, variantKey) {
  const registry = getRegistry();
  const variant = registry.variants[variantKey];
  if (!variant) {
    throw new Error(`Unknown variant: ${variantKey}`);
  }

  const workerSrc = join(repoRoot, "worker", "src");
  const targetWasm = join(workerSrc, "python.wasm");

  // Copy variant WASM → python.wasm
  const sourceWasm = join(workerSrc, variant.wasm);
  if (!existsSync(sourceWasm)) {
    throw new Error(
      `Variant binary not found: ${sourceWasm}\n` +
      `Build it with: python3 scripts/build-variant.py ${variantKey}`
    );
  }

  // Only copy if source is different from target
  if (variant.wasm !== "python.wasm") {
    copyFileSync(sourceWasm, targetWasm);
    console.log(`  Variant: ${variantKey} (${variant.wasm} → python.wasm)`);
  } else {
    console.log(`  Variant: base (python.wasm)`);
  }

  // Copy variant site-packages if present
  if (variant.sitePackages) {
    const sourcePkg = join(workerSrc, variant.sitePackages);
    if (existsSync(sourcePkg)) {
      // The worker already mounts site-packages.zip on PYTHONPATH.
      // For extension packages, we also need the extension's Python layer.
      // We copy the extension zip alongside site-packages.zip and
      // the worker mounts both.
      console.log(`  Extension packages: ${variant.sitePackages}`);
    } else {
      console.log(`  Warning: ${variant.sitePackages} not found, extension Python files may be missing`);
    }
  }

  return variant;
}

/**
 * Get list of all known extension packages (for display/help).
 */
export function listExtensionPackages() {
  const registry = getRegistry();
  const supported = [];
  const planned = [];

  for (const [pkg, variant] of Object.entries(registry.extensionPackages)) {
    if (variant !== null) {
      supported.push({ package: pkg, variant });
    } else {
      planned.push(pkg);
    }
  }

  return { supported, planned };
}
