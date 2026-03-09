#!/usr/bin/env npx tsx
/**
 * pymode install -- package manager for PyMode Workers.
 *
 * Resolves Python packages from PyPI, classifies them (pure Python vs
 * C extension), and bundles them for deployment on Cloudflare Workers.
 *
 * Pure Python packages are bundled into site-packages.zip.
 * C extensions are compiled to .wasm side modules via zig cc.
 * Packages too large for a single worker are flagged for Service Bindings.
 *
 * Usage:
 *     npx tsx scripts/pymode-install.ts jinja2 click pyyaml
 *     npx tsx scripts/pymode-install.ts -r requirements.txt
 *     npx tsx scripts/pymode-install.ts --from-pyproject ./my-project
 *
 * Output:
 *     worker/src/site-packages.zip     -- pure Python packages
 *     .pymode/extensions/<pkg>/*.wasm  -- C extension side modules
 *     .pymode/install.json             -- install manifest
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max compressed size for a single worker (10MB). We reserve ~3MB for
 * python.wasm + stdlib + pymode runtime, leaving ~7MB for user code + packages. */
const WORKER_BUDGET_BYTES = 7 * 1024 * 1024;

/** C extension file suffixes found in wheels */
const NATIVE_SUFFIXES = [".so", ".pyd", ".dll", ".dylib"];

/** Known pure-Python packages that ship with C speedups but have Python fallbacks */
const PURE_PYTHON_FALLBACKS = new Set([
  "markupsafe",
  "pyyaml",
  "simplejson",
  "msgpack",
  "charset-normalizer",
  "multidict",
  "yarl",
  "frozenlist",
  "aiohttp",
]);

/** Packages too large for inline bundling -- need C extensions compiled to .wasm */
const NEEDS_SEPARATE_WORKER = new Set([
  "numpy",
  "pandas",
  "scipy",
  "scikit-learn",
  "sklearn",
  "matplotlib",
  "pillow",
  "opencv-python",
  "tensorflow",
  "torch",
  "pytorch",
  "transformers",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageInfo {
  name: string;
  version: string;
  wheelUrl: string;
  wheelFilename: string;
  isPurePython: boolean;
  hasNativeExt: boolean;
  nativeFiles: string[];
  pythonFiles: string[];
  dataFiles: string[];
  dependencies: string[];
  sizeBytes: number;
}

interface InstallResult {
  purePython: PackageInfo[];
  cExtensions: PackageInfo[];
  needsSeparateWorker: string[];
  failed: Array<[string, string]>;
  sitePackagesSize: number;
  extensionsSize: number;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader/writer using fflate if available, otherwise inline
// ---------------------------------------------------------------------------

// fflate for zip operations — initialized lazily in main()
let fflate: typeof import("fflate") | null = null;

/** CRC32 table */
const crc32Table: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Create a ZIP_STORED zip from entries. */
function createStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  if (fflate) {
    const obj: Record<string, Uint8Array> = {};
    for (const e of entries) {
      obj[e.name] = e.data;
    }
    return fflate.zipSync(obj, { level: 0 });
  }

  // Inline minimal ZIP_STORED writer
  const centralEntries: Uint8Array[] = [];
  const localParts: Uint8Array[] = [];
  let offset = 0;

  const enc = new TextEncoder();

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crcVal = crc32(data);

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // compression: stored
    lv.setUint32(14, crcVal, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    // Central directory entry
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // compression: stored
    cv.setUint32(16, crcVal, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, data);
    centralEntries.push(central);
    offset += local.length + data.length;
  }

  const centralDirOffset = offset;
  const centralParts = centralEntries;
  let centralDirSize = 0;
  for (const c of centralParts) centralDirSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirSize, true);
  ev.setUint32(16, centralDirOffset, true);

  const totalSize = offset + centralDirSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) {
    result.set(p, pos);
    pos += p.length;
  }
  for (const c of centralParts) {
    result.set(c, pos);
    pos += c.length;
  }
  result.set(eocd, pos);
  return result;
}

