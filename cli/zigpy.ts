#!/usr/bin/env node
/**
 * zigpy CLI - Deploy Python handlers to Cloudflare Workers
 *
 * Usage:
 *   zigpy deploy handler.py          Deploy a Python handler
 *   zigpy build                      Build CPython WASM binary
 *   zigpy test handler.py            Test handler locally with wrangler dev
 *   zigpy bench handler.py           Benchmark cold start and request latency
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";

const USAGE = `
zigpy - Deploy Python to Cloudflare Workers via Zig-compiled CPython

Commands:
  deploy <handler.py>   Compile and deploy a Python handler to Workers
  build                 Build the CPython WASM binary
  test <handler.py>     Run handler locally with wrangler dev
  bench <handler.py>    Benchmark cold start time and request latency

Options:
  --name <name>         Worker name (default: derived from filename)
  --python-version      Show the compiled Python version
  --wasm-size           Show the WASM binary size
  -h, --help            Show this help
`;

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "deploy":
      deploy(args.slice(1));
      break;
    case "build":
      build();
      break;
    case "test":
      testLocal(args.slice(1));
      break;
    case "bench":
      benchmark(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE.trim());
      process.exit(1);
  }
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(resolve(dir, "wrangler.toml"))) return dir;
    dir = dirname(dir);
  }
  // Default to script location's parent
  return resolve(dirname(new URL(import.meta.url).pathname), "..");
}

function deploy(args: string[]): void {
  if (args.length === 0) {
    console.error("Usage: zigpy deploy <handler.py>");
    process.exit(1);
  }

  const handlerPath = resolve(args[0]);
  if (!existsSync(handlerPath)) {
    console.error(`File not found: ${handlerPath}`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const wasmPath = resolve(projectRoot, "build/python.wasm");

  // Step 1: Ensure WASM binary exists
  if (!existsSync(wasmPath)) {
    console.log("WASM binary not found. Building CPython...");
    build();
  }

  // Step 2: Compile .py to .pyc using the WASM Python
  const handlerName = basename(handlerPath, ".py");
  const buildDir = resolve(projectRoot, "build/deploy");
  mkdirSync(buildDir, { recursive: true });

  console.log(`Compiling ${handlerPath}...`);
  const pythonSh = resolve(projectRoot, "build/zig-wasi/python.sh");
  if (existsSync(pythonSh)) {
    spawnSync(pythonSh, [
      "-c",
      `import sys, py_compile; py_compile.compile(sys.argv[1], sys.argv[2])`,
      handlerPath,
      resolve(buildDir, handlerName + ".pyc"),
    ], { stdio: "inherit" });
  }

  // Step 3: Copy handler source alongside WASM
  writeFileSync(resolve(buildDir, "handler.py"), readFileSync(handlerPath));

  // Step 4: Determine worker name
  const nameIdx = args.indexOf("--name");
  const workerName = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : handlerName;

  // Step 5: Deploy with wrangler
  console.log(`Deploying as '${workerName}'...`);
  const result = spawnSync("npx", [
    "wrangler", "deploy",
    "--name", workerName,
  ], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, HANDLER: handlerName },
  });

  if (result.status !== 0) {
    console.error("Deploy failed");
    process.exit(1);
  }

  console.log(`Deployed ${workerName} successfully`);
}

function build(): void {
  const projectRoot = findProjectRoot();

  // Prefer phase 2 (zig cc) if zig is available
  const hasZig = spawnSync("zig", ["version"], { stdio: "pipe" }).status === 0;

  console.log(`Building with ${hasZig ? "zig cc" : "WASI SDK"}...`);
  const result = hasZig
    ? spawnSync("npx", ["tsx", resolve(projectRoot, "scripts/build-phase2.ts")], {
        cwd: projectRoot,
        stdio: "inherit",
      })
    : spawnSync("bash", [resolve(projectRoot, "scripts/build-phase1.sh")], {
        cwd: projectRoot,
        stdio: "inherit",
      });

  if (result.status !== 0) {
    console.error("Build failed");
    process.exit(1);
  }

  // Report size
  const wasmPath = resolve(projectRoot, "build/zig-wasi/python.wasm");
  if (existsSync(wasmPath)) {
    const stats = readFileSync(wasmPath);
    const sizeMB = (stats.length / (1024 * 1024)).toFixed(2);
    console.log(`WASM binary size: ${sizeMB} MB`);
  }
}

function testLocal(args: string[]): void {
  if (args.length === 0) {
    console.error("Usage: zigpy test <handler.py>");
    process.exit(1);
  }

  const handlerPath = resolve(args[0]);
  if (!existsSync(handlerPath)) {
    console.error(`File not found: ${handlerPath}`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const handlerName = basename(handlerPath, ".py");

  console.log(`Starting local dev server for ${handlerName}...`);
  const result = spawnSync("npx", [
    "wrangler", "dev",
  ], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, HANDLER: handlerName },
  });

  process.exit(result.status ?? 1);
}

function benchmark(args: string[]): void {
  if (args.length === 0) {
    console.error("Usage: zigpy bench <handler.py>");
    process.exit(1);
  }

  const handlerPath = resolve(args[0]);
  if (!existsSync(handlerPath)) {
    console.error(`File not found: ${handlerPath}`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot();
  const wasmPath = resolve(projectRoot, "build/zig-wasi/python.wasm");

  if (!existsSync(wasmPath)) {
    console.error("WASM binary not found. Run 'zigpy build' first.");
    process.exit(1);
  }

  // Report WASM size
  const stats = readFileSync(wasmPath);
  const sizeMB = (stats.length / (1024 * 1024)).toFixed(2);
  console.log(`WASM size: ${sizeMB} MB`);

  // Measure cold start: time to instantiate WASM + Py_Initialize
  const pythonSh = resolve(projectRoot, "build/zig-wasi/python.sh");
  if (existsSync(pythonSh)) {
    console.log("\nMeasuring cold start (WASI via wasmtime)...");
    const iterations = 5;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      spawnSync(pythonSh, ["-c", "pass"], { stdio: "pipe" });
      const elapsed = performance.now() - start;
      times.push(elapsed);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log(`  Cold start: avg=${avg.toFixed(0)}ms min=${min.toFixed(0)}ms max=${max.toFixed(0)}ms (${iterations} runs)`);

    // Measure a simple json.loads call
    console.log("\nMeasuring json.loads performance...");
    const jsonTimes: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      spawnSync(pythonSh, [
        "-c",
        "import json; [json.loads('{\"a\":1,\"b\":[1,2,3],\"c\":{\"d\":true}}') for _ in range(1000)]",
      ], { stdio: "pipe" });
      const elapsed = performance.now() - start;
      jsonTimes.push(elapsed);
    }

    const jsonAvg = jsonTimes.reduce((a, b) => a + b, 0) / jsonTimes.length;
    console.log(`  1000x json.loads: avg=${jsonAvg.toFixed(0)}ms (${iterations} runs)`);
  }
}

main();
