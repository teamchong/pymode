#!/usr/bin/env npx tsx
/**
 * Bundle pure Python packages from PyPI into a site-packages.zip.
 *
 * Downloads wheel files from PyPI, extracts .py files, and creates a zip
 * archive that Python's built-in zipimport can load directly.
 *
 * Usage:
 *     npx tsx scripts/bundle-packages.ts requirements.txt
 *     npx tsx scripts/bundle-packages.ts click==8.1.7 jinja2 requests
 *
 * The output zip is placed at worker/src/site-packages.zip and can be
 * loaded by adding it to PYTHONPATH.
 *
 * npm dependencies: none (uses Node.js built-in APIs only)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, crc32 } from "node:zlib";

// ---------------------------------------------------------------------------
// Minimal ZIP reader (for .whl files) and ZIP_STORED writer
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Read entries from a ZIP archive (supports STORED and DEFLATED via zlib).
 * Wheels are typically DEFLATED, so we handle both.
 */
function readZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];

  // Find End of Central Directory record (search from end)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (
      buf.readUInt32LE(i) === 0x06054b50 // EOCD signature
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Not a valid ZIP file (no EOCD)");

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdEntries = buf.readUInt16LE(eocdOffset + 8);

  let pos = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Bad central directory signature at ${pos}`);
    }
    const compressionMethod = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8");

    // Read from local file header to get actual data offset
    const localPos = localHeaderOffset;
    if (buf.readUInt32LE(localPos) !== 0x04034b50) {
      throw new Error(`Bad local file header at ${localPos}`);
    }
    const localNameLen = buf.readUInt16LE(localPos + 26);
    const localExtraLen = buf.readUInt16LE(localPos + 28);
    const dataStart = localPos + 30 + localNameLen + localExtraLen;

    let data: Buffer;
    if (compressionMethod === 0) {
      // STORED
      data = Buffer.from(buf.subarray(dataStart, dataStart + uncompressedSize));
    } else if (compressionMethod === 8) {
      // DEFLATED - use Node's zlib (raw deflate, no header)
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      data = inflateRawSync(compressed) as Buffer;
    } else {
      // Skip unsupported compression methods
      pos += 46 + nameLen + extraLen + commentLen;
      continue;
    }

    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Write a ZIP_STORED archive (no compression).
 * CPython's zipimport needs zlib to decompress, and zlib is disabled
 * in our WASM build, so we must use STORED.
 */
function writeZipStored(files: [string, Buffer][]): Buffer {
  if (files.length > 0xffff) throw new Error(`Too many ZIP entries (${files.length} > 65535)`);
  const localHeaders: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, "utf-8");

    // CRC-32
    const crc = crc32(data) >>> 0;

    // Local file header (30 + nameLen)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // compression: STORED
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14); // crc32
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);

    localHeaders.push(local, data);

    // Central directory entry (46 + nameLen)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // compression: STORED
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16); // crc32
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBytes.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    centralEntries.push(central);
    offset += local.length + data.length;
  }

  const cdOffset = offset;
  const cdSize = centralEntries.reduce((s, b) => s + b.length, 0);

  // End of central directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // CD size
  eocd.writeUInt32LE(cdOffset, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, ...centralEntries, eocd]);
}

// ---------------------------------------------------------------------------
// PyPI + wheel extraction
// ---------------------------------------------------------------------------

interface PyPIWheelInfo {
  url: string;
  filename: string;
}

async function getPypiWheelUrl(packageSpec: string): Promise<PyPIWheelInfo> {
  let name: string;
  let version: string | null;

  if (packageSpec.includes("==")) {
    [name, version] = packageSpec.split("==", 2);
  } else {
    name = packageSpec;
    version = null;
  }

  const apiUrl = version
    ? `https://pypi.org/pypi/${name}/${version}/json`
    : `https://pypi.org/pypi/${name}/json`;

  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    throw new Error(`PyPI returned ${resp.status} for ${packageSpec}`);
  }
  const data = await resp.json();
  const urls: any[] = data.urls;

  // Find a pure Python wheel (py3-none-any or py2.py3-none-any)
  for (const entry of urls) {
    if (entry.packagetype === "bdist_wheel") {
      const fname: string = entry.filename;
      if (fname.includes("none-any")) {
        return { url: entry.url, filename: fname };
      }
    }
  }

  // Fall back to any wheel
  for (const entry of urls) {
    if (entry.packagetype === "bdist_wheel") {
      return { url: entry.url, filename: entry.filename };
    }
  }

  throw new Error(
    `No wheel found for ${packageSpec}. ` +
      `Available: ${JSON.stringify(urls.map((u: any) => u.packagetype))}`
  );
}

