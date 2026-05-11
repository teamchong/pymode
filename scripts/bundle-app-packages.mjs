#!/usr/bin/env node
/**
 * Take a directory of unpacked packages (output of `uv pip install --target`
 * against the app's pyproject.toml deps) and produce a slim
 * `site-packages.zip` that contains the .py files + .dist-info/METADATA
 * laid out as Python's zipimport expects.
 *
 * Writes to <repo>/worker/src/site-packages.zip, replacing the test runtime's
 * 40 MB kitchen-sink bundle with whatever the app actually needs.
 *
 * Usage:  node bundle-app-packages.mjs <packages-dir> <output-zip>
 */

import fs from "node:fs";
import path from "node:path";
import { inflateRawSync, deflateRawSync, crc32 } from "node:zlib";

const [, , packagesDir, outZip] = process.argv;
if (!packagesDir || !outZip) {
  console.error("usage: bundle-app-packages.mjs <packages-dir> <output-zip>");
  process.exit(2);
}

// ─── ZIP reader (for .whl files; minimal) ─────────────────────────────────

function readZip(buf) {
  // Locate the End-of-Central-Directory record at the tail of the buffer.
  let eocdr = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdr = i; break; }
  }
  if (eocdr < 0) throw new Error("not a zip / corrupt EOCDR");
  const cdSize = buf.readUInt32LE(eocdr + 12);
  const cdOff = buf.readUInt32LE(eocdr + 16);
  const cdCount = buf.readUInt16LE(eocdr + 10);

  const out = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("CD entry sig mismatch");
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf-8");
    p += 46 + nameLen + extraLen + commentLen;

    // Read local header to find data start
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = compMethod === 0 ? raw : inflateRawSync(raw);
    if (data.length !== uncompSize) {
      // Some wheels have inconsistencies — trust uncompSize
      out.push({ name, data: data.slice(0, uncompSize) });
    } else {
      out.push({ name, data });
    }
  }
  return out;
}

// ─── ZIP writer (deflate) ─────────────────────────────────────────────────

function writeZip(files) {
  const localRecords = [];
  const centralDir = [];
  let offset = 0;

  for (const [name, raw] of files) {
    const nameBuf = Buffer.from(name, "utf-8");
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt32LE(0, 10); // mtime (zero)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localRecords.push(localHeader, nameBuf, compressed);

    const cdHeader = Buffer.alloc(46);
    cdHeader.writeUInt32LE(0x02014b50, 0);
    cdHeader.writeUInt16LE(20, 4); // version made by
    cdHeader.writeUInt16LE(20, 6); // version needed
    cdHeader.writeUInt16LE(0, 8); // flags
    cdHeader.writeUInt16LE(8, 10); // deflate
    cdHeader.writeUInt32LE(0, 12); // mtime
    cdHeader.writeUInt32LE(crc, 16);
    cdHeader.writeUInt32LE(compressed.length, 20);
    cdHeader.writeUInt32LE(raw.length, 24);
    cdHeader.writeUInt16LE(nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30); // extra len
    cdHeader.writeUInt16LE(0, 32); // comment len
    cdHeader.writeUInt16LE(0, 34); // disk no
    cdHeader.writeUInt16LE(0, 36); // internal attrs
    cdHeader.writeUInt32LE(0, 38); // external attrs
    cdHeader.writeUInt32LE(offset, 42);
    centralDir.push(cdHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const piece of centralDir) cdSize += piece.length;

  const eocdr = Buffer.alloc(22);
  eocdr.writeUInt32LE(0x06054b50, 0);
  eocdr.writeUInt16LE(0, 4); // disk
  eocdr.writeUInt16LE(0, 6); // disk with cd
  eocdr.writeUInt16LE(files.length, 8);
  eocdr.writeUInt16LE(files.length, 10);
  eocdr.writeUInt32LE(cdSize, 12);
  eocdr.writeUInt32LE(cdStart, 16);
  eocdr.writeUInt16LE(0, 20);

  return Buffer.concat([...localRecords, ...centralDir, eocdr]);
}

// ─── Wheel extraction ─────────────────────────────────────────────────────

const INCLUDE_EXT = new Set([".py", ".pyi", ".typed", ".json", ".yaml", ".yml", ".txt"]);

function extractFromWheel(buf) {
  const out = [];
  for (const { name, data } of readZip(buf)) {
    if (name.endsWith("/")) continue;
    if (name.includes("__pycache__/")) continue;
    if (name.endsWith(".so") || name.endsWith(".pyd") || name.endsWith(".dll") || name.endsWith(".dylib")) continue;
    if (name.includes(".dist-info/")) {
      // Keep only METADATA so importlib.metadata.version() works.
      if (name.endsWith("/METADATA")) out.push([name, data]);
      continue;
    }
    const ext = path.extname(name);
    if (INCLUDE_EXT.has(ext) || ext === "") out.push([name, data]);
  }
  return out;
}

// ─── Directory walker ────────────────────────────────────────────────────

const INCLUDE_DIR_EXT = new Set([".py", ".pyi", ".typed", ".json", ".yaml", ".yml", ".txt"]);
const SKIP_DIRS = new Set(["__pycache__", "bin", ".cache"]);

function walkPackagesDir(root) {
  const out = [];
  const entries = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        entries(full, rel);
        continue;
      }
      if (e.name.endsWith(".so") || e.name.endsWith(".pyd") ||
          e.name.endsWith(".dll") || e.name.endsWith(".dylib")) continue;
      if (rel.includes(".dist-info/")) {
        // For .dist-info, keep only METADATA — importlib.metadata needs it
        // for `version()` / `entry_points()`; the rest (RECORD, WHEEL,
        // INSTALLER, top_level.txt) is unused at runtime.
        if (!rel.endsWith("/METADATA")) continue;
      } else {
        const ext = path.extname(e.name);
        if (ext !== "" && !INCLUDE_DIR_EXT.has(ext)) continue;
      }
      out.push([rel, fs.readFileSync(full)]);
    }
  };
  entries(root, "");
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────

if (!fs.existsSync(packagesDir)) {
  fs.writeFileSync(outZip, writeZip([]));
  console.log(`No packages dir at ${packagesDir}; wrote empty zip to ${outZip}`);
  process.exit(0);
}

const allFiles = walkPackagesDir(packagesDir);

if (allFiles.length === 0) {
  fs.writeFileSync(outZip, writeZip([]));
  console.log(`No package files in ${packagesDir}; wrote empty zip to ${outZip}`);
  process.exit(0);
}

const zipBuf = writeZip(allFiles);
fs.mkdirSync(path.dirname(outZip), { recursive: true });
fs.writeFileSync(outZip, zipBuf);
console.log(`Packed ${allFiles.length} files → ${(zipBuf.length / 1048576).toFixed(1)} MB zip`);
console.log(`Wrote ${outZip}`);
