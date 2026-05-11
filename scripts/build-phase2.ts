#!/usr/bin/env npx tsx
/**
 * Phase 2: Build CPython for wasm32-wasi using zig cc (no WASI SDK).
 *
 * Uses ReleaseSmall equivalent: -Os, strip debug info, minimize binary size.
 * Prerequisites: python3, wasmtime, zig, Phase 1 native build.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, arch } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);
const CPYTHON_DIR = join(ROOT_DIR, "cpython");
const BUILD_DIR = join(ROOT_DIR, "build", "zig-wasi");
const ZIG_WRAPPER_DIR = join(ROOT_DIR, "build", "zig-wrappers");

/**
 * Build mode determines what goes into the final python.wasm:
 *
 *   "test"  — kitchen-sink runtime used by the vitest suite. Heavy wizer
 *             preimports (jinja2/pydantic/langchain/…) baked in; every
 *             recipe linked; full side-module dynamic linker exports.
 *             Output: worker/src/python.wasm.
 *
 *   "app"   — per-app deploy build. Auto-generated header with the
 *             user's imports preimported. Driven by
 *             scripts/generate-app-preimports.mjs.
 *             Output: worker/src/python-app.wasm.
 */
const CLI_ARGS = process.argv.slice(2);
function getArg(flag: string, fallback: string): string {
  const eq = CLI_ARGS.find(a => a.startsWith(flag + "="));
  if (eq) return eq.slice(flag.length + 1);
  const idx = CLI_ARGS.indexOf(flag);
  if (idx >= 0 && CLI_ARGS[idx + 1] && !CLI_ARGS[idx + 1].startsWith("-")) {
    return CLI_ARGS[idx + 1];
  }
  return fallback;
}
const BUILD_MODE = getArg("--mode", "test") as "test" | "app";
if (!["test", "app"].includes(BUILD_MODE)) {
  console.error(`Invalid --mode=${BUILD_MODE}. Use test or app.`);
  process.exit(2);
}
const APP_PREIMPORT_HEADER = getArg("--app-preimports", "");  // path to .h, only used in app mode

const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

function info(msg: string): void {
  console.log(`${GREEN}[INFO]${NC} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${YELLOW}[WARN]${NC} ${msg}`);
}

function error(msg: string): never {
  console.error(`${RED}[ERROR]${NC} ${msg}`);
  process.exit(1);
}

function ncpu(): number {
  return cpus().length || 2;
}

function sedi(filepath: string, pattern: RegExp, replacement: string): void {
  let content = readFileSync(filepath, "utf-8");
  content = content.replace(pattern, replacement);
  writeFileSync(filepath, content);
}