/** Read entries from a ZIP buffer. Returns list of [name, data]. */
function readZip(buf: Uint8Array): Array<[string, Uint8Array]> {
  if (fflate) {
    const unzipped = fflate.unzipSync(buf);
    return Object.entries(unzipped);
  }

  // Inline ZIP reader using central directory (handles STORED + DEFLATED via node:zlib)
  const results: Array<[string, Uint8Array]> = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Find End of Central Directory record
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Not a valid ZIP file (no EOCD)");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 8, true);
  const dec = new TextDecoder();

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error(`Bad central directory signature at ${pos}`);
    }
    const compression = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = dec.decode(buf.subarray(pos + 46, pos + 46 + nameLen));

    // Read data from local file header
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

    if (compression === 0) {
      results.push([name, buf.slice(dataStart, dataStart + uncompressedSize)]);
    } else if (compression === 8) {
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      const decompressed = inflateRawSync(Buffer.from(compressed));
      results.push([name, new Uint8Array(decompressed)]);
    }
    // Skip unsupported compression methods

    pos += 46 + nameLen + extraLen + commentLen;
  }

  return results;
}

// ---------------------------------------------------------------------------
// PyPI client
// ---------------------------------------------------------------------------

async function fetchPypiMetadata(packageSpec: string): Promise<any> {
  let apiUrl: string;
  if (packageSpec.includes("==")) {
    const [name, version] = packageSpec.split("==", 2);
    apiUrl = `https://pypi.org/pypi/${name}/${version}/json`;
  } else {
    const name = packageSpec.split(/[<>=!~]/)[0].trim();
    apiUrl = `https://pypi.org/pypi/${name}/json`;
  }

  const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(30000) });
  if (resp.status === 404) {
    throw new Error(`Package '${packageSpec}' not found on PyPI`);
  }
  if (!resp.ok) {
    throw new Error(`PyPI API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

function selectWheel(pypiData: any): { url: string; filename: string; version: string } {
  const version = pypiData.info.version;
  const urls: any[] = pypiData.urls;

  // Priority 1: Pure Python wheel (py3-none-any)
  for (const entry of urls) {
    if (entry.packagetype === "bdist_wheel") {
      if (entry.filename.includes("none-any")) {
        return { url: entry.url, filename: entry.filename, version };
      }
    }
  }

  // Priority 2: Any wheel
  for (const entry of urls) {
    if (entry.packagetype === "bdist_wheel") {
      return { url: entry.url, filename: entry.filename, version };
    }
  }

  // Priority 3: sdist
  for (const entry of urls) {
    if (entry.packagetype === "sdist") {
      return { url: entry.url, filename: entry.filename, version };
    }
  }

  throw new Error(`No downloadable distribution found for ${pypiData.info.name}`);
}

function getDependencies(pypiData: any): string[] {
  const deps: string[] = [];
  const requiresDist: string[] = pypiData.info.requires_dist ?? [];

  for (const dep of requiresDist) {
    // Skip optional/extra dependencies
    if (dep.includes("extra ==")) continue;

    // Skip platform-specific deps with complex markers
    if (dep.includes("; ")) {
      const marker = dep.split(";")[1].trim();
      if (marker.includes("extra")) continue;
    }

    // Extract just the package name
    const name = dep.split(/[<>=!~;\s\[]/)[0].trim();
    if (name) {
      deps.push(name.toLowerCase());
    }
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Wheel analysis
// ---------------------------------------------------------------------------

function analyzeWheel(
  wheelEntries: Array<[string, Uint8Array]>,
): { pythonFiles: string[]; nativeFiles: string[]; dataFiles: string[] } {
  const pythonFiles: string[] = [];
  const nativeFiles: string[] = [];
  const dataFiles: string[] = [];

  for (const [name] of wheelEntries) {
    if (name.includes(".dist-info/")) continue;
    if (name.includes("__pycache__/")) continue;
    if (name.endsWith("/")) continue;

    if (NATIVE_SUFFIXES.some((s) => name.endsWith(s))) {
      nativeFiles.push(name);
    } else if (name.endsWith(".py") || name.endsWith(".pyi")) {
      pythonFiles.push(name);
    } else if (
      name.endsWith(".typed") ||
      name.endsWith(".txt") ||
      name.endsWith(".cfg") ||
      name.endsWith(".ini") ||
      name.endsWith(".json") ||
      name.endsWith(".toml") ||
      name.endsWith(".yaml") ||
      name.endsWith(".yml") ||
      name.endsWith(".pem")
    ) {
      dataFiles.push(name);
    }
  }

  return { pythonFiles, nativeFiles, dataFiles };
}

function extractPythonFiles(
  wheelEntries: Array<[string, Uint8Array]>,
): Array<[string, Uint8Array]> {
  const files: Array<[string, Uint8Array]> = [];

  for (const [name, data] of wheelEntries) {
    if (name.includes("__pycache__/")) continue;
    if (name.endsWith("/")) continue;

    // Include METADATA and RECORD from dist-info
    if (name.includes(".dist-info/")) {
      const basename = name.split("/").pop()!;
      if (basename === "METADATA" || basename === "RECORD") {
        files.push([name, data]);
      }
      continue;
    }

    if (NATIVE_SUFFIXES.some((s) => name.endsWith(s))) continue;
    // Skip .pyi and .typed (not needed at runtime)
    if (name.endsWith(".pyi") || name.endsWith(".typed")) continue;

    // Skip test directories
    const parts = name.split("/");
    if (parts.some((p) => ["tests", "test", "testing", "_tests"].includes(p))) continue;

    if (
      name.endsWith(".py") ||
      name.endsWith(".txt") ||
      name.endsWith(".cfg") ||
      name.endsWith(".ini") ||
      name.endsWith(".json") ||
      name.endsWith(".toml") ||
      name.endsWith(".yaml") ||
      name.endsWith(".yml") ||
      name.endsWith(".pem")
    ) {
      files.push([name, data]);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Dependency resolution (breadth-first with cycle detection)
// ---------------------------------------------------------------------------

async function resolveDependencies(initialSpecs: string[], maxDepth = 5): Promise<string[]> {
  const resolved: Map<string, string> = new Map();
  let queue = [...initialSpecs];
  const seen = new Set<string>();
  let depth = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const nextQueue: string[] = [];
    for (const spec of queue) {
      const name = spec.split(/[<>=!~\[]/)[0].trim().toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);

      try {
        const pypiData = await fetchPypiMetadata(spec);
        resolved.set(name, spec);
        const deps = getDependencies(pypiData);
        for (const dep of deps) {
          if (!seen.has(dep)) {
            nextQueue.push(dep);
          }
        }
      } catch (e: any) {
        process.stderr.write(`  Warning: Could not resolve ${spec}: ${e.message}\n`);
      }
    }
    queue = nextQueue;
    depth++;
  }

  return Array.from(resolved.values());
}

// ---------------------------------------------------------------------------
// C extension compilation
// ---------------------------------------------------------------------------

function compileCExtension(
  pkgName: string,
  wheelEntries: Array<[string, Uint8Array]>,
  rootDir: string,
): string | null {
  const extDir = path.join(rootDir, ".pymode", "extensions", pkgName);
  fs.mkdirSync(extDir, { recursive: true });

  const cpythonDir = path.join(rootDir, "cpython");
  const buildDir = path.join(rootDir, "build", "zig-wasi");

  if (!fs.existsSync(path.join(cpythonDir, "Include"))) {
    console.log("    Skipping C compilation: cpython/Include not found");
    return null;
  }
  if (!fs.existsSync(path.join(buildDir, "pyconfig.h"))) {
    console.log("    Skipping C compilation: build/zig-wasi/pyconfig.h not found");
    return null;
  }

  try {
    execFileSync("zig", ["version"], { stdio: "pipe" });
  } catch {
    console.log("    Skipping C compilation: zig not found");
    return null;
  }

  // Extract wheel to temp dir
  const tmpDir = mkdtempSync(path.join(tmpdir(), "pymode-ext-"));
  try {
    for (const [name, data] of wheelEntries) {
      if (name.endsWith("/")) continue;
      const outPath = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, data);
    }

    // Find .c files
    const cFiles: string[] = [];
    function findC(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findC(full);
        else if (entry.isFile() && entry.name.endsWith(".c")) cFiles.push(full);
      }
    }
    findC(tmpDir);

    if (cFiles.length === 0) {
      console.log("    No .c files found in wheel");
      return null;
    }

    // Compile each .c file
    for (const cFile of cFiles) {
      const objFile = path.join(extDir, path.basename(cFile, ".c") + ".o");
      console.log(`    Compiling ${path.basename(cFile)}...`);

      let result: any;
      try {
        execFileSync(
          "zig",
          [
            "cc",
            "-target",
            "wasm32-wasi",
            "-Os",
            "-DNDEBUG",
            `-I${path.join(cpythonDir, "Include")}`,
            `-I${path.join(cpythonDir, "Include", "internal")}`,
            `-I${buildDir}`,
            "-Wno-error=int-conversion",
            "-Wno-error=incompatible-pointer-types",
            "-c",
            cFile,
            "-o",
            objFile,
          ],
          { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
        );
      } catch (e: any) {
        console.log(`    Compile failed: ${(e.stderr ?? "").slice(0, 200)}`);
        return null;
      }
    }

    // Link all objects into a single .wasm
    const objFiles = fs.readdirSync(extDir).filter((f) => f.endsWith(".o")).map((f) => path.join(extDir, f));
    if (objFiles.length === 0) return null;

    const wasmName = `${pkgName}.wasm`;
    const wasmPath = path.join(extDir, wasmName);
    console.log(`    Linking -> ${wasmName}...`);

    try {
      execFileSync(
        "zig",
        [
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
          ...objFiles,
          "-o",
          wasmPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" },
      );
    } catch (e: any) {
      console.log(`    Link failed: ${(e.stderr ?? "").slice(0, 200)}`);
      return null;
    } finally {
      // Clean up .o files
      for (const o of objFiles) {
        try {
          fs.unlinkSync(o);
        } catch {}
      }
    }

    const sizeKb = Math.floor(fs.statSync(wasmPath).size / 1024);
    console.log(`    Built: ${wasmPath} (${sizeKb}KB)`);

    return extDir;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function parseRequirementsTxt(filePath: string): string[] {
  const packages: string[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  for (let line of content.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const spec = line.split(";")[0].trim();
    if (spec) packages.push(spec);
  }
  return packages;
}

function parsePyprojectToml(projectDir: string): string[] {
  const tomlPath = path.join(projectDir, "pyproject.toml");
  if (!fs.existsSync(tomlPath)) {
    throw new Error(`No pyproject.toml in ${projectDir}`);
  }

  // Simple TOML parser for the fields we need
  const content = fs.readFileSync(tomlPath, "utf-8");
  const deps: string[] = [];

  // Extract [project].dependencies array
  const projectDeps = extractTomlArray(content, "project", "dependencies");
  deps.push(...projectDeps);

  // Also check [tool.pymode].dependencies
  const pymodeDeps = extractTomlArrayNested(content, "tool", "pymode", "dependencies");
  deps.push(...pymodeDeps);

  return deps;
}

/** Extract a string array from a TOML section like [section]\ndependencies = [...] */
function extractTomlArray(content: string, section: string, key: string): string[] {
  const sectionRe = new RegExp(`^\\[${escapeRegex(section)}\\]`, "m");
  const match = sectionRe.exec(content);
  if (!match) return [];

  const afterSection = content.slice(match.index + match[0].length);
  const nextSection = afterSection.search(/^\[/m);
  const sectionContent = nextSection >= 0 ? afterSection.slice(0, nextSection) : afterSection;

  return extractArrayValue(sectionContent, key);
}

function extractTomlArrayNested(content: string, s1: string, s2: string, key: string): string[] {
  const sectionRe = new RegExp(`^\\[${escapeRegex(s1)}\\.${escapeRegex(s2)}\\]`, "m");
  const match = sectionRe.exec(content);
  if (!match) return [];

  const afterSection = content.slice(match.index + match[0].length);
  const nextSection = afterSection.search(/^\[/m);
  const sectionContent = nextSection >= 0 ? afterSection.slice(0, nextSection) : afterSection;

  return extractArrayValue(sectionContent, key);
}

function extractArrayValue(sectionContent: string, key: string): string[] {
  const keyRe = new RegExp(`^${escapeRegex(key)}\\s*=\\s*\\[([^\\]]*)]`, "m");
  const match = keyRe.exec(sectionContent);
  if (!match) return [];

  const items: string[] = [];
  const raw = match[1];
  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/^["']|["']$/g, "");
    if (trimmed) items.push(trimmed);
  }
  return items;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main install logic
// ---------------------------------------------------------------------------

async function installPackages(
  specs: string[],
  rootDir: string,
  resolveDeps: boolean = true,
): Promise<InstallResult> {
  const result: InstallResult = {
    purePython: [],
    cExtensions: [],
    needsSeparateWorker: [],
    failed: [],
    sitePackagesSize: 0,
    extensionsSize: 0,
  };

  // Step 1: Resolve dependencies
  let allSpecs: string[];
  if (resolveDeps && specs.length > 0) {
    console.log(`\nResolving dependencies for ${specs.length} packages...`);
    allSpecs = await resolveDependencies(specs);
    console.log(`  Resolved ${allSpecs.length} packages (including dependencies)`);
  } else {
    allSpecs = specs;
  }

  // Step 2: Download and classify each package
  const allPyFiles: Map<string, Uint8Array> = new Map();
  let totalUncompressed = 0;

  for (const spec of allSpecs) {
    const name = spec.split(/[<>=!~\[]/)[0].trim().toLowerCase();

    // Check if package needs a separate worker
    if (NEEDS_SEPARATE_WORKER.has(name)) {
      console.log(`  ${name}: heavy C extension -- needs .wasm compilation (zig cc) or child DO`);
      result.needsSeparateWorker.push(name);
      continue;
    }

    try {
      process.stdout.write(`  ${spec}... `);
      const pypiData = await fetchPypiMetadata(spec);
      const { url, filename, version } = selectWheel(pypiData);
      console.log(`-> ${filename}`);

      // Download wheel
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
      const wheelData = new Uint8Array(await resp.arrayBuffer());

      // Read wheel entries
      const wheelEntries = readZip(wheelData);

      // Analyze contents
      const { pythonFiles, nativeFiles, dataFiles } = analyzeWheel(wheelEntries);
      const deps = getDependencies(pypiData);

      const pkgInfo: PackageInfo = {
        name,
        version,
        wheelUrl: url,
        wheelFilename: filename,
        isPurePython: nativeFiles.length === 0,
        hasNativeExt: nativeFiles.length > 0,
        nativeFiles,
        pythonFiles,
        dataFiles,
        dependencies: deps,
        sizeBytes: wheelData.length,
      };

      if (nativeFiles.length > 0) {
        // Has C extensions
        console.log(`    C extensions: ${nativeFiles.slice(0, 3).join(", ")}`);

        if (PURE_PYTHON_FALLBACKS.has(name)) {
          // Extract only Python files, skip native
          console.log("    Using pure Python fallback (skipping C speedups)");
          const extracted = extractPythonFiles(wheelEntries);
          for (const [p, content] of extracted) {
            allPyFiles.set(p, content);
            totalUncompressed += content.length;
          }
          result.purePython.push(pkgInfo);
        } else {
          // Try to compile C extension to WASM
          console.log("    Attempting C -> WASM compilation...");
          const extDir = compileCExtension(name, wheelEntries, rootDir);
          if (extDir) {
            result.cExtensions.push(pkgInfo);
          } else {
            // Fall back to Python files only
            console.log("    C compilation failed, extracting Python files only");
            result.purePython.push(pkgInfo);
          }

          // Always extract Python files alongside extensions
          const extracted = extractPythonFiles(wheelEntries);
          for (const [p, content] of extracted) {
            allPyFiles.set(p, content);
            totalUncompressed += content.length;
          }
        }
      } else {
        // Pure Python -- extract everything
        const extracted = extractPythonFiles(wheelEntries);
        for (const [p, content] of extracted) {
          allPyFiles.set(p, content);
          totalUncompressed += content.length;
        }
        result.purePython.push(pkgInfo);
      }
    } catch (e: any) {
      console.log(`FAILED: ${e.message}`);
      result.failed.push([spec, String(e.message ?? e)]);
    }
  }

  // Step 3: Create site-packages.zip
  if (allPyFiles.size > 0) {
    const outputDir = path.join(rootDir, "worker", "src");
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, "site-packages.zip");

    // Use ZIP_STORED (no compression) because CPython's zipimport
    // needs zlib to decompress, and zlib is disabled in our WASM build.
    const sortedEntries = Array.from(allPyFiles.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, data]) => ({ name, data }));
    const zipData = createStoredZip(sortedEntries);
    fs.writeFileSync(outputPath, zipData);

    result.sitePackagesSize = fs.statSync(outputPath).size;
    console.log(`\nCreated ${outputPath}`);
    console.log(`  ${allPyFiles.size} files, ${Math.floor(result.sitePackagesSize / 1024)}KB compressed`);
    console.log(`  ${Math.floor(totalUncompressed / 1024)}KB uncompressed`);
  }

  // Step 4: Check size budget
  if (result.sitePackagesSize > WORKER_BUDGET_BYTES) {
    console.log(
      `\n  WARNING: site-packages.zip (${Math.floor(result.sitePackagesSize / 1024)}KB) ` +
        `exceeds budget (${Math.floor(WORKER_BUDGET_BYTES / 1024)}KB)`,
    );
    console.log("  Consider splitting large packages into separate workers via Service Bindings");
  }

  // Step 5: Write install manifest
  const manifest = {
    packages: {
      pure_python: result.purePython.map((p) => ({
        name: p.name,
        version: p.version,
        files: p.pythonFiles.length,
      })),
      c_extensions: result.cExtensions.map((p) => ({
        name: p.name,
        version: p.version,
        native_files: p.nativeFiles,
      })),
      needs_separate_worker: result.needsSeparateWorker,
      failed: result.failed.map(([spec, err]) => ({ spec, error: err })),
    },
    site_packages_size_kb: Math.floor(result.sitePackagesSize / 1024),
  };

  const manifestDir = path.join(rootDir, ".pymode");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "install.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${manifestPath}`);

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Initialize fflate if available
  try {
    fflate = await import("fflate");
  } catch {
    // fflate not available, inline implementations with node:zlib will be used
  }

  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      requirements: { type: "string", short: "r" },
      "from-pyproject": { type: "string" },
      "no-deps": { type: "boolean", default: false },
      root: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: pymode-install.ts [options] [packages...]

