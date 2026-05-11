#!/usr/bin/env node
/**
 * Restore exports stripped by Wizer.
 *
 * Wizer always reduces the export section to `_start` (and optionally the
 * init function), discarding every other export. We need many of them at
 * runtime — `__indirect_function_table`, `__stack_pointer`, libc/libpython
 * functions for the dynamic linker — so this script:
 *
 *   1. Reads pre-wizer python.wasm, captures `{name → (kind, index)}` for
 *      every export.
 *   2. Reads post-wizer python.wasm, identifies which imports Wizer
 *      removed (some unused WASI fns get dropped).
 *   3. Computes new function indices: each removed import shifts all
 *      later function indices down by 1. Globals/tables/memories are in
 *      separate index spaces and unaffected.
 *   4. Rewrites the post-wizer export section with all the pre-wizer
 *      exports remapped.
 *
 * Usage: wizer-restore-exports.mjs <pre-wizer.wasm> <post-wizer.wasm> <output.wasm>
 */

import fs from "node:fs";

const [, , prePath, postPath, outPath] = process.argv;
if (!prePath || !postPath || !outPath) {
  console.error("usage: wizer-restore-exports.mjs <pre.wasm> <post.wasm> <out.wasm>");
  process.exit(2);
}

// ─────────────────────────────────────────── ULEB / SLEB / strings

function readULEB(buf, posRef) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[posRef.pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}
function writeULEB(value) {
  const out = [];
  while (true) {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) out.push(byte | 0x80);
    else { out.push(byte); break; }
  }
  return out;
}
function readString(buf, posRef) {
  const len = readULEB(buf, posRef);
  const s = new TextDecoder().decode(buf.subarray(posRef.pos, posRef.pos + len));
  posRef.pos += len;
  return s;
}
function writeString(s) {
  const enc = new TextEncoder().encode(s);
  return [...writeULEB(enc.length), ...enc];
}

// ─────────────────────────────────────────── Wasm section walker

const SEC_CUSTOM = 0, SEC_TYPE = 1, SEC_IMPORT = 2, SEC_FUNCTION = 3,
      SEC_TABLE = 4, SEC_MEMORY = 5, SEC_GLOBAL = 6, SEC_EXPORT = 7;

const KIND_FUNC = 0, KIND_TABLE = 1, KIND_MEMORY = 2, KIND_GLOBAL = 3;

function* walkSections(buf) {
  const posRef = { pos: 8 };
  while (posRef.pos < buf.byteLength) {
    const sectionStart = posRef.pos;
    const id = buf[posRef.pos++];
    const size = readULEB(buf, posRef);
    const contentStart = posRef.pos;
    const contentEnd = contentStart + size;
    yield { id, sectionStart, contentStart, contentEnd, totalEnd: contentEnd };
    posRef.pos = contentEnd;
  }
}

function readImports(buf) {
  for (const sec of walkSections(buf)) {
    if (sec.id !== SEC_IMPORT) continue;
    const posRef = { pos: sec.contentStart };
    const count = readULEB(buf, posRef);
    const imports = [];
    for (let i = 0; i < count; i++) {
      const mod = readString(buf, posRef);
      const name = readString(buf, posRef);
      const kind = buf[posRef.pos++];
      if (kind === KIND_FUNC) readULEB(buf, posRef);
      else if (kind === KIND_TABLE) {
        posRef.pos++; // elemtype
        const limFlag = buf[posRef.pos++];
        readULEB(buf, posRef);
        if (limFlag & 1) readULEB(buf, posRef);
      } else if (kind === KIND_MEMORY) {
        const limFlag = buf[posRef.pos++];
        readULEB(buf, posRef);
        if (limFlag & 1) readULEB(buf, posRef);
      } else if (kind === KIND_GLOBAL) {
        posRef.pos += 2;
      }
      imports.push({ mod, name, kind });
    }
    return imports;
  }
  return [];
}

function readExports(buf) {
  for (const sec of walkSections(buf)) {
    if (sec.id !== SEC_EXPORT) continue;
    const posRef = { pos: sec.contentStart };
    const count = readULEB(buf, posRef);
    const exports = [];
    for (let i = 0; i < count; i++) {
      const name = readString(buf, posRef);
      const kind = buf[posRef.pos++];
      const idx = readULEB(buf, posRef);
      exports.push({ name, kind, idx });
    }
    return exports;
  }
  return [];
}

// ─────────────────────────────────────────── Main

const pre = new Uint8Array(fs.readFileSync(prePath));
const post = new Uint8Array(fs.readFileSync(postPath));

const preImports = readImports(pre);
const postImports = readImports(post);
const preExports = readExports(pre);
const postExports = readExports(post);

