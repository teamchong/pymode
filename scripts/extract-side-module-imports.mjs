#!/usr/bin/env node
/**
 * Extract symbol names a side-module .wasm needs from main python.wasm.
 *
 * Output: a newline-delimited list of symbol names, intended to be turned
 * into `-Wl,--export-if-defined=<name>` flags during the phase-2 link of
 * python.wasm. Symbols that aren't actually defined in python.wasm are
 * silently ignored by wasm-ld (which is why we use the "-if-defined" form).
 *
 * Usage:  node extract-side-module-imports.mjs <module.wasm> [more.wasm...]
 * Output: lines to stdout
 */

import fs from "node:fs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: extract-side-module-imports.mjs <wasm> [wasm...]");
  process.exit(2);
}

// Minimal wasm parser — only the import section is needed.
function parseImports(bytes) {
  if (bytes.byteLength < 8) throw new Error("not a wasm file");
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("missing wasm magic");
  }
  let pos = 8;

  function readULEB() {
    let result = 0, shift = 0, byte;
    do {
      byte = bytes[pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  function readBytes(n) {
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  }
  function readString() {
    const len = readULEB();
    const out = new TextDecoder().decode(readBytes(len));
    return out;
  }

  const imports = [];
  while (pos < bytes.byteLength) {
    const sectionId = bytes[pos++];
    const sectionSize = readULEB();
    const sectionEnd = pos + sectionSize;
    if (sectionId !== 2) {
      pos = sectionEnd;
      continue;
    }
    const count = readULEB();
    for (let i = 0; i < count; i++) {
      const mod = readString();
      const name = readString();
      const kind = bytes[pos++];
      // skip the type-specific descriptor — we only need module+name
      if (kind === 0) {
        readULEB(); // typeidx
      } else if (kind === 1) {
        // tabletype: elemtype (1 byte) + limits
        pos++;
        const limFlag = bytes[pos++];
        readULEB();
        if (limFlag & 1) readULEB();
      } else if (kind === 2) {
        // memtype: limits
        const limFlag = bytes[pos++];
        readULEB();
        if (limFlag & 1) readULEB();
      } else if (kind === 3) {
        // globaltype: valtype (1 byte) + mut (1 byte)
        pos += 2;
      } else {
        throw new Error(`unknown import kind ${kind}`);
      }
      imports.push({ module: mod, name, kind });
    }
    pos = sectionEnd;
    break; // import section is unique
  }
  return imports;
}

const symbols = new Set();
for (const path of args) {
  const buf = fs.readFileSync(path);
  const imports = parseImports(new Uint8Array(buf));
  for (const imp of imports) {
    // env.<func/global>: include function names and named globals (not memory/table)
    if (imp.module === "env") {
      if (imp.name === "memory" || imp.name === "__indirect_function_table") continue;
      if (imp.name === "__stack_pointer" || imp.name === "__memory_base" || imp.name === "__table_base") {
        // These are runtime-synthesized by the dynamic linker; main wasm only needs to export __stack_pointer.
        if (imp.name === "__stack_pointer") symbols.add(imp.name);
        continue;
      }
      symbols.add(imp.name);
    } else if (imp.module === "GOT.func" || imp.module === "GOT.mem") {
      symbols.add(imp.name);
    }
  }
}

// Filter out symbols that won't be in main wasm regardless of flags:
//   - C++ ABI symbols (libstdc++/libcxxabi) — start with _Z or __cxa
//   - libc++ internal — start with _ZNSt
// The dynamic linker on the JS side stubs these (so the side module
// instantiates but raises at call time if numpy actually invokes them).
function isUnavailable(s) {
  // C++ ABI symbols (libstdc++ / libc++abi) — Itanium mangling starts with
  // _Z followed by any char. Examples: _Znwm (operator new), _ZdlPvm
  // (operator delete), _ZNSt9bad_allocD1Ev (std::bad_alloc destructor),
  // _ZTI* (typeinfo), _ZTV* (vtable). None of these are in main wasm
  // because we don't link libc++; numpy will run without them so long as
  // it doesn't actually invoke C++ exception machinery.
  if (s.startsWith("_Z")) return true;
  // C++ ABI runtime helpers
  if (s.startsWith("__cxa_")) return true;
  if (s.startsWith("__cxx_")) return true;
  return false;
}

for (const s of [...symbols].sort()) {
  if (isUnavailable(s)) continue;
  console.log(s);
}