Install Python packages for PyMode Workers deployment.

Arguments:
  packages             Package specs: jinja2, click==8.1.7, etc.

Options:
  -r, --requirements   Path to requirements.txt
  --from-pyproject     Path to project directory with pyproject.toml
  --no-deps            Don't resolve transitive dependencies
  --root               PyMode root directory (default: auto-detect)
  -h, --help           Show this help message`);
    process.exit(0);
  }

  // Detect root dir
  let rootDir: string;
  if (values.root) {
    rootDir = path.resolve(values.root);
  } else {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    rootDir = path.dirname(scriptDir);
    if (!fs.existsSync(path.join(rootDir, "worker", "wrangler.toml"))) {
      rootDir = process.cwd();
    }
  }

  // Collect package specs
  const allSpecs: string[] = [...positionals];

  if (values.requirements) {
    allSpecs.push(...parseRequirementsTxt(values.requirements));
  }

  if (values["from-pyproject"]) {
    try {
      allSpecs.push(...parsePyprojectToml(values["from-pyproject"]));
    } catch (e: any) {
      process.stderr.write(`Error reading pyproject.toml: ${e.message}\n`);
      process.exit(1);
    }
  }

  if (allSpecs.length === 0) {
    console.log(`Usage: pymode-install.ts [options] [packages...]

  npx tsx scripts/pymode-install.ts jinja2 click pyyaml
  npx tsx scripts/pymode-install.ts -r requirements.txt
  npx tsx scripts/pymode-install.ts --from-pyproject ./my-project`);
    process.exit(1);
  }

  console.log("PyMode Install");
  console.log(`  Root: ${rootDir}`);
  console.log(`  Packages: ${allSpecs.join(", ")}`);

  const result = await installPackages(allSpecs, rootDir, !values["no-deps"]);

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Install Summary");
  console.log("=".repeat(60));
  console.log(`  Pure Python:  ${result.purePython.length} packages -> site-packages.zip`);
  if (result.cExtensions.length > 0) {
    console.log(`  C Extensions: ${result.cExtensions.length} packages -> .pymode/extensions/`);
  }
  if (result.needsSeparateWorker.length > 0) {
    console.log(`  Heavy (need separate worker): ${result.needsSeparateWorker.join(", ")}`);
  }
  if (result.failed.length > 0) {
    console.log(`  Failed: ${result.failed.length}`);
    for (const [spec, err] of result.failed) {
      console.log(`    ${spec}: ${err}`);
    }
  }

  if (result.needsSeparateWorker.length > 0) {
    console.log("\n  Heavy packages need C extensions compiled to .wasm via zig cc.");
    console.log("  Or run them in a child DO via pymode.parallel.spawn():");
    console.log('  [[services]]');
    console.log('  binding = "COMPUTE"');
    console.log('  service = "compute-worker"');
  }

  console.log("\n  Next: cd worker && npx wrangler deploy");

  process.exit(result.failed.length > 0 ? 1 : 0);
}

main();