// Identify removed imports — match by (mod, name, kind). Build a list of
// pre-import indices that survived in post, in order. For function
// imports, this gives us the func-index remap.
const postImportKey = new Set(postImports.map(i => `${i.mod}\0${i.name}\0${i.kind}`));
const preFuncImports = preImports.filter(i => i.kind === KIND_FUNC);
const removedFuncImportPreIndices = [];
let preFuncIdx = 0;
for (const i of preImports) {
  if (i.kind === KIND_FUNC) {
    const key = `${i.mod}\0${i.name}\0${i.kind}`;
    if (!postImportKey.has(key)) {
      removedFuncImportPreIndices.push(preFuncIdx);
    }
    preFuncIdx++;
  }
}
// Same for globals (less likely to be removed but be safe)
const preGlobalImports = preImports.filter(i => i.kind === KIND_GLOBAL);
const removedGlobalImportPreIndices = [];
let preGlobalIdx = 0;
for (const i of preImports) {
  if (i.kind === KIND_GLOBAL) {
    const key = `${i.mod}\0${i.name}\0${i.kind}`;
    if (!postImportKey.has(key)) {
      removedGlobalImportPreIndices.push(preGlobalIdx);
    }
    preGlobalIdx++;
  }
}

function remapIndex(preIdx, removedPreIndices) {
  let drops = 0;
  for (const r of removedPreIndices) {
    if (r < preIdx) drops++;
  }
  return preIdx - drops;
}

// Build the final export list: start from post exports, add anything in
// pre that isn't already in post (after remapping indices).
const finalExports = new Map();
for (const exp of postExports) finalExports.set(exp.name, exp);

for (const exp of preExports) {
  if (finalExports.has(exp.name)) continue;
  let newIdx = exp.idx;
  if (exp.kind === KIND_FUNC) newIdx = remapIndex(exp.idx, removedFuncImportPreIndices);
  else if (exp.kind === KIND_GLOBAL) newIdx = remapIndex(exp.idx, removedGlobalImportPreIndices);
  // KIND_TABLE / KIND_MEMORY: unchanged (none were removed)
  finalExports.set(exp.name, { name: exp.name, kind: exp.kind, idx: newIdx });
}

console.log(`pre exports: ${preExports.length}, post exports: ${postExports.length}, final exports: ${finalExports.size}`);
console.log(`removed func imports: ${removedFuncImportPreIndices.length}, removed global imports: ${removedGlobalImportPreIndices.length}`);

// Encode new export section
const newExportBytes = [];
newExportBytes.push(...writeULEB(finalExports.size));
for (const exp of finalExports.values()) {
  newExportBytes.push(...writeString(exp.name));
  newExportBytes.push(exp.kind);
  newExportBytes.push(...writeULEB(exp.idx));
}
const newExportSection = [
  SEC_EXPORT,
  ...writeULEB(newExportBytes.length),
  ...newExportBytes,
];

// Rebuild the table section without a max — zig's wasm-ld wrapper rejects
// --growable-table, so we mark each defined table as growable here. Each
// table entry in the section is: reftype (1 byte) + limits.
// limits = flag (1 byte) + initial (uleb) + [max (uleb) if flag&1].
// Setting flag = 0 removes the max so WebAssembly.Table.grow() succeeds.
function rebuildTableSection(buf, contentStart, contentEnd) {
  const posRef = { pos: contentStart };
  const count = readULEB(buf, posRef);
  const tableEntries = [];
  for (let i = 0; i < count; i++) {
    const reftype = buf[posRef.pos++];
    const limFlag = buf[posRef.pos++];
    const initial = readULEB(buf, posRef);
    if (limFlag & 1) {
      readULEB(buf, posRef); // discard original max
    }
    tableEntries.push({ reftype, initial });
  }
  const out = [];
  out.push(...writeULEB(count));
  for (const e of tableEntries) {
    out.push(e.reftype);
    out.push(0); // limits flag = 0 → no max → growable
    out.push(...writeULEB(e.initial));
  }
  return new Uint8Array(out);
}

// Walk post wasm and replace the export section. Use an array of Uint8Array
// chunks rather than pushing per-byte — for a 70MB binary, per-byte pushes
// + spread of a 200KB+ export section blow the call stack.
const chunks = [];
chunks.push(post.subarray(0, 8));

let replaced = false;
for (const sec of walkSections(post)) {
  if (sec.id === SEC_EXPORT) {
    chunks.push(new Uint8Array(newExportSection));
    replaced = true;
  } else if (sec.id === SEC_TABLE) {
    const newTableBody = rebuildTableSection(post, sec.contentStart, sec.contentEnd);
    const sectionBytes = [SEC_TABLE, ...writeULEB(newTableBody.byteLength), ...newTableBody];
    chunks.push(new Uint8Array(sectionBytes));
  } else {
    chunks.push(post.subarray(sec.sectionStart, sec.totalEnd));
  }
}
if (!replaced) {
  throw new Error("post-wizer module has no export section");
}

const totalLen = chunks.reduce((n, c) => n + c.byteLength, 0);
const merged = new Uint8Array(totalLen);
let offset = 0;
for (const c of chunks) {
  merged.set(c, offset);
  offset += c.byteLength;
}

fs.writeFileSync(outPath, merged);
console.log(`Wrote ${outPath} (${merged.byteLength} bytes)`);
