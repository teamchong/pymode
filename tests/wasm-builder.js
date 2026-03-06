/**
 * Minimal WASM binary builder for tests.
 * Constructs valid .wasm binaries without external tools.
 */

function encodeULEB128(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function encodeString(str) {
  const encoded = new TextEncoder().encode(str);
  return [...encodeULEB128(encoded.length), ...encoded];
}

function section(id, contents) {
  return [id, ...encodeULEB128(contents.length), ...contents];
}

/**
 * Build a main module with memory, indirect function table, and _start export.
 * Simulates what python.wasm exports.
 */
export function buildMainModuleBytes() {
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, // magic
    0x01, 0x00, 0x00, 0x00, // version

    // Type section: 1 type () -> ()
    ...section(1, [
      1,          // 1 type
      0x60, 0, 0, // func () -> ()
    ]),

    // Function section: 1 function of type 0
    ...section(3, [1, 0]),

    // Table section: 1 table, funcref, limits min=1
    ...section(4, [
      1,    // 1 table
      0x70, // funcref
      0x00, // limits: flags (no max)
      1,    // min = 1
    ]),

    // Memory section: 1 memory, min=1 page
    ...section(5, [1, 0x00, 1]),

    // Export section: 3 exports
    ...section(7, [
      3, // 3 exports
      // "memory" -> memory 0
      ...encodeString("memory"), 0x02, 0,
      // "__indirect_function_table" -> table 0
      ...encodeString("__indirect_function_table"), 0x01, 0,
      // "_start" -> func 0
      ...encodeString("_start"), 0x00, 0,
    ]),

    // Code section: 1 function body (empty)
    ...section(10, [
      1,          // 1 body
      2,          // body size
      0,          // 0 locals
      0x0b,       // end
    ]),
  ];
  return new Uint8Array(bytes);
}

/**
 * Build a side module that imports env.memory and exports "PyInit_test" -> i32.
 * The function returns 42.
 */
export function buildSideModuleBytes() {
  const bytes = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,

    // Type section: 1 type () -> i32
    ...section(1, [
      1,             // 1 type
      0x60, 0, 1, 0x7f, // func () -> (i32)
    ]),

    // Import section: import env.memory
    ...section(2, [
      1, // 1 import
      ...encodeString("env"),
      ...encodeString("memory"),
      0x02, // memory
      0x00, // limits: no max
      1,    // min = 1
    ]),

    // Function section: 1 function of type 0
    ...section(3, [1, 0]),

    // Export section: 1 export "PyInit_test" -> func 0
    ...section(7, [
      1,
      ...encodeString("PyInit_test"), 0x00, 0,
    ]),

    // Code section: 1 function body (i32.const 42; end)
    ...section(10, [
      1,    // 1 body
      4,    // body size
      0,    // 0 locals
      0x41, 42, // i32.const 42
      0x0b, // end
    ]),
  ];
  return new Uint8Array(bytes);
}