const INCLUDE_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".typed",
  ".txt",
  ".cfg",
  ".ini",
  ".json",
  ".toml",
]);

function extractPyFromWheel(wheelData: Buffer): [string, Buffer][] {
  const files: [string, Buffer][] = [];
  const entries = readZip(wheelData);

  for (const { name, data } of entries) {
    // Skip .dist-info metadata
    if (name.includes(".dist-info/")) continue;
    // Skip compiled extensions
    if (
      name.endsWith(".so") ||
      name.endsWith(".pyd") ||
      name.endsWith(".dll") ||
      name.endsWith(".dylib")
    )
      continue;
    // Skip __pycache__
    if (name.includes("__pycache__/")) continue;
    // Skip directories
    if (name.endsWith("/")) continue;

    const ext = path.extname(name);
    if (INCLUDE_EXTENSIONS.has(ext)) {
      files.push([name, data]);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Requirements parsing
// ---------------------------------------------------------------------------

function parseRequirements(filePath: string): string[] {
  const packages: string[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  for (let line of content.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    // Strip extras, environment markers
    const spec = line.split(";")[0].trim();
    if (spec) packages.push(spec);
  }
  return packages;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Simple arg parsing
  let outputPath: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--output") {
      outputPath = args[++i];
    } else if (args[i] === "-h" || args[i] === "--help") {
      console.log(
        "Usage: npx tsx scripts/bundle-packages.ts [-o OUTPUT] PACKAGE_OR_REQUIREMENTS..."
      );
      console.log(
        "  e.g. npx tsx scripts/bundle-packages.ts click==8.1.7 jinja2"
      );
      console.log(
        "  e.g. npx tsx scripts/bundle-packages.ts requirements.txt"
      );
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
    console.error(
      "Usage: npx tsx scripts/bundle-packages.ts [-o OUTPUT] PACKAGE_OR_REQUIREMENTS..."
    );
    process.exit(1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.dirname(scriptDir);
  const output =
    outputPath ?? path.join(rootDir, "worker", "src", "site-packages.zip");

  // Collect all package specs
  const allPackages: string[] = [];
  for (const pkg of positional) {
    if (pkg.endsWith(".txt") && fs.existsSync(pkg)) {
      allPackages.push(...parseRequirements(pkg));
    } else {
      allPackages.push(pkg);
    }
  }

  console.log(`Bundling ${allPackages.length} packages...`);

  // Download and extract each package
  const allFiles = new Map<string, Buffer>();
  for (const spec of allPackages) {
    try {
      const { url, filename } = await getPypiWheelUrl(spec);
      console.log(`  ${spec} -> ${filename}`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${url}`);
      const wheelData = Buffer.from(await resp.arrayBuffer());
      const files = extractPyFromWheel(wheelData);
      for (const [filePath, content] of files) {
        allFiles.set(filePath, content);
      }
      console.log(`    ${files.length} files extracted`);
    } catch (e: any) {
      console.error(`  ERROR: ${spec}: ${e.message}`);
      process.exit(1);
    }
  }

  // Create the output zip (ZIP_STORED)
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const sortedFiles: [string, Buffer][] = [...allFiles.entries()].sort(
    (a, b) => a[0].localeCompare(b[0])
  );
  const zipData = writeZipStored(sortedFiles);
  fs.writeFileSync(output, zipData);

  const sizeKb = Math.floor(fs.statSync(output).size / 1024);
  console.log(`\nCreated ${output}`);
  console.log(`  ${allFiles.size} files, ${sizeKb}KB`);
  console.log(`\nTo use: add site-packages.zip to PYTHONPATH in worker.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
