#!/usr/bin/env npx tsx
/**
 * Build a C extension package from a recipe for wasm32-wasi.
 *
 * Usage:
 *     npx tsx scripts/build-recipe.ts <recipe-name> [--objects-only]
 *
 * Produces .o files in build/recipes/<name>/ and optionally links into python.wasm variant.
 * With --objects-only, just compiles without linking (used by build-variant.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const CPYTHON = path.join(ROOT_DIR, "cpython");
const BUILD_DIR = path.join(ROOT_DIR, "build", "zig-wasi");

interface Recipe {
  name: string;
  version: string;
  pypi?: string;
  type: string;
  build_script?: string;
  includes?: string[];
  cflags?: string[];
  sources: string[];
  vendor_sources?: string[];
  cython_sources?: string[];
  python_packages?: string[];
}

/** Minimal ZIP writer for ZIP_STORED (no compression). */
function createStoredZip(entries: Array<{ arcname: string; data: Buffer }>): Buffer {
  if (entries.length > 0xffff) throw new Error(`Too many ZIP entries (${entries.length} > 65535)`);
  const centralEntries: Buffer[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const { arcname, data } of entries) {
    const nameBytes = Buffer.from(arcname, "utf-8");
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression (stored)
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);

    // Central directory entry (46 bytes + name)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attrs
    central.writeUInt32LE(0, 38); // external file attrs
    central.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(central, 46);

    localParts.push(local, data);
    centralEntries.push(central);
    offset += local.length + data.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralEntries);
  const centralDirSize = centralDir.length;

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12); // central dir size
  eocd.writeUInt32LE(centralDirOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/** CRC32 for ZIP. */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function run(
  cmd: string,
  args: string[],
  opts?: { capture?: boolean },
): { returncode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      stdio: opts?.capture ? ["pipe", "pipe", "pipe"] : "inherit",
      encoding: "utf-8",
    });
    return { returncode: 0, stdout: stdout ?? "", stderr: "" };
  } catch (e: any) {
    if (opts?.capture) {
      return {
        returncode: e.status ?? 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
    return { returncode: e.status ?? 1, stdout: "", stderr: e.stderr ?? "" };
  }
}

function findFiles(dir: string, pattern: string): string[] {
  // Simple glob for patterns like "lib/**/*.c"
  const results: string[] = [];
  function walk(d: string): void {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  // Use Node's globSync if the pattern contains wildcards
  try {
    const matched = globSync(pattern, { cwd: dir });
    return matched.map((m) => path.join(dir, m)).sort();
  } catch {
    walk(dir);
    return results.filter((f) => f.endsWith(".c")).sort();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: build-recipe.ts <recipe-name> [--objects-only]");
    process.exit(1);
  }

  const recipeName = args[0];
  const objectsOnly = args.includes("--objects-only");

  const recipePath = path.join(ROOT_DIR, "recipes", `${recipeName}.json`);
  if (!fs.existsSync(recipePath)) {
    console.log(`Recipe not found: ${recipePath}`);
    process.exit(1);
  }

  const recipe: Recipe = JSON.parse(fs.readFileSync(recipePath, "utf-8"));
  const { name, version, type: rtype } = recipe;
  const pypi = recipe.pypi ?? name;

  console.log(`Building ${name} ${version} (type: ${rtype})...`);

  // Custom recipes use their own build script
  if (rtype === "custom") {
    const buildScript = recipe.build_script!;
    console.log(`  Running custom build: ${buildScript}`);
    execFileSync("bash", [path.join(ROOT_DIR, buildScript)], { stdio: "inherit" });
    return;
  }

  // Download source from PyPI
  const srcDir = path.join(ROOT_DIR, "build", "recipes", name);
  const downloadDir = path.join(srcDir, "download");
  const objDir = path.join(srcDir, "obj");
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.mkdirSync(objDir, { recursive: true });

  const pkgSrc = path.join(srcDir, "src");
  if (!fs.existsSync(pkgSrc) || !fs.statSync(pkgSrc).isDirectory()) {
    console.log(`  Downloading ${pypi}==${version} from PyPI...`);
    run("pip3", ["download", `${pypi}==${version}`, "--no-binary=:all:", "--no-deps", "-d", downloadDir], {
      capture: true,
    });

    // Extract
    const tarballs = fs.readdirSync(downloadDir).filter((f) => f.endsWith(".tar.gz"));
    const zipfiles = fs.readdirSync(downloadDir).filter((f) => f.endsWith(".zip"));
    fs.mkdirSync(pkgSrc, { recursive: true });

    if (tarballs.length > 0) {
      execFileSync("tar", ["xzf", path.join(downloadDir, tarballs[0]), "-C", pkgSrc, "--strip-components=1"]);
    } else if (zipfiles.length > 0) {
      const srcTmp = path.join(srcDir, "src-tmp");
      execFileSync("unzip", ["-q", path.join(downloadDir, zipfiles[0]), "-d", srcTmp]);
      // Move contents up
      const entries = fs.readdirSync(srcTmp);
      if (entries.length === 1) {
        const inner = path.join(srcTmp, entries[0]);
        for (const item of fs.readdirSync(inner)) {
          fs.renameSync(path.join(inner, item), path.join(pkgSrc, item));
        }
      } else {
        for (const item of entries) {
          fs.renameSync(path.join(srcTmp, item), path.join(pkgSrc, item));
        }
      }
      fs.rmSync(srcTmp, { recursive: true, force: true });
    } else {
      console.log("  ERROR: No source archive found");
      process.exit(1);
    }
  }

  // Check prerequisites
  const pyconfig = path.join(BUILD_DIR, "pyconfig.h");
  if (!fs.existsSync(pyconfig)) {
    console.log("Error: CPython build not found. Run build-phase2.ts first.");
    process.exit(1);
  }

  // Base compiler flags
  const cflags = [
    "-target",
    "wasm32-wasi",
    "-c",
    "-Os",
    "-DNDEBUG",
    `-I${CPYTHON}/Include`,
    `-I${CPYTHON}/Include/cpython`,
    `-I${BUILD_DIR}`,
  ];

  // Add recipe includes
  for (const inc of recipe.includes ?? []) {
    cflags.push(`-I${pkgSrc}/${inc}`);
  }

  // Add recipe cflags
  cflags.push(...(recipe.cflags ?? []));

  // Run Cython if needed
  if (rtype === "cython") {
    for (const pyx of recipe.cython_sources ?? []) {
      const cFile = pyx.replace(".pyx", ".c");
      if (!fs.existsSync(path.join(pkgSrc, cFile))) {
        console.log(`  Cythonizing ${pyx}...`);
        let done = false;
        for (const cmd of ["cython3", "cython"]) {
          try {
            execFileSync(cmd, [path.join(pkgSrc, pyx), "-o", path.join(pkgSrc, cFile)]);
            done = true;
            break;
          } catch {
            // try next
          }
        }
        if (!done) {
          try {
            execFileSync("python3", ["-m", "cython", path.join(pkgSrc, pyx), "-o", path.join(pkgSrc, cFile)]);
          } catch {
            console.log("  ERROR: Cython not found. Install with: pip3 install cython");
            process.exit(1);
          }
        }
      }
    }
  }

  // Compile C sources
  const sources = recipe.sources;
  let success = 0;
  let fail = 0;

  for (const src of sources) {
    const outname = path.basename(src).replace(/\.c$/, "");
    const outfile = path.join(objDir, `${name}_${outname}.o`);
    const srcPath = path.join(pkgSrc, src);

    if (!fs.existsSync(srcPath)) {
      console.log(`  SKIP: ${src} (not found)`);
      continue;
    }

    const result = run("zig", ["cc", ...cflags, "-o", outfile, srcPath], { capture: true });
    if (result.returncode === 0) {
      success++;
    } else {
      console.log(`  FAIL: ${src}`);
      fail++;
    }
  }

  // Compile vendor sources (e.g., bundled zstd)
  for (const pattern of recipe.vendor_sources ?? []) {
    const matched = findFiles(pkgSrc, pattern);
    for (const srcPath of matched) {
      const outname = path.basename(srcPath).replace(/\.c$/, "");
      const outfile = path.join(objDir, `vendor_${outname}.o`);
      const result = run("zig", ["cc", ...cflags, "-o", outfile, srcPath], { capture: true });
      if (result.returncode === 0) {
        success++;
      } else {
        console.log(`  FAIL: ${srcPath}`);
        fail++;
      }
    }
  }

  console.log(`  Compiled: ${success} ok, ${fail} failed`);
  if (fail > 0) {
    console.log("  WARNING: Some files failed to compile");
  }

  // Bundle Python files into a zip
  const pythonPackages = recipe.python_packages ?? [];
  if (pythonPackages.length > 0) {
    console.log("  Bundling Python files...");
    const sitePkgZip = path.join(srcDir, `${name}-site-packages.zip`);
    const skipDirs = new Set(["tests", "testing", "test", "__pycache__"]);
    const zipEntries: Array<{ arcname: string; data: Buffer }> = [];

    for (const pkgDirName of pythonPackages) {
      const pkgPath = path.join(pkgSrc, pkgDirName);
      if (!fs.existsSync(pkgPath) || !fs.statSync(pkgPath).isDirectory()) continue;

      function walkPy(dir: string): void {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) {
              walkPy(path.join(dir, entry.name));
            }
          } else if (entry.isFile() && entry.name.endsWith(".py")) {
            const filepath = path.join(dir, entry.name);
            const arcname = path.relative(pkgSrc, filepath);
            zipEntries.push({ arcname, data: fs.readFileSync(filepath) });
          }
        }
      }
      walkPy(pkgPath);
    }

    const zipBuf = createStoredZip(zipEntries);
    fs.writeFileSync(sitePkgZip, zipBuf);
    const sizeKb = Math.floor(fs.statSync(sitePkgZip).size / 1024);
    console.log(`  ${zipEntries.length} Python files -> ${sizeKb}KB`);
  }

  const objFiles = fs.readdirSync(objDir).filter((f) => f.endsWith(".o"));
  console.log(`  Output: ${objFiles.length} object files in build/recipes/${name}/obj/`);

  if (objectsOnly) {
    console.log("  Done (objects only).");
    return;
  }

  console.log();
  console.log(`Done! To include in a variant, run:`);
  console.log(`  npx tsx scripts/build-variant.ts ${name}`);
}

main();