function which(cmd: string): string | null {
  try {
    const result = spawnSync("which", [cmd], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.status === 0 ? (result.stdout as string).trim() || null : null;
  } catch {
    return null;
  }
}

function isExecutable(filepath: string): boolean {
  try {
    accessSync(filepath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface NativeModule {
  name: string;
  zig_src?: string;
  c_srcs?: string[];
  c_flags?: string[];
  extra_includes?: string[];
  /** If true, this module replaces a CPython built-in. The .o file replaces
   *  CPython's version in-place instead of being added to MODULE_OBJS. */
  replaces_builtin?: boolean;
}

function main(): void {
  // Check prerequisites
  for (const cmd of ["python3", "wasmtime", "zig"]) {
    if (!which(cmd)) {
      error(`${cmd} not found`);
    }
  }

  const zigVersion = execSync("zig version", { encoding: "utf-8" }).trim();
  info(`Using zig ${zigVersion}`);

  if (!existsSync(CPYTHON_DIR) || !statSync(CPYTHON_DIR).isDirectory()) {
    error("CPython source not found. Run build-phase1.sh first to clone it.");
  }

  // Step 1: Locate or build the native Python (needed for cross-compilation)
  let nativePython = "";
  const candidates = [
    join(CPYTHON_DIR, "cross-build", "build", "python.exe"),
    join(CPYTHON_DIR, "cross-build", "build", "python"),
    join(ROOT_DIR, "build", "native", "python.exe"),
    join(ROOT_DIR, "build", "native", "python"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && isExecutable(candidate)) {
      nativePython = candidate;
      break;
    }
  }

  if (!nativePython) {
    info("No native Python found. Building one (out-of-tree)...");
    const nativeBuildDir = join(ROOT_DIR, "build", "native");
    mkdirSync(nativeBuildDir, { recursive: true });
    const configureResult = spawnSync(
      join(CPYTHON_DIR, "configure"),
      [`--prefix=${nativeBuildDir}/install`],
      { cwd: nativeBuildDir, stdio: "inherit" },
    );
    if (configureResult.status !== 0) {
      error("Native Python configure failed");
    }
    const makeResult = spawnSync("make", [`-j${ncpu()}`], {
      cwd: nativeBuildDir,
      stdio: "inherit",
    });
    if (makeResult.status !== 0) {
      error("Native Python make failed");
    }
    for (const name of ["python.exe", "python"]) {
      const path = join(nativeBuildDir, name);
      if (existsSync(path) && statSync(path).isFile() && isExecutable(path)) {
        nativePython = path;
        break;
      }
    }
  }

  info(`Using native Python: ${nativePython}`);

  // Step 2: Create zig cc wrapper scripts
  mkdirSync(ZIG_WRAPPER_DIR, { recursive: true });

  const zigCcScript = join(ZIG_WRAPPER_DIR, "zig-cc");
  writeFileSync(
    zigCcScript,
    `#!/usr/bin/env bash
# zig cc wrapper for wasm32-wasi cross-compilation.
# Size-tuned: -Oz, dead-code-stripping linkage, constant merging, no canaries
# or unwind metadata. Matches the flag set used by edgesharp/capnwasm.

ARGS=()
HAS_OPT=0
SKIP_NEXT=0
for arg in "$@"; do
    if [[ "$SKIP_NEXT" -eq 1 ]]; then SKIP_NEXT=0; continue; fi
    case "$arg" in
        # Skip flags zig cc doesn't support for wasm32-wasi
        -pthread|-ldl|-lutil|-lrt|-lpthread) continue ;;
        # Keep -lm (zig provides this for wasm32-wasi)
        -lm) ARGS+=("$arg") ;;
        -Wl,--version-script=*) continue ;;
        -Wl,-export-dynamic|-Wl,--no-as-needed) continue ;;
        -Wl,--allow-undefined) continue ;;
        -Wl,-z,*) continue ;;
        -Wl,--initial-memory=*) continue ;;
        -Wl,--stack-first) continue ;;
        -z) SKIP_NEXT=1; continue ;;  # skip -z and its argument
        # Replace optimization flags with -Oz (size-first)
        -O0|-O1|-O2|-O3|-Og|-Os) ARGS+=("-Oz"); HAS_OPT=1 ;;
        -flto=thin) ARGS+=("-flto") ;;
        # Skip macOS-specific flags
        -framework) continue ;;
        CoreFoundation|SystemConfiguration) continue ;;
        -Wl,-stack_size,*) continue ;;
        # Skip dynamic linking flags (WASI is static)
        -bundle|-undefined|-dynamic_lookup) continue ;;
        -Wl,-undefined,*) continue ;;
        # Skip native host library paths (not valid for cross-compilation)
        -L/opt/homebrew/*|-L/usr/local/*) continue ;;
        -lb2) continue ;;  # libb2 not available as WASM
        # Pass everything else through
        *) ARGS+=("$arg") ;;
    esac
done

# Default to -Oz when nothing else was specified
if [ "$HAS_OPT" -eq 0 ]; then
    ARGS+=("-Oz")
fi

# Strip debug info for smaller binary
ARGS+=("-s")

# WASI defines CLOCK_REALTIME/CLOCK_MONOTONIC as pointers, not integers.
# Zig's clang treats -Wint-conversion as an error by default, so demote it.
ARGS+=("-Wno-error=int-conversion" "-Wno-error=incompatible-pointer-types" "-Wno-error=date-time")

# Size-tuning flags borrowed from edgesharp/capnwasm:
#  -fdata-sections -ffunction-sections + -Wl,--gc-sections — drop unreachable
#    code/data once the linker can prove it
#  -fmerge-all-constants — dedupe identical string/numeric constants
#  -fno-unwind-tables -fno-asynchronous-unwind-tables — no C++ EH metadata
#  -fno-stack-protector — no canary instrumentation (WASI doesn't need it)
ARGS+=(
  "-fdata-sections"
  "-ffunction-sections"
  "-fmerge-all-constants"
  "-fno-unwind-tables"
  "-fno-asynchronous-unwind-tables"
  "-fno-stack-protector"
  "-Wl,--gc-sections"
  "-Wl,--strip-all"
)

exec zig cc -target wasm32-wasi "\${ARGS[@]}"
`,
  );
  chmodSync(zigCcScript, 0o755);

  const wrappers: Array<[string, string]> = [
    ["zig-ar", "#!/usr/bin/env bash\nexec zig ar \"$@\"\n"],
    ["zig-ranlib", "#!/usr/bin/env bash\nexec zig ranlib \"$@\"\n"],
  ];
  for (const [name, content] of wrappers) {
    const path = join(ZIG_WRAPPER_DIR, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }

  const zigCppScript = join(ZIG_WRAPPER_DIR, "zig-cpp");
  writeFileSync(
    zigCppScript,
    `#!/usr/bin/env bash
ARGS=()
for arg in "$@"; do
    case "$arg" in
        -pthread|-lpthread|-ldl|-lm|-lutil|-lrt) continue ;;
        -framework|CoreFoundation|SystemConfiguration) continue ;;
        *) ARGS+=("$arg") ;;
    esac
done
exec zig cc -target wasm32-wasi -E "\${ARGS[@]}"
`,
  );
  chmodSync(zigCppScript, 0o755);

  // Step 3: Out-of-tree build with zig cc
  info("Configuring CPython with zig cc for wasm32-wasi (ReleaseSmall)...");
  mkdirSync(BUILD_DIR, { recursive: true });

  // Clean previous zig-wasi build
  for (const item of readdirSync(BUILD_DIR)) {
    const path = join(BUILD_DIR, item);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    } else {
      unlinkSync(path);
    }
  }

  const configCache = join(dirname(BUILD_DIR), "config.cache");
  if (existsSync(configCache)) {
    unlinkSync(configCache);
  }

  // Detect build triple
  const system = platform();
  const machine = arch();
  // Map Node.js arch names to platform convention
  const machineMap: Record<string, string> = {
    arm64: "aarch64",
    x64: "x86_64",
    ia32: "i686",
  };
  const mappedMachine = machineMap[machine] || machine;

  let buildTriple: string;
  if (system === "darwin") {
    buildTriple = `${mappedMachine}-apple-darwin`;
  } else if (system === "linux") {
    buildTriple = `${mappedMachine}-pc-linux-gnu`;
  } else {
    buildTriple = `${mappedMachine}-unknown-${system}`;
  }

  // Disabled modules
  const disabledModules = [
    "py_cv_module__bz2=n/a",
    "py_cv_module__lzma=n/a",
    "py_cv_module_zlib=n/a",
    "py_cv_module__socket=n/a",
    "py_cv_module__ctypes=n/a",
    "py_cv_module_select=n/a",
    "py_cv_module_faulthandler=n/a",
    "py_cv_module_resource=n/a",
    "py_cv_module_grp=n/a",
    "py_cv_module_pwd=n/a",
    "py_cv_module_fcntl=n/a",
    "py_cv_module_mmap=n/a",
    "py_cv_module_termios=n/a",
    "py_cv_module_syslog=n/a",
    "py_cv_module__multiprocessing=n/a",
    "py_cv_module__posixsubprocess=n/a",
    "py_cv_module__posixshmem=n/a",
    "py_cv_module__curses=n/a",
    "py_cv_module__curses_panel=n/a",
    "py_cv_module__dbm=n/a",
    "py_cv_module__gdbm=n/a",
    "py_cv_module__tkinter=n/a",
    "py_cv_module__scproxy=n/a",
  ];

  const configureEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CONFIG_SITE: join(ROOT_DIR, "scripts", "config.site-wasi"),
    PKG_CONFIG: "false",
  };

  const configureResult = spawnSync(
    join(CPYTHON_DIR, "configure"),
    [
      "--host=wasm32-wasi",
      `--build=${buildTriple}`,
      `--with-build-python=${nativePython}`,
      `CC=${zigCcScript}`,
      `CPP=${zigCppScript}`,
      `AR=${join(ZIG_WRAPPER_DIR, "zig-ar")}`,
      `RANLIB=${join(ZIG_WRAPPER_DIR, "zig-ranlib")}`,
      "CFLAGS=-Os -DNDEBUG -fno-strict-aliasing -msimd128 -mbulk-memory -msign-ext -mmutable-globals -mnontrapping-fptoint -mtail-call -mmultivalue -mreference-types -DUSE_COMPUTED_GOTOS=1",
      "LDFLAGS=-s",
      "--disable-ipv6",
      "--disable-shared",
      "--without-ensurepip",
      "--without-pymalloc",
      "--disable-test-modules",
      "--config-cache",
      "ac_cv_file__dev_ptmx=no",
      "ac_cv_file__dev_ptc=no",
      ...disabledModules,
    ],
    { cwd: BUILD_DIR, env: configureEnv, stdio: "inherit" },
  );
  if (configureResult.status !== 0) {
    error("Configure failed");
  }

  // Step 3b: (Zig 0.16+) pyconfig.h needs no pthread patching. Zig 0.16's
  // bundled wasm-wasi-musl provides a complete pthread implementation with
  // a correct `_Noreturn void pthread_exit` signature, so HAVE_PTHREAD_H
  // can stay enabled. Disabling it and enabling HAVE_PTHREAD_STUBS would
  // make CPython's Python/thread.o re-define pthread_mutex_init / _cond_init /
  // etc., colliding with musl's libc.a → duplicate-symbol link errors.
  const pyconfig = join(BUILD_DIR, "pyconfig.h");
  void pyconfig; // keep path local for future patches without unused-var noise

  // Strip `-fvisibility=hidden` from the generated Makefile so side modules
  // can resolve musl libc functions (sinf, cosf, sqrtf, etc.) from main
  // wasm via --export-dynamic. Without this, libc math is statically
  // linked with hidden visibility and unreachable from numpy's side
  // module. The PyAPI_FUNC macro on CPython's own API uses an explicit
  // `__attribute__((visibility("default")))` so those stay public even
  // without the global default.
  const phase2Makefile = join(BUILD_DIR, "Makefile");
  if (existsSync(phase2Makefile)) {
    sedi(phase2Makefile, /\s-fvisibility=hidden\b/g, "");
  }

  // Step 3b2: Save clean config.c as base (before variant patching)
  const configC = join(BUILD_DIR, "Modules", "config.c");
  const configCBase = join(BUILD_DIR, "Modules", "config.c.base");
  if (existsSync(configC) && statSync(configC).isFile() && !existsSync(configCBase)) {
    copyFileSync(configC, configCBase);
    info("  Saved config.c.base (clean copy for variant builds)");
  }

  // Register _pymode as a built-in module
  info("Registering _pymode built-in module...");
  if (existsSync(configC) && statSync(configC).isFile()) {
    let content = readFileSync(configC, "utf-8");
    if (!content.includes("PyInit__pymode")) {
      content = content.replace(
        "/* -- ADDMODULE MARKER 1 -- */",
        "extern PyObject* PyInit__pymode(void);\n/* -- ADDMODULE MARKER 1 -- */",
      );
      content = content.replace(
        "/* -- ADDMODULE MARKER 2 -- */",
        '    {"_pymode", PyInit__pymode},\n/* -- ADDMODULE MARKER 2 -- */',
      );
      writeFileSync(configC, content);
      // Update base copy too
      copyFileSync(configC, configCBase);
      info("  _pymode registered in config.c");
    }
  }

  // Step 3c: Compile dynload_pymode shim
  info("Compiling dynload_pymode shim...");
  const shimsDir = join(ROOT_DIR, "lib", "wasi-shims");
  mkdirSync(join(BUILD_DIR, "Python"), { recursive: true });
  const dynloadResult = spawnSync(
    "bash",
    [
      zigCcScript,
      "-c",
      "-Os",
      "-DPy_BUILD_CORE",
      `-I${CPYTHON_DIR}/Include`,
      `-I${CPYTHON_DIR}/Include/internal`,
      `-I${BUILD_DIR}`,
      join(shimsDir, "dynload_pymode.c"),
      "-o",
      join(BUILD_DIR, "Python", "dynload_pymode.o"),
    ],
    { stdio: "inherit" },
  );
  if (dynloadResult.status !== 0) {
    error("Failed to compile dynload_pymode shim");
  }
  info("  Built Python/dynload_pymode.o");

  // Step 3d: Compile pymode host imports
  info("Compiling pymode host imports...");
  const importsDir = join(ROOT_DIR, "lib", "pymode-imports");
  const importsC = join(importsDir, "pymode_imports.c");
  if (existsSync(importsC) && statSync(importsC).isFile()) {
    mkdirSync(join(BUILD_DIR, "Modules"), { recursive: true });
    const importsResult = spawnSync(
      "bash",
      [
        zigCcScript,
        "-c",
        "-Os",
        "-DPy_BUILD_CORE",
        `-I${importsDir}`,
        `-I${CPYTHON_DIR}/Include`,
        `-I${CPYTHON_DIR}/Include/internal`,
        `-I${BUILD_DIR}`,
        importsC,
        "-o",
        join(BUILD_DIR, "Modules", "pymode_imports.o"),
      ],
      { stdio: "inherit" },
    );
    if (importsResult.status !== 0) {
      error("Failed to compile pymode host imports");
    }
    info("  Built Modules/pymode_imports.o");
  }

  // Step 3e: Build native extension modules (Zig and/or C). These are
  // test-runtime only — they exist to back test/xxhash.test.ts and
  // friends, and aren't part of a real user app. Skip them in slim
  // builds to avoid registering symbols that nothing links against.
  if (BUILD_MODE !== "test") {
    info("Skipping in-tree native modules (test runtime only).");
  }
  const zigModulesDir = join(ROOT_DIR, "zig-modules");
  const cModulesDir = join(ROOT_DIR, "c-modules");
  const nativeModules: NativeModule[] = BUILD_MODE !== "test" ? [] : [
    {
      name: "_xxhash",
      zig_src: join(zigModulesDir, "xxhash", "module.zig"),
      c_srcs: [join(zigModulesDir, "xxhash", "xxhash.c")],
      c_flags: ["-DXXH_IMPLEMENTATION", "-DXXH_STATIC_LINKING_ONLY"],
      extra_includes: [join(zigModulesDir, "xxhash")],
    },
    {
      name: "_regex",
      c_srcs: [
        join(cModulesDir, "regex", "_regex.c"),
        join(cModulesDir, "regex", "_regex_unicode.c"),
      ],
      extra_includes: [join(cModulesDir, "regex")],
    },
    {
      name: "_cmsgpack",
      c_srcs: [join(cModulesDir, "msgpack", "_cmsgpack.c")],
      extra_includes: [join(cModulesDir, "msgpack")],
    },
    {
      name: "_markupsafe_speedups",
      c_srcs: [join(cModulesDir, "markupsafe", "_speedups.c")],
    },
    {
      name: "_simd",
      zig_src: join(zigModulesDir, "_simd", "module.zig"),
    },
    {
      name: "_zerobuf",
      zig_src: join(zigModulesDir, "_zerobuf", "module.zig"),
    },
    // _hashlib disabled — requires std.crypto API fixes for Zig 0.15.
    // CPython's built-in _md5, _sha1, _sha2, _sha3, _blake2 already provide hashing.
    // _json, _collections, _functools, binascii — CPython builds these as
    // built-ins already. Zig replacements disabled: they have compatibility
    // issues with new WASM features (tail-call, reference-types).
    // CPython's C versions work correctly with all features enabled.
    // zlib disabled — std.compress.flate API changed in Zig 0.15
  ];

  const builtModules: NativeModule[] = [];
  for (const mod of nativeModules) {
    const zigSrc = mod.zig_src;
    const cSrcs = mod.c_srcs || [];

    if (zigSrc && !existsSync(zigSrc)) {
      warn(`  Module ${mod.name} Zig source not found, skipping`);
      continue;
    }
    if (!zigSrc && cSrcs.length === 0) {
      warn(`  Module ${mod.name} has no sources, skipping`);
      continue;
    }
    const missing = cSrcs.filter((s) => !existsSync(s));
    if (missing.length > 0) {
      warn(`  Module ${mod.name} C source not found: ${missing[0]}, skipping`);
      continue;
    }

    info(`Compiling native module ${mod.name}...`);
    builtModules.push(mod);
    const modObjDir = join(BUILD_DIR, "Modules");
    mkdirSync(modObjDir, { recursive: true });

    // Compile C sources with zig cc
    const cObjs: string[] = [];
    for (const cSrc of cSrcs) {
      const cObjName = basename(cSrc, extname(cSrc)) + `_${mod.name}.o`;
      const cObj = join(modObjDir, cObjName);
      const cCmd = [
        zigCcScript,
        "-c",
        "-Os",
        `-I${CPYTHON_DIR}/Include`,
        `-I${CPYTHON_DIR}/Include/internal`,
        `-I${BUILD_DIR}`,
      ];
      for (const inc of mod.extra_includes || []) {
        cCmd.push(`-I${inc}`);
      }
      for (const flag of mod.c_flags || []) {
        cCmd.push(flag);
      }
      cCmd.push(cSrc, "-o", cObj);
      const cResult = spawnSync("bash", cCmd, { stdio: "inherit" });
      if (cResult.status !== 0) {
        error(`Failed to compile C source: ${cSrc}`);
      }
      cObjs.push(cObjName);
    }

    // Compile Zig source (if present)
    if (zigSrc) {
      const zigCmd = [
        "build-obj",
        "-target",
        "wasm32-wasi",
        "-OReleaseFast",
        "-lc",
        `-I${BUILD_DIR}`,
        `-I${CPYTHON_DIR}/Include`,
        `-I${CPYTHON_DIR}/Include/internal`,
      ];
      for (const inc of mod.extra_includes || []) {
        zigCmd.push(`-I${inc}`);
      }
      zigCmd.push(zigSrc, "--name", mod.name);
      const zigResult = spawnSync("zig", zigCmd, {
        cwd: modObjDir,
        stdio: "inherit",
      });
      if (zigResult.status !== 0) {
        error(`Failed to compile Zig source for ${mod.name}`);
      }
    }

    info(`  Built ${mod.name}: ${zigSrc ? "Zig + " : ""}${cObjs.length} C object(s)`);

    // Register as built-in module
    if (existsSync(configC) && statSync(configC).isFile()) {
      let content = readFileSync(configC, "utf-8");
      const initFunc = `PyInit_${mod.name}`;
      if (!content.includes(initFunc)) {
        content = content.replace(
          "/* -- ADDMODULE MARKER 1 -- */",
          `extern PyObject* ${initFunc}(void);\n/* -- ADDMODULE MARKER 1 -- */`,
        );
        content = content.replace(
          "/* -- ADDMODULE MARKER 2 -- */",
          `    {"${mod.name}", ${initFunc}},\n/* -- ADDMODULE MARKER 2 -- */`,
        );
        writeFileSync(configC, content);
        copyFileSync(configC, configCBase);
        info(`  ${mod.name} registered in config.c`);
      }
    }
  }

  // Step 3f: Register recipe modules in config.c. Recipe .a/.o files are
  // linked at wizer time (build-wizer.ts), but config.c registration must
  // happen here so the compiled config.o references the recipe PyInit_*
  // symbols at link time. Only register recipes whose build artifacts
  // already exist; missing artifacts would cause an undefined-symbol link
  // failure. Skip recipes whose native modules are already in
  // `nativeModules` above — linking both would duplicate symbols (mirrors
  // the skipRecipes set in build-wizer.ts).
  //
  // Only the "test" mode includes recipes; app builds are slimmer
  // and don't ship the recipe-backed extensions (pydantic-core, etc.).
  const skipRecipesPhase2 = new Set(["regex", "msgpack", "xxhash", "markupsafe"]);
  const recipesDefDir = join(ROOT_DIR, "recipes");
  const recipeBuildDir = join(ROOT_DIR, "build", "recipes");
  if (BUILD_MODE === "test" && existsSync(recipesDefDir) && existsSync(configC) && statSync(configC).isFile()) {
    let content = readFileSync(configC, "utf-8");
    let changed = false;
    for (const recipeFile of readdirSync(recipesDefDir)) {
      if (!recipeFile.endsWith(".json")) continue;
      const recipeName = recipeFile.replace(/\.json$/, "");
      if (skipRecipesPhase2.has(recipeName)) continue;
      const objDir = join(recipeBuildDir, recipeName, "obj");
      if (!existsSync(objDir)) continue;
      const hasArtifact = readdirSync(objDir).some(
        (f) => f.endsWith(".a") || f.endsWith(".o"),
      );
      if (!hasArtifact) continue;
      let recipeJson: { modules?: Record<string, string> };
      try {
        recipeJson = JSON.parse(
          readFileSync(join(recipesDefDir, recipeFile), "utf-8"),
        );
      } catch {
        continue;
      }
      const modules = recipeJson.modules ?? {};
      for (const [modPath, initFunc] of Object.entries(modules)) {
        if (content.includes(initFunc)) continue;
        content = content.replace(
          "/* -- ADDMODULE MARKER 1 -- */",
          `extern PyObject* ${initFunc}(void);\n/* -- ADDMODULE MARKER 1 -- */`,
        );
        content = content.replace(
          "/* -- ADDMODULE MARKER 2 -- */",
          `    {"${modPath}", ${initFunc}},\n/* -- ADDMODULE MARKER 2 -- */`,
        );
        info(`  recipe ${recipeName}: registered ${modPath} → ${initFunc}`);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(configC, content);
      copyFileSync(configC, configCBase);
    }
  }

  // Step 4: Build
  info("Building CPython with zig cc (ReleaseSmall)...");
  const makefile = join(BUILD_DIR, "Makefile");
  let makefileAppend = "\nMODULE_OBJS += Modules/pymode_imports.o\n";
  for (const mod of builtModules) {
    if (mod.replaces_builtin) {
      // Skip — will replace CPython's .o after make and re-link
      continue;
    }
    if (mod.zig_src) {
      makefileAppend += `MODULE_OBJS += Modules/${mod.name}.o\n`;
    }
    for (const cSrc of mod.c_srcs || []) {
      const cObjName = basename(cSrc, extname(cSrc)) + `_${mod.name}.o`;
      makefileAppend += `MODULE_OBJS += Modules/${cObjName}\n`;
    }
  }
  // Include recipe artifacts in the phase2 link too — config.c (just patched
  // above) now references their PyInit_* symbols. build-wizer.ts links them
  // again, but the phase2 link must resolve the symbols on its own. Skip
  // the same recipes as the registration block above to avoid duplicate
  // symbols with the in-tree native modules. Only in "test" mode.
  const phase2RecipeBuildDir = join(ROOT_DIR, "build", "recipes");
  if (BUILD_MODE === "test" && existsSync(phase2RecipeBuildDir)) {
    for (const recipe of readdirSync(phase2RecipeBuildDir)) {
      if (skipRecipesPhase2.has(recipe)) continue;
      const objDir = join(phase2RecipeBuildDir, recipe, "obj");
      if (!existsSync(objDir)) continue;
      for (const f of readdirSync(objDir)) {
        if (f.endsWith(".a") || f.endsWith(".o")) {
          makefileAppend += `MODULE_OBJS += ${join(objDir, f)}\n`;
        }
      }
    }
  }
  // Step 3g: Scan bundled side-modules (worker/src/extensions/*.wasm) and
  // generate `-Wl,--export-if-defined=<sym>` flags so wasm-ld retains the
  // symbols each side-module imports (libc + libpython + GOT.* names).
  // Without these exports, the dynamic linker at runtime can't satisfy the
  // side-module's imports — numpy's _multiarray_umath.wasm has ~568 of them.
  const extensionsDir = join(ROOT_DIR, "worker", "src", "extensions");
  const sideModuleWasms: string[] = [];
  if (existsSync(extensionsDir)) {
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (f.endsWith(".wasm")) sideModuleWasms.push(p);
      }
    };
    walk(extensionsDir);
  }
  let exportFlags = "";
  // Side-module dynamic linker is only relevant in the test runtime —
  // base/app deploys don't ship the side modules (numpy, etc.) so they
  // don't need the 550+ libc/libpython exports that bloat python.wasm.
  if (BUILD_MODE === "test" && sideModuleWasms.length > 0) {
    info(`Scanning ${sideModuleWasms.length} side-module wasm(s) for required exports...`);
    const extractScript = join(ROOT_DIR, "scripts", "extract-side-module-imports.mjs");
    const extractResult = spawnSync(
      "node",
      [extractScript, ...sideModuleWasms],
      { encoding: "utf-8" },
    );
    if (extractResult.status !== 0) {
      error(`extract-side-module-imports failed: ${extractResult.stderr}`);
    }
    const symbols = (extractResult.stdout || "")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
    info(`  ${symbols.length} symbols needed by side modules (after filtering C++ ABI)`);
    // --export-dynamic catches all default-visibility symbols (most of
    // CPython API). --export=<sym> for each hidden libc/compiler-rt
    // symbol the side module needs (sinf, memcpy, __addtf3, etc.).
    // Zig's wasm-ld wrapper doesn't accept @response-file or
    // --export-if-defined, so we inline every flag. ~553 entries × 30B
    // = ~16KB on the command line, well under ARG_MAX.
    const perSymbolExports = symbols.map(s => `-Wl,--export=${s}`).join(" ");
    // Note: --growable-table isn't supported by zig's wasm-ld wrapper;
    // the post-wizer restore step patches the table limits instead.
    exportFlags =
      ` -Wl,--export-dynamic` +
      ` -Wl,--export-table` +
      ` -Wl,--export=__stack_pointer` +
      ` -Wl,--export=__heap_base` +
      ` -Wl,--export=__heap_end` +
      ` ${perSymbolExports}`;
  }
  if (exportFlags) {
    // Inject into LDFLAGS via Makefile override so the final link picks it up.
    makefileAppend += `\nLDFLAGS += ${exportFlags}\n`;
  }
  writeFileSync(makefile, readFileSync(makefile, "utf-8") + makefileAppend);
  info("  Added Modules/pymode_imports.o to MODULE_OBJS");
  if (exportFlags) info(`  Added side-module export flags`);
  for (const mod of builtModules) {
    if (!mod.replaces_builtin) {
      info(`  Added ${mod.name} objects to MODULE_OBJS`);
    }
  }

  const buildLog = join(BUILD_DIR, "build.log");
  const makeResult = spawnSync("make", [`-j${ncpu()}`], {
    cwd: BUILD_DIR,
    stdio: ["inherit", "pipe", "pipe"],
  });
  // Write combined stdout+stderr to build.log
  const logContent =
    (makeResult.stdout ? makeResult.stdout.toString() : "") +
    (makeResult.stderr ? makeResult.stderr.toString() : "");
  writeFileSync(buildLog, logContent);
  // Step 4b: Replace CPython built-in .o files with our Zig versions and re-link.
  // CPython's make compiled its own _json.o, binascii.o etc. We overwrite them
  // with our optimized Zig versions and re-run the link step.
  const replacedModules = builtModules.filter(m => m.replaces_builtin);
  if (replacedModules.length > 0) {
    const modObjDir = join(BUILD_DIR, "Modules");
    for (const mod of replacedModules) {
      const zigObj = join(modObjDir, `${mod.name}.o`);
      if (existsSync(zigObj)) {
        info(`  Replaced CPython ${mod.name}.o with Zig version`);
      }
    }
    // Re-link with our replacement objects
    info("  Re-linking with Zig replacements...");
    const relinkResult = spawnSync("make", ["python.wasm", `-j${ncpu()}`], {
      cwd: BUILD_DIR,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const relinkLog = (relinkResult.stdout?.toString() || "") + (relinkResult.stderr?.toString() || "");
    writeFileSync(buildLog, logContent + "\n--- RELINK ---\n" + relinkLog);
    if (relinkResult.status !== 0) {
      warn("Re-link had errors. Check build.log");
    }
  } else if (makeResult.status !== 0) {
    warn("Build had errors. Check build.log");
  }

  // Step 5: Verify python.wasm exists
  let pythonWasm = join(BUILD_DIR, "python.wasm");
  if (!existsSync(pythonWasm)) {
    const pythonBin = join(BUILD_DIR, "python");
    if (existsSync(pythonBin)) {
      const fileResult = spawnSync("file", [pythonBin], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (fileResult.stdout && fileResult.stdout.includes("WebAssembly")) {
        renameSync(pythonBin, pythonWasm);
      } else {
        error(`python.wasm not found after build. Check ${buildLog}`);
      }
    } else {
      error(`python.wasm not found after build. Check ${buildLog}`);
    }
  }

  // Step 6: Optimize with wasm-opt (fan-out replay replaces asyncify)
  if (which("wasm-opt")) {
    const origSize = statSync(pythonWasm).size;

    info("Running wasm-opt -Oz --converge (size-first, fan-out replay handles async)...");
    const optimized = pythonWasm + ".opt";
    const optResult = spawnSync(
      "wasm-opt",
      [
        "-Oz",
        "--converge",
        "--strip-debug",
        "--strip-producers",
        "--strip-target-features",
        "--enable-simd",
        "--enable-relaxed-simd",
        "--enable-nontrapping-float-to-int",
        "--enable-bulk-memory",
        "--enable-bulk-memory-opt",
        "--enable-sign-ext",
        "--enable-mutable-globals",
        "--enable-multivalue",
        "--enable-tail-call",
        "--enable-reference-types",
        "--enable-extended-const",
        pythonWasm,
        "-o",
        optimized,
      ],
      { stdio: "inherit" },
    );
    if (optResult.status !== 0) {
      error("wasm-opt -Oz failed");
    }
    renameSync(optimized, pythonWasm);

    const newSize = statSync(pythonWasm).size;
    info(`optimized: ${origSize} -> ${newSize} bytes`);
  } else {
    warn("wasm-opt not found. Skipping optimization.");
    warn("Install binaryen: brew install binaryen (or apt install binaryen)");
  }

  // Step 7: Create runner script
  const runner = join(BUILD_DIR, "python.sh");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash
# Run zig-compiled CPython WASM via wasmtime
exec wasmtime run \\
    --wasm max-wasm-stack=8388608 \\
    --wasi preview2 \\
    --dir ${CPYTHON_DIR}::/ \\
    --env PYTHONPATH=/cross-build/wasm32-wasi/build/lib.wasi-wasm32-3.13 \\
    ${pythonWasm} -- "$@"
`,
  );
  chmodSync(runner, 0o755);

  // Step 8: Test
  info("Testing zig cc WASI build...");
  const testResult = spawnSync(
    runner,
    ["-c", "import sys; print(f'Python {sys.version} on {sys.platform}')"],
    { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
  );
  const output = (testResult.stdout || "") + (testResult.stderr || "");
  if (output.includes("Python")) {
    info(`SUCCESS: ${output.trim()}`);
  } else {
    warn("Build produced binary but test failed. Check build.log");
    console.log(output);
  }

  // Report sizes
  console.log();
  const wasmSize = statSync(pythonWasm).size;
  info("Phase 2 complete.");
  info(`  zig cc WASM size:   ${(wasmSize / 1048576).toFixed(1)}MB`);
  info(`  Binary: ${runner}`);
  console.log();
  info("Test with:");
  info(`  ${runner} -c "print('hello from zig-compiled WASI Python')"`);

  // Step 9: Wizer pre-initialization (if wizer is available)
  if (which("wizer") && which("wasm-opt")) {
    info("");
    info(`Wizer detected -- creating pre-initialized snapshot (mode=${BUILD_MODE})...`);
    const wizerScript = join(SCRIPT_DIR, "build-wizer.ts");
    const wizerEnv = {
      ...process.env,
      PYMODE_BUILD_MODE: BUILD_MODE,
      PYMODE_APP_PREIMPORTS_HEADER: APP_PREIMPORT_HEADER,
      // Forwarded so build-wizer.ts can mount the project's .py files
      // into mergedStdlib/app/ — see APP_PROJECT_DIR/APP_ENTRY_MODULE
      // handling there.
      PYMODE_APP_PROJECT_DIR: process.env.PYMODE_APP_PROJECT_DIR || "",
      PYMODE_APP_ENTRY_MODULE: process.env.PYMODE_APP_ENTRY_MODULE || "",
    };
    const wizerResult = spawnSync("npx", ["tsx", wizerScript], {
      stdio: "inherit",
      env: wizerEnv,
    });
    if (wizerResult.status !== 0) {
      error("build-wizer.ts failed");
    }
  } else {
    info("");
    info("Tip: install wizer (cargo install wizer --all-features) for ~5x faster cold starts");
  }
}

main();
