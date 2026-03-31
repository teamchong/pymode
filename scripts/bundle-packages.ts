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
  ".pem",  // CA certificates (certifi)
]);

function extractPyFromWheel(wheelData: Buffer): [string, Buffer][] {
  const files: [string, Buffer][] = [];
  const entries = readZip(wheelData);

  for (const { name, data } of entries) {
    // Keep .dist-info/METADATA for importlib.metadata (pydantic needs it)
    // Skip other dist-info files (RECORD, WHEEL, top_level.txt, etc.)
    if (name.includes(".dist-info/")) {
      if (name.endsWith("/METADATA")) {
        files.push([name, data]);
      }
      continue;
    }
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

  // Inject bridge shims for native C/Zig extensions compiled into python.wasm.
  // PyPI packages use relative imports (e.g. `from ._xxhash import ...`) but our
  // native modules are registered as top-level builtins. These shims redirect the
  // relative import to the top-level builtin module.
  const nativeBridges: Record<string, string> = {
    "xxhash/_xxhash.py": "import _xxhash as _mod; import sys; sys.modules[__name__] = _mod",
    "regex/_regex.py": "import _regex as _mod; import sys; sys.modules[__name__] = _mod",
    "msgpack/_cmsgpack.py": "import _cmsgpack as _mod; import sys; sys.modules[__name__] = _mod",
  };
  for (const [bridgePath, bridgeCode] of Object.entries(nativeBridges)) {
    const pkgDir = bridgePath.split("/")[0];
    // Only inject if the package is actually bundled
    const hasPkg = [...allFiles.keys()].some((k) => k.startsWith(pkgDir + "/"));
    if (hasPkg && !allFiles.has(bridgePath)) {
      allFiles.set(bridgePath, Buffer.from(bridgeCode, "utf-8"));
      console.log(`  Injected native bridge: ${bridgePath}`);
    }
  }

  // Inject pure-Python shims for native extensions not compiled into WASM
  const pureShims: Record<string, string> = {
    // jiter is a Rust extension (pydantic/jiter) — provide pure-Python fallback using json
    "jiter/__init__.py": [
      "import json as _json",
      "def from_json(data, *, partial_mode='off', catch_duplicate_keys=False, float_mode='float'):",
      "    if isinstance(data, (bytes, bytearray)): data = data.decode('utf-8')",
      "    return _json.loads(data)",
      "def cache_clear(): pass",
      "def cache_usage(): return 0",
      "__version__ = '0.0.0'",
    ].join("\n"),
    // uuid_utils is a Rust extension — shim with stdlib uuid
    "uuid_utils/__init__.py": [
      "from uuid import *",
      "from uuid import uuid1, uuid3, uuid4, uuid5, getnode, UUID, NAMESPACE_DNS, NAMESPACE_URL, NAMESPACE_OID, NAMESPACE_X500",
      "import uuid as _uuid",
      "NIL = UUID(int=0)",
      "MAX = UUID(int=(1 << 128) - 1)",
      "RESERVED_NCS = 'reserved for NCS compatibility'",
      "RESERVED_FUTURE = 'reserved for future definition'",
      "RESERVED_MICROSOFT = 'reserved for Microsoft compatibility'",
      "RFC_4122 = 'specified in RFC 4122'",
      "def uuid6(*args, **kwargs): return uuid4()",
      "def uuid7(*args, **kwargs): return uuid4()",
      "def uuid8(*args, **kwargs): return uuid4()",
      "def reseed_rng(): pass",
      "__version__ = '0.0.0'",
    ].join("\n"),
    "uuid_utils/compat/__init__.py": "from uuid_utils import *\n",
    // ormsgpack is a Rust extension — shim with msgpack
    "ormsgpack/__init__.py": [
      "import msgpack as _msgpack",
      "OPT_NON_STR_KEYS = 1",
      "OPT_SERIALIZE_NUMPY = 2",
      "OPT_PASSTHROUGH_DATETIME = 4",
      "OPT_PASSTHROUGH_DATACLASS = 8",
      "OPT_PASSTHROUGH_ENUM = 16",
      "OPT_PASSTHROUGH_UUID = 32",
      "OPT_REPLACE_SURROGATES = 64",
      "OPT_SORT_KEYS = 128",
      "def packb(obj, *, default=None, option=None):",
      "    return _msgpack.packb(obj, default=default)",
      "def unpackb(data, *, option=None):",
      "    return _msgpack.unpackb(data, raw=False)",
      "MsgpackEncodeError = ValueError",
      "MsgpackDecodeError = ValueError",
    ].join("\n"),
    // orjson is a Rust extension — shim with json
    "orjson/__init__.py": [
      "import json as _json",
      "OPT_NON_STR_KEYS = 1",
      "OPT_SERIALIZE_NUMPY = 2",
      "OPT_INDENT_2 = 4",
      "OPT_SORT_KEYS = 8",
      "OPT_APPEND_NEWLINE = 16",
      "OPT_NAIVE_UTC = 32",
      "OPT_PASSTHROUGH_DATETIME = 64",
      "OPT_SERIALIZE_DATACLASS = 128",
      "OPT_SERIALIZE_UUID = 256",
      "OPT_UTC_Z = 512",
      "OPT_OMIT_MICROSECONDS = 1024",
      "OPT_PASSTHROUGH_SUBCLASS = 2048",
      "class JSONDecodeError(ValueError): pass",
      "class JSONEncodeError(TypeError): pass",
      "def dumps(obj, *, default=None, option=None):",
      "    return _json.dumps(obj, default=default).encode('utf-8')",
      "def loads(data):",
      "    if isinstance(data, (bytes, bytearray, memoryview)): data = bytes(data).decode('utf-8')",
      "    return _json.loads(data)",
      "Fragment = bytes",
    ].join("\n"),
    // FastMCP optional imports — transport/CLI packages unavailable in WASI.
    // These are imported conditionally by FastMCP but not needed for tool registration/calling.
    "uvicorn/__init__.py": "class Config: pass\ndef run(*a, **kw): raise RuntimeError('uvicorn not available in WASI')\n",
    "authlib/__init__.py": "",
    "cryptography/__init__.py": "",
    "cffi/__init__.py": "",
    "pyperclip/__init__.py": "def copy(text): pass\ndef paste(): return ''\n",
    "cyclopts/__init__.py": "",
    "openapi_core/__init__.py": "",
    "openapi_pydantic/__init__.py": "",
    "rfc3987/__init__.py": "",
    "aiofile/__init__.py": "",
    "caio/__init__.py": "",
    "watchfiles/__init__.py": "",
    "pycparser/__init__.py": "",
    // rpds-py is a Rust extension — pure Python fallback for HashTrieMap/HashTrieSet/List/Queue
    "rpds/__init__.py": [
      "class HashTrieMap:",
      "    def __init__(self, data=None):",
      "        self._d = dict(data) if data else {}",
      "    @classmethod",
      "    def convert(cls, mapping): return cls(mapping)",
      "    @classmethod",
      "    def fromkeys(cls, keys, value=None): return cls({k: value for k in keys})",
      "    def insert(self, key, value):",
      "        new = HashTrieMap(self._d); new._d[key] = value; return new",
      "    def remove(self, key):",
      "        new = HashTrieMap(self._d); del new._d[key]; return new",
      "    def discard(self, key):",
      "        new = HashTrieMap(self._d); new._d.pop(key, None); return new",
      "    def update(self, other):",
      "        new = HashTrieMap(self._d); new._d.update(other); return new",
      "    def get(self, key, default=None): return self._d.get(key, default)",
      "    def keys(self): return self._d.keys()",
      "    def values(self): return self._d.values()",
      "    def items(self): return self._d.items()",
      "    def __getitem__(self, key): return self._d[key]",
      "    def __contains__(self, key): return key in self._d",
      "    def __iter__(self): return iter(self._d)",
      "    def __len__(self): return len(self._d)",
      "    def __eq__(self, other): return isinstance(other, HashTrieMap) and self._d == other._d",
      "    def __hash__(self): return hash(tuple(sorted(self._d.items())))",
      "    def __repr__(self): return f'HashTrieMap({self._d!r})'",
      "class HashTrieSet:",
      "    def __init__(self, data=None):",
      "        self._s = set(data) if data else set()",
      "    def insert(self, value):",
      "        new = HashTrieSet(self._s); new._s.add(value); return new",
      "    def remove(self, value):",
      "        new = HashTrieSet(self._s); new._s.remove(value); return new",
      "    def discard(self, value):",
      "        new = HashTrieSet(self._s); new._s.discard(value); return new",
      "    def update(self, other):",
      "        new = HashTrieSet(self._s); new._s.update(other); return new",
      "    def union(self, other): return HashTrieSet(self._s | (other._s if isinstance(other, HashTrieSet) else set(other)))",
      "    def intersection(self, other): return HashTrieSet(self._s & (other._s if isinstance(other, HashTrieSet) else set(other)))",
      "    def difference(self, other): return HashTrieSet(self._s - (other._s if isinstance(other, HashTrieSet) else set(other)))",
      "    def symmetric_difference(self, other): return HashTrieSet(self._s ^ (other._s if isinstance(other, HashTrieSet) else set(other)))",
      "    def __contains__(self, value): return value in self._s",
      "    def __iter__(self): return iter(self._s)",
      "    def __len__(self): return len(self._s)",
      "    def __eq__(self, other): return isinstance(other, HashTrieSet) and self._s == other._s",
      "    def __repr__(self): return f'HashTrieSet({self._s!r})'",
      "class List:",
      "    def __init__(self, data=None):",
      "        self._l = list(data) if data else []",
      "    def push_front(self, value):",
      "        new = List(self._l); new._l.insert(0, value); return new",
      "    def drop_first(self):",
      "        new = List(self._l[1:]); return new",
      "    @property",
      "    def first(self): return self._l[0] if self._l else None",
      "    def __iter__(self): return iter(self._l)",
      "    def __len__(self): return len(self._l)",
      "    def __repr__(self): return f'List({self._l!r})'",
      "class Queue:",
      "    def __init__(self, data=None):",
      "        self._q = list(data) if data else []",
      "    def enqueue(self, value):",
      "        new = Queue(self._q); new._q.append(value); return new",
      "    def dequeue(self):",
      "        new = Queue(self._q[1:]); return new",
      "    @property",
      "    def peek(self): return self._q[0] if self._q else None",
      "    def __iter__(self): return iter(self._q)",
      "    def __len__(self): return len(self._q)",
      "    def __repr__(self): return f'Queue({self._q!r})'",
    ].join("\n"),
  };
  for (const [shimPath, shimCode] of Object.entries(pureShims)) {
    allFiles.set(shimPath, Buffer.from(shimCode, "utf-8"));
    console.log(`  Injected pure-Python shim: ${shimPath}`);
  }

  // WASI compatibility patches — override files from real wheels that use
  // features unavailable in WASI (entry_points, beartype path hooks, etc.)
  const wasiPatches: Record<string, string> = {
    // beartype's claw hooks call invalidate_caches() which crashes in WASI
    // (MetaPathFinder not instantiated). key_value uses beartype_this_package.
    "key_value/aio/__init__.py": "# beartype disabled for WASI compatibility\n",
    // opentelemetry uses importlib_metadata entry_points which don't work in WASI.
    // Replace with hardcoded entry points for the known opentelemetry components.
    "opentelemetry/util/_importlib_metadata.py": [
      "# WASI-patched: hardcoded entry points (no importlib_metadata)",
      "class PackageNotFoundError(Exception): pass",
      "class EntryPoint:",
      "    def __init__(self, name, value, group):",
      "        self.name = name",
      "        self.value = value",
      "        self.group = group",
      "    def load(self):",
      "        module_path, attr = self.value.rsplit(':', 1)",
      "        import importlib",
      "        mod = importlib.import_module(module_path)",
      "        return getattr(mod, attr)",
      "class EntryPoints(list):",
      "    def select(self, **params):",
      "        result = list(self)",
      "        if 'group' in params: result = [ep for ep in result if ep.group == params['group']]",
      "        if 'name' in params: result = [ep for ep in result if ep.name == params['name']]",
      "        return EntryPoints(result)",
      "class Distribution: pass",
      "_ALL_ENTRY_POINTS = EntryPoints([",
      "    EntryPoint('contextvars_context', 'opentelemetry.context.contextvars_context:ContextVarsRuntimeContext', 'opentelemetry_context'),",
      "    EntryPoint('tracecontext', 'opentelemetry.trace.propagation.tracecontext:TraceContextTextMapPropagator', 'opentelemetry_propagator'),",
      "    EntryPoint('baggage', 'opentelemetry.baggage.propagation:W3CBaggagePropagator', 'opentelemetry_propagator'),",
      "    EntryPoint('default_tracer_provider', 'opentelemetry.trace:NoOpTracerProvider', 'opentelemetry_tracer_provider'),",
      "    EntryPoint('default_meter_provider', 'opentelemetry.metrics:NoOpMeterProvider', 'opentelemetry_meter_provider'),",
      "])",
      "def entry_points(**params):",
      "    return _ALL_ENTRY_POINTS.select(**params) if params else _ALL_ENTRY_POINTS",
      "def version(package_name): return '0.0.0'",
      "def requires(package_name): return []",
      "def distributions(): return []",
      "__all__ = ['entry_points', 'version', 'EntryPoint', 'EntryPoints', 'requires', 'Distribution', 'distributions', 'PackageNotFoundError']",
    ].join("\n"),
  };
  for (const [patchPath, patchCode] of Object.entries(wasiPatches)) {
    // Only apply if the package is actually bundled
    const pkgDir = patchPath.split("/")[0];
    const hasPkg = [...allFiles.keys()].some((k) => k.startsWith(pkgDir + "/"));
    if (hasPkg) {
      allFiles.set(patchPath, Buffer.from(patchCode, "utf-8"));
      console.log(`  Applied WASI patch: ${patchPath}`);
    }
  }

  // Patch opentelemetry context __init__.py to use direct import instead of entry_points.
  // The upstream code tries to discover the context implementation via entry_points(),
  // which requires importlib.metadata — unavailable in WASI. We replace _load_runtime_context
  // to directly import the ContextVarsRuntimeContext that ships with the package.
  if (allFiles.has("opentelemetry/context/__init__.py")) {
    let ctxInit = allFiles.get("opentelemetry/context/__init__.py")!.toString("utf-8");
    // Match the _load_runtime_context function body and replace it entirely
    const fnStart = "def _load_runtime_context()";
    const fnEnd = "\n\n\n_RUNTIME_CONTEXT";
    const startIdx = ctxInit.indexOf(fnStart);
    const endIdx = ctxInit.indexOf(fnEnd);
    if (startIdx !== -1 && endIdx !== -1) {
      const replacement = [
        'def _load_runtime_context() -> _RuntimeContext:',
        '    """Initialize the RuntimeContext using direct import for WASI."""',
        '    from opentelemetry.context.contextvars_context import ContextVarsRuntimeContext',
        '    return ContextVarsRuntimeContext()',
      ].join("\n");
      ctxInit = ctxInit.substring(0, startIdx) + replacement + ctxInit.substring(endIdx);
      allFiles.set("opentelemetry/context/__init__.py", Buffer.from(ctxInit, "utf-8"));
      console.log("  Applied WASI patch: opentelemetry/context/__init__.py");
    }
  }

  // Auto-inject __init__.py for namespace packages (zipimport requires it)
  // Collect ALL directory paths that contain .py files at any depth
  const packageDirs = new Set<string>();
  for (const filePath of allFiles.keys()) {
    const parts = filePath.split("/");
    if (parts.length >= 2 && parts[parts.length - 1].endsWith(".py")) {
      // Add every parent directory as a package dir
      for (let depth = 1; depth < parts.length; depth++) {
        packageDirs.add(parts.slice(0, depth).join("/"));
      }
    }
  }
  for (const pkg of packageDirs) {
    const initPath = `${pkg}/__init__.py`;
    if (!allFiles.has(initPath)) {
      // If top-level package has version.py, re-export __version__
      const isTopLevel = !pkg.includes("/");
      const hasVersion = isTopLevel && allFiles.has(`${pkg}/version.py`);
      const initCode = hasVersion
        ? "from .version import __version__\n"
        : "";
      allFiles.set(initPath, Buffer.from(initCode, "utf-8"));
      console.log(`  Injected __init__.py for namespace package: ${pkg}`);
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
