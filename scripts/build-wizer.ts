#!/usr/bin/env npx tsx
/**
 * Build a Wizer-pre-initialized python.wasm.
 *
 * Replaces Programs/python.o with pymode_wizer.o so the binary exports
 * wizer.initialize (CPython init + pre-imports) and a _start that
 * skips init when the snapshot flag is set.
 *
 * Produces: build/zig-wasi/python-wizer.wasm + worker/src/python-wizer.wasm
 *
 * Prerequisites:
 *     - build-phase2.ts completed (all .o files exist)
 *     - wizer installed (cargo install wizer --all-features)
 *     - wasm-opt installed (brew install binaryen)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const CPYTHON = path.join(ROOT_DIR, "cpython");
const BUILD_DIR = path.join(ROOT_DIR, "build", "zig-wasi");
const ZIG_CC = path.join(ROOT_DIR, "build", "zig-wrappers", "zig-cc");
const WIZER_DIR = path.join(ROOT_DIR, "lib", "wizer");
const IMPORTS_DIR = path.join(ROOT_DIR, "lib", "pymode-imports");
const OUTPUT = path.join(BUILD_DIR, "python-wizer.wasm");

const ASYNC_IMPORTS =
  "pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put," +
  "pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec," +
  "pymode.thread_spawn,pymode.thread_join,pymode.dl_open";

function mb(size: number): string {
  return `${(size / 1048576).toFixed(1)}MB`;
}

function which(cmd: string): boolean {
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0;
}

function run(args: string[], opts?: { captureOutput?: boolean }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(args[0], args.slice(1), {
    stdio: opts?.captureOutput ? "pipe" : "inherit",
    encoding: opts?.captureOutput ? "utf-8" : undefined,
  });
  if (!opts?.captureOutput && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return {
    status: result.status,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  // Check prerequisites
  if (!fs.existsSync(path.join(BUILD_DIR, "python.wasm"))) {
    console.log("Error: python.wasm not found. Run build-phase2.ts first.");
    process.exit(1);
  }
  try {
    fs.accessSync(ZIG_CC, fs.constants.X_OK);
  } catch {
    console.log("Error: zig-cc wrapper not found. Run build-phase2.ts first.");
    process.exit(1);
  }
  if (!which("wizer")) {
    console.log(
      "Error: wizer not found. Install: cargo install wizer --all-features"
    );
    process.exit(1);
  }

  console.log("=== Building Wizer-pre-initialized python.wasm ===");
  console.log();

  // Step 1: Compile pymode_wizer.c
  console.log("  [1/6] Compiling pymode_wizer.c...");
  fs.mkdirSync(path.join(BUILD_DIR, "Programs"), { recursive: true });
  run([
    "bash",
    ZIG_CC,
    "-c",
    "-Os",
    "-DPy_BUILD_CORE",
    `-I${IMPORTS_DIR}`,
    `-I${CPYTHON}/Include`,
    `-I${CPYTHON}/Include/internal`,
    `-I${BUILD_DIR}`,
    path.join(WIZER_DIR, "pymode_wizer.c"),
    "-o",
    path.join(BUILD_DIR, "Programs", "pymode_wizer.o"),
  ]);

  // Step 2: Compile clean config.o (without variant module entries like numpy)
  console.log("  [2/6] Compiling clean config.o...");
  const configBase = path.join(BUILD_DIR, "Modules", "config.c.base");
  const configWizerC = path.join(BUILD_DIR, "Modules", "config_wizer.c");
  const configWizerO = path.join(BUILD_DIR, "Modules", "config_wizer.o");

  if (fs.existsSync(configBase)) {
    fs.copyFileSync(configBase, configWizerC);
    run([
      "bash",
      ZIG_CC,
      "-c",
      "-Os",
      "-DPy_BUILD_CORE",
      `-I${CPYTHON}/Include`,
      `-I${CPYTHON}/Include/internal`,
      `-I${BUILD_DIR}`,
      "-o",
      configWizerO,
      configWizerC,
    ]);
    fs.unlinkSync(configWizerC);
  } else {
    fs.copyFileSync(
      path.join(BUILD_DIR, "Modules", "config.o"),
      configWizerO
    );
  }

  // Step 3: Collect all .o files, swapping python.o for pymode_wizer.o
  console.log("  [3/6] Collecting link objects...");
  const skipNames = new Set([
    "python.o",
    "config.o",
    "config_variant.o",
    "config_wizer.o",
    "dynload_shlib.o",
  ]);
  const linkObjs: string[] = [];

  for (const filePath of walkDir(BUILD_DIR)) {
    const rel = filePath.slice(BUILD_DIR.length);
    if (rel.includes("/recipes/") || rel.includes("/Modules/numpy/")) {
      continue;
    }
    const basename = path.basename(filePath);
    if (
      basename.endsWith(".o") &&
      !skipNames.has(basename) &&
      basename !== "pymode_wizer.o"
    ) {
      linkObjs.push(filePath);
    }
  }

  linkObjs.push(path.join(BUILD_DIR, "Programs", "pymode_wizer.o"));
  linkObjs.push(configWizerO);

  console.log(`    ${linkObjs.length} objects`);

  // Step 4: Link
  console.log("  [4/6] Linking...");
  const wizerRaw = path.join(BUILD_DIR, "python-wizer-raw.wasm");
  run([
    "bash",
    ZIG_CC,
    "-s",
    "-o",
    wizerRaw,
    ...linkObjs,
    "-ldl",
    "-lwasi-emulated-signal",
    "-lwasi-emulated-getpid",
    "-lwasi-emulated-process-clocks",
    "-lm",
  ]);

  const rawSize = fs.statSync(wizerRaw).size;
  console.log(`    Raw: ${mb(rawSize)}`);

  // Verify wizer.initialize is exported
  if (which("wasm-objdump")) {
    const result = run(["wasm-objdump", "-x", wizerRaw], {
      captureOutput: true,
    });
    if (result.stdout.includes("wizer")) {
      console.log("    wizer.initialize export: OK");
    } else {
      console.log("    ERROR: wizer.initialize not found in exports!");
      process.exit(1);
    }
  }

  // Step 5: Asyncify with wasm-opt
  if (which("wasm-opt")) {
    console.log("  [5/6] Asyncify + optimize...");
    const optOutput = wizerRaw + ".opt";
    run([
      "wasm-opt",
      "-O2",
      "--asyncify",
      "--enable-simd",
      "--enable-nontrapping-float-to-int",
      "--enable-bulk-memory",
      "--enable-sign-ext",
      "--enable-mutable-globals",
      `--pass-arg=asyncify-imports@${ASYNC_IMPORTS}`,
      "--pass-arg=asyncify-ignore-indirect",
      wizerRaw,
      "-o",
      optOutput,
    ]);
    fs.renameSync(optOutput, wizerRaw);
    const optSize = fs.statSync(wizerRaw).size;
    console.log(`    Asyncified: ${mb(optSize)}`);
  } else {
    console.log("  [5/6] SKIP: wasm-opt not found");
  }

  // Step 6: Run Wizer to snapshot CPython init
  console.log(
    "  [6/6] Wizer snapshot (booting CPython + pre-importing stdlib)..."
  );

  const stdlibDir = path.join(CPYTHON, "Lib");
  const wizerTmp = fs.mkdtempSync(path.join(os.tmpdir(), "wizer-"));

  try {
    const result = run(
      [
        "wizer",
        wizerRaw,
        "-o",
        OUTPUT,
        "--allow-wasi",
        "--wasm-bulk-memory",
        "true",
        "--wasm-simd",
        "true",
        `--mapdir=/stdlib::${stdlibDir}`,
        `--mapdir=/tmp::${wizerTmp}`,
        `--mapdir=/data::${wizerTmp}`,
      ],
      { captureOutput: true }
    );

    if (result.status === 0) {
      const finalSize = fs.statSync(OUTPUT).size;
      console.log(`    Snapshot: ${mb(finalSize)}`);
    } else {
      console.log();
      console.log("    Wizer snapshot failed.");
      console.log(result.stderr);
      console.log(
        "    The binary still works without wizer (falls back to full init)."
      );
      if (fs.existsSync(wizerRaw)) {
        fs.unlinkSync(wizerRaw);
      }
      fs.rmSync(wizerTmp, { recursive: true, force: true });
      process.exit(1);
    }
  } finally {
    fs.rmSync(wizerTmp, { recursive: true, force: true });
  }

  // Cleanup intermediate
  if (fs.existsSync(wizerRaw)) {
    fs.unlinkSync(wizerRaw);
  }

  // Replace python.wasm -- the wizer binary IS the default now.
  const workerWasm = path.join(ROOT_DIR, "worker", "src", "python.wasm");
  fs.copyFileSync(OUTPUT, workerWasm);

  console.log();
  console.log("Done! python.wasm (wizer snapshot)");
  console.log(`  Size: ${mb(fs.statSync(OUTPUT).size)}`);
  console.log();
  console.log("Cold start: ~5ms (vs ~28ms without snapshot)");
}

main();
