#!/usr/bin/env npx tsx
/**
 * Build a C extension package as a .wasm side module for PyMode.
 *
 * Side modules are loaded at runtime by PythonDO via the dl_open/dl_sym
 * host imports. They share linear memory with the main python.wasm and
 * export PyInit_<name> functions that CPython calls through the standard
 * _PyImport_FindSharedFuncptr() flow in dynload_pymode.c.
 *
 * Usage:
 *     npx tsx scripts/build-extension.ts markupsafe
 *     npx tsx scripts/build-extension.ts simplejson==3.19.3
 *     npx tsx scripts/build-extension.ts --list    # show supported packages
 *     npx tsx scripts/build-extension.ts --all     # build all supported
 *
 * Output:
 *     .pymode/extensions/{name}/{module}.wasm  -- side module
 *     .pymode/extensions/{name}/*.py           -- pure Python files from package
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const EXT_DIR = path.join(ROOT_DIR, ".pymode", "extensions");
const CPYTHON_DIR = path.join(ROOT_DIR, "cpython");
const BUILD_DIR = path.join(ROOT_DIR, "build", "zig-wasi");

const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

function info(msg: string): void {
  console.log(`${GREEN}[INFO]${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[WARN]${NC} ${msg}`);
}

function error(msg: string): never {
  console.error(`${RED}[ERROR]${NC} ${msg}`);
  process.exit(1);
}

const CFLAGS_COMMON = [
  "-target",
  "wasm32-wasi",
  "-Os",
  "-DNDEBUG",
  `-I${CPYTHON_DIR}/Include`,
  `-I${CPYTHON_DIR}/Include/internal`,
  `-I${BUILD_DIR}`,
  "-Wno-error=int-conversion",
  "-Wno-error=incompatible-pointer-types",
];

function runCapture(
  cmd: string,
  args: string[],
): { returncode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { returncode: 0, stdout: stdout ?? "", stderr: "" };
  } catch (e: any) {
    return {
      returncode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function compileSideModule(outputWasm: string, srcFiles: string[]): boolean {
  const objDir = mkdtempSync(path.join(tmpdir(), "pymode-ext-"));
  try {
    const objects: string[] = [];
    for (const src of srcFiles) {
      const objName = path.basename(src).replace(".c", ".o");
      const objPath = path.join(objDir, objName);
      info(`  Compiling ${path.basename(src)}`);
      const result = runCapture("zig", ["cc", ...CFLAGS_COMMON, "-c", src, "-o", objPath]);
      if (result.returncode !== 0) {
        warn(`  Failed to compile ${path.basename(src)}`);
        return false;
      }
      objects.push(objPath);
    }

    if (objects.length === 0) {
      warn("No object files produced");
      return false;
    }

    info(`  Linking -> ${path.basename(outputWasm)}`);
    const result = runCapture("zig", [
      "cc",
      "-target",
      "wasm32-wasi",
      "-nostdlib",
      "-Os",
      "-s",
      "-Wl,--import-memory",
      "-Wl,--allow-undefined",
      "-Wl,--no-entry",
      "-Wl,--export-dynamic",
      ...objects,
      "-o",
      outputWasm,
    ]);
    if (result.returncode !== 0) {
      if (result.stderr) {
        warn(`  Link error: ${result.stderr}`);
      }
      return false;
    }
    return true;
  } finally {
    fs.rmSync(objDir, { recursive: true, force: true });
  }
}

function downloadSource(name: string, dest: string): void {
  const dlDir = path.join(dest, "dl");
  fs.mkdirSync(dlDir, { recursive: true });

  // Try sdist first (has C source), fall back to wheel
  let result = runCapture("pip3", ["download", "--no-binary", ":all:", name, "-d", dlDir]);
  if (result.returncode !== 0) {
    result = runCapture("pip3", ["download", name, "-d", dlDir]);
    if (result.returncode !== 0) {
      error(`Failed to download ${name}`);
    }
  }

  const files = fs.readdirSync(dlDir);
  const sdists = files.filter((f) => f.endsWith(".tar.gz"));
  const wheels = files.filter((f) => f.endsWith(".whl"));

  if (sdists.length > 0) {
    execFileSync("tar", ["xzf", path.join(dlDir, sdists[0]), "-C", dest, "--strip-components=1"]);
  } else if (wheels.length > 0) {
    execFileSync("python3", ["-m", "zipfile", "-e", path.join(dlDir, wheels[0]), path.join(dest, "src")]);
  } else {
    error(`No sdist or wheel found for ${name}`);
  }
}

function copyPyFiles(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".py")) {
      fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
  }
}

interface ExtensionDef {
  info_msg: string;
  src_dirs: string[];
  c_file: string;
  wasm: string;
}

const EXTENSIONS: Record<string, ExtensionDef> = {
  markupsafe: {
    info_msg: "Building markupsafe (_speedups.wasm)...",
    src_dirs: ["src/markupsafe", "markupsafe"],
    c_file: "_speedups.c",
    wasm: "_speedups.wasm",
  },
  simplejson: {
    info_msg: "Building simplejson (_speedups.wasm)...",
    src_dirs: ["simplejson"],
    c_file: "_speedups.c",
    wasm: "_speedups.wasm",
  },
  msgpack: {
    info_msg: "Building msgpack (_cmsgpack.wasm)...",
    src_dirs: ["msgpack"],
    c_file: "_cmsgpack.c",
    wasm: "_cmsgpack.wasm",
  },
  pyyaml: {
    info_msg: "Building pyyaml (_yaml.wasm)...",
    src_dirs: ["yaml", "."],
    c_file: "_yaml.c",
    wasm: "_yaml.wasm",
  },
};

function buildExt(name: string): void {
  const pkgDir = path.join(EXT_DIR, name);
  fs.mkdirSync(pkgDir, { recursive: true });

  const lookup = name.toLowerCase();
  if (!(lookup in EXTENSIONS)) {
    error(`Unknown extension: ${name}. Run with --list to see supported packages.`);
  }

  const ext = EXTENSIONS[lookup];
  info(ext.info_msg);
  downloadSource(name, pkgDir);

  // Find source directory
  let srcDir: string | null = null;
  for (const candidate of ext.src_dirs) {
    const p = path.join(pkgDir, candidate);
    if (fs.existsSync(path.join(p, ext.c_file))) {
      srcDir = p;
      break;
    }
  }

  if (!srcDir) {
    error(`${ext.c_file} not found`);
  }

  const cPath = path.join(srcDir, ext.c_file);
  const wasmPath = path.join(pkgDir, ext.wasm);

  if (!compileSideModule(wasmPath, [cPath])) {
    error(`Failed to compile ${name}`);
  }

  copyPyFiles(srcDir, pkgDir);

  // Report
  for (const f of fs.readdirSync(pkgDir)) {
    if (f.endsWith(".wasm")) {
      const size = fs.statSync(path.join(pkgDir, f)).size;
      info(`Built: ${path.join(pkgDir, f)} (${Math.floor(size / 1024)}KB)`);
    }
  }
}

function listExtensions(): void {
  console.log("Supported C extension packages:");
  console.log("  markupsafe   - HTML escaping (1 C file, ~15KB .wasm)");
  console.log("  simplejson   - Fast JSON encoder/decoder (1 C file)");
  console.log("  msgpack      - MessagePack serialization (1 C file)");
  console.log("  pyyaml       - YAML parser (requires libyaml headers)");
  console.log();
  console.log("Usage:");
  console.log("  npx tsx scripts/build-extension.ts markupsafe");
  console.log("  npx tsx scripts/build-extension.ts --all");
  console.log();
  console.log("Output goes to .pymode/extensions/<name>/<module>.wasm");
  console.log("These .wasm files are loaded at runtime by PythonDO via dl_open/dl_sym.");
}

function buildAll(): void {
  let failed = 0;
  for (const ext of ["markupsafe", "simplejson", "msgpack"]) {
    try {
      buildExt(ext);
    } catch {
      warn(`Failed to build ${ext}`);
      failed++;
    }
  }

  if (failed === 0) {
    info("All extensions built successfully");
  } else {
    warn(`${failed} extension(s) failed to build`);
  }
}

function main(): void {
  // Check prerequisites
  try {
    execFileSync("zig", ["version"], { stdio: "pipe" });
  } catch {
    error("zig not found. Install: https://ziglang.org/download/");
  }
  if (!fs.existsSync(path.join(CPYTHON_DIR, "Include"))) {
    error("CPython not found. Run build-phase1.sh first.");
  }
  if (!fs.existsSync(path.join(BUILD_DIR, "pyconfig.h"))) {
    error("pyconfig.h not found. Run build-phase2.ts first.");
  }

  const args = process.argv.slice(2);
  if (args.length < 1) {
    error("Usage: build-extension.ts <package-name> | --list | --all");
  }

  const arg = args[0];
  if (arg === "--list" || arg === "-l") {
    listExtensions();
  } else if (arg === "--all" || arg === "-a") {
    buildAll();
  } else {
    buildExt(arg);
  }
}

main();
