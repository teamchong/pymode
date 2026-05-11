/**
 * WebAssembly dynamic linker for pymode side modules.
 *
 * Side modules are .wasm files built with `wasm-ld --shared` (or `zig cc
 * -fPIC ... --shared`). They follow the WebAssembly tool-conventions
 * Dynamic Linking spec:
 *
 *   https://github.com/WebAssembly/tool-conventions/blob/main/DynamicLinking.md
 *
 * To load a side module we need to:
 *
 *   1. Parse the dylink.0 custom section to discover memory_size,
 *      memory_alignment, table_size, table_alignment.
 *
 *   2. Allocate memory_size bytes in the main wasm instance's heap (via
 *      its exported `malloc`) — that address becomes `__memory_base`.
 *
 *   3. Grow the shared __indirect_function_table by table_size slots —
 *      the starting index becomes `__table_base`.
 *
 *   4. Build the side module's import object:
 *        - env.memory                       → main.exports.memory
 *        - env.__indirect_function_table    → main.exports.__indirect_function_table
 *        - env.__memory_base                → Global<i32, const>(allocatedAddr)
 *        - env.__table_base                 → Global<i32, const>(tableStart)
 *        - env.__stack_pointer              → main.exports.__stack_pointer
 *        - env.<symbol>                     → main.exports[symbol] (function)
 *        - GOT.func.<symbol>                → Global<i32, mut>(table slot for symbol)
 *        - GOT.mem.<symbol>                 → Global<i32, mut>(address of symbol in memory)
 *
 *   5. Instantiate.
 *
 *   6. Invoke `__wasm_apply_data_relocs` then `__wasm_call_ctors` on the
 *      side module's exports if they exist. The former copies data
 *      segments into the allocated memory region; the latter runs C++
 *      static initializers.
 *
 *   7. PyInit_<name> can now be called to get a Python module object.
 *
 * Symbols a side module needs but main.wasm doesn't export trigger a
 * stub function/global that raises at call time, with the symbol name
 * preserved in the error message — useful for diagnosing missing
 * --export-if-defined flags rather than failing instantiation outright.
 */

export interface DylinkMemInfo {
  memorySize: number;
  memoryAlignment: number;
  tableSize: number;
  tableAlignment: number;
}

export interface LinkContext {
  mainExports: WebAssembly.Exports;
  /** Used purely to fabricate distinct error messages for missing
   *  symbols — not actually referenced internally. */
  sideModuleName?: string;
}

export interface LinkedSideModule {
  instance: WebAssembly.Instance;
  exports: WebAssembly.Exports;
  memoryBase: number;
  tableBase: number;
  missing: string[];
}

/** Parse the dylink.0 custom section's MEM_INFO subsection. */
export function parseDylinkMemInfo(wasmBytes: Uint8Array): DylinkMemInfo | null {
  if (wasmBytes.byteLength < 8) return null;
  if (wasmBytes[0] !== 0x00 || wasmBytes[1] !== 0x61 ||
      wasmBytes[2] !== 0x73 || wasmBytes[3] !== 0x6d) return null;

  let pos = 8;
  const dec = new TextDecoder();

  function readULEB(): number {
    let result = 0, shift = 0, byte;
    do {
      byte = wasmBytes[pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  while (pos < wasmBytes.byteLength) {
    const sectionId = wasmBytes[pos++];
    const sectionSize = readULEB();
    const sectionEnd = pos + sectionSize;
    if (sectionId === 0) {
      // Custom section — check name
      const nameLen = readULEB();
      const name = dec.decode(wasmBytes.subarray(pos, pos + nameLen));
      pos += nameLen;
      if (name === "dylink.0") {
        // Parse subsections until sectionEnd
        while (pos < sectionEnd) {
          const subType = wasmBytes[pos++];
          const subSize = readULEB();
          const subEnd = pos + subSize;
          if (subType === 1) {
            // MEM_INFO
            const memorySize = readULEB();
            const memoryAlignment = readULEB();
            const tableSize = readULEB();
            const tableAlignment = readULEB();
            return { memorySize, memoryAlignment, tableSize, tableAlignment };
          }
          pos = subEnd;
        }
      }
    }
    pos = sectionEnd;
  }
  return null;
}

/** Parse a side module's import section. */
interface SideModuleImport { module: string; name: string; kind: number; valtype?: number; mutable?: boolean }
function parseImports(wasmBytes: Uint8Array): SideModuleImport[] {
  let pos = 8;
  const dec = new TextDecoder();
  function readULEB(): number {
    let result = 0, shift = 0, byte;
    do {
      byte = wasmBytes[pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  function readString(): string {
    const len = readULEB();
    const s = dec.decode(wasmBytes.subarray(pos, pos + len));
    pos += len;
    return s;
  }
  while (pos < wasmBytes.byteLength) {
    const sectionId = wasmBytes[pos++];
    const sectionSize = readULEB();
    const sectionEnd = pos + sectionSize;
    if (sectionId !== 2) { pos = sectionEnd; continue; }
    const count = readULEB();
    const imports: SideModuleImport[] = [];
    for (let i = 0; i < count; i++) {
      const mod = readString();
      const name = readString();
      const kind = wasmBytes[pos++];
      let valtype: number | undefined;
      let mutable: boolean | undefined;
      if (kind === 0) {
        readULEB(); // typeidx
      } else if (kind === 1) {
        pos++;
        const limFlag = wasmBytes[pos++];
        readULEB();
        if (limFlag & 1) readULEB();
      } else if (kind === 2) {
        const limFlag = wasmBytes[pos++];
        readULEB();
        if (limFlag & 1) readULEB();
      } else if (kind === 3) {
        valtype = wasmBytes[pos++];
        mutable = wasmBytes[pos++] === 1;
      } else {
        throw new Error(`unknown import kind ${kind}`);
      }
      imports.push({ module: mod, name, kind, valtype, mutable });
    }
    return imports;
  }
  return [];
}

const VALTYPE_I32 = 0x7f;
const VALTYPE_I64 = 0x7e;
const VALTYPE_F32 = 0x7d;
const VALTYPE_F64 = 0x7c;

function valtypeToString(v: number): "i32" | "i64" | "f32" | "f64" {
  switch (v) {
    case VALTYPE_I32: return "i32";
    case VALTYPE_I64: return "i64";
    case VALTYPE_F32: return "f32";
    case VALTYPE_F64: return "f64";
    default: return "i32";
  }
}

/**
 * Load a side module into the running main wasm instance.
 *
 * Throws if dylink.0 is missing (module wasn't built as PIC) or if memory
 * allocation via the exported `malloc` fails. Missing symbols are reported
 * in `missing[]` and stubbed — calls into them will raise from the stub,
 * not break instantiation.
 */
export function linkSideModule(
  module: WebAssembly.Module,
  wasmBytes: Uint8Array,
  ctx: LinkContext,
): LinkedSideModule {
  const memInfo = parseDylinkMemInfo(wasmBytes);
  if (!memInfo) {
    throw new Error("side module has no dylink.0 section — was it built with --shared?");
  }

  const mainExports = ctx.mainExports as Record<string, unknown>;
  const memory = mainExports.memory as WebAssembly.Memory;
  const indirectTable = mainExports.__indirect_function_table as WebAssembly.Table | undefined;
  // CPython's `PyMem_RawMalloc` wraps libc's malloc and is reliably
  // exported via PyAPI_FUNC. Plain `malloc` is hidden by musl's build.
  const malloc = (mainExports.PyMem_RawMalloc
    ?? mainExports.malloc) as ((n: number) => number) | undefined;

  if (!memory) throw new Error("main wasm doesn't export `memory` — required for dynamic linking");
  if (!indirectTable) throw new Error("main wasm doesn't export `__indirect_function_table` — link main wasm with -Wl,--export-table");
  if (!malloc) throw new Error("main wasm doesn't export PyMem_RawMalloc nor malloc — dynamic linker needs one to allocate side-module memory");

  // 1. Allocate memory for the side module's data section + bss
  const memorySize = memInfo.memorySize;
  const memoryAlignBytes = 1 << memInfo.memoryAlignment;
  const rawAddr = malloc(memorySize + memoryAlignBytes);
  if (!rawAddr) throw new Error(`malloc(${memorySize + memoryAlignBytes}) returned 0`);
  // Align upward
  const memoryBase = (rawAddr + memoryAlignBytes - 1) & ~(memoryAlignBytes - 1);

  // 2. Grow the indirect function table by table_size
  const tableSize = memInfo.tableSize;
  const tableBase = indirectTable.length;
  if (tableSize > 0) indirectTable.grow(tableSize);

  // 3. Build the import object
  const imports = parseImports(wasmBytes);
  const env: Record<string, unknown> = {
    memory,
    __indirect_function_table: indirectTable,
  };
  const got_func: Record<string, WebAssembly.Global> = {};
  const got_mem: Record<string, WebAssembly.Global> = {};
  const missing: string[] = [];

  // Globals injected via env need explicit Globals
  for (const imp of imports) {
    if (imp.module === "env") {
      if (imp.name === "memory" || imp.name === "__indirect_function_table") continue;
      if (imp.kind === 3) {
        // Global
        if (imp.name === "__memory_base") {
          env.__memory_base = new WebAssembly.Global(
            { value: "i32", mutable: !!imp.mutable }, memoryBase);
        } else if (imp.name === "__table_base") {
          env.__table_base = new WebAssembly.Global(
            { value: "i32", mutable: !!imp.mutable }, tableBase);
        } else if (imp.name === "__stack_pointer") {
          // Share parent's stack pointer if available — otherwise stub it.
          const parentSp = mainExports.__stack_pointer as WebAssembly.Global | undefined;
          if (parentSp) {
            env.__stack_pointer = parentSp;
          } else {
            missing.push(`env.__stack_pointer`);
            env.__stack_pointer = new WebAssembly.Global(
              { value: "i32", mutable: true }, 0);
          }
        } else {
          // Some other env global — resolve from main.exports
          const ex = mainExports[imp.name];
          if (ex instanceof WebAssembly.Global) {
            env[imp.name] = ex;
          } else {
            missing.push(`env.${imp.name}`);
            const valtype = valtypeToString(imp.valtype ?? VALTYPE_I32);
            env[imp.name] = new WebAssembly.Global(
              { value: valtype, mutable: !!imp.mutable }, 0);
          }
        }
        continue;
      }
      if (imp.kind === 0) {
        // Function import — resolve from main.exports
        const fn = mainExports[imp.name];
        if (typeof fn === "function") {
          env[imp.name] = fn;
        } else {
          missing.push(`env.${imp.name}`);
          // Stub that throws — preserves the symbol name in the error
          env[imp.name] = (...args: unknown[]) => {
            throw new Error(
              `[dynlink] side module ${ctx.sideModuleName ?? "?"} called unresolved import env.${imp.name}(${args.length} args)`,
            );
          };
        }
        continue;
      }
    } else if (imp.module === "GOT.func") {
      // GOT.func.<name>: i32 global holding a table index. Allocate a new
      // table slot for the symbol if main.exports[name] is a function;
      // otherwise stub.
      const fn = mainExports[imp.name];
      if (typeof fn === "function") {
        const slot = indirectTable.length;
        indirectTable.grow(1);
        indirectTable.set(slot, fn as unknown as WebAssembly.Function);
        got_func[imp.name] = new WebAssembly.Global(
          { value: "i32", mutable: !!imp.mutable }, slot);
      } else {
        missing.push(`GOT.func.${imp.name}`);
        got_func[imp.name] = new WebAssembly.Global(
          { value: "i32", mutable: !!imp.mutable }, 0);
      }
    } else if (imp.module === "GOT.mem") {
      // GOT.mem.<name>: i32 global holding a memory address. Resolve from
      // main.exports[name] which should be an i32 Global with the address.
      const ex = mainExports[imp.name];
      if (ex instanceof WebAssembly.Global) {
        try {
          got_mem[imp.name] = new WebAssembly.Global(
            { value: "i32", mutable: !!imp.mutable }, ex.value);
        } catch {
          missing.push(`GOT.mem.${imp.name}`);
          got_mem[imp.name] = new WebAssembly.Global(
            { value: "i32", mutable: !!imp.mutable }, 0);
        }
      } else {
        missing.push(`GOT.mem.${imp.name}`);
        got_mem[imp.name] = new WebAssembly.Global(
          { value: "i32", mutable: !!imp.mutable }, 0);
      }
    }
  }

  // 4. Instantiate
  const instance = new WebAssembly.Instance(module, {
    env,
    "GOT.func": got_func,
    "GOT.mem": got_mem,
  });
  const exports = instance.exports;

  // 5. Run data relocs and ctors
  const applyDataRelocs = exports.__wasm_apply_data_relocs as (() => void) | undefined;
  if (typeof applyDataRelocs === "function") applyDataRelocs();
  const callCtors = exports.__wasm_call_ctors as (() => void) | undefined;
  if (typeof callCtors === "function") callCtors();

  return { instance, exports, memoryBase, tableBase, missing };
}
