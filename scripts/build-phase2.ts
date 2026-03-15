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
# zig cc wrapper for wasm32-wasi cross-compilation
# Applies ReleaseSmall: -Os, strip, no debug info

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
        # Replace optimization flags with -Os (ReleaseSmall)
        -O0|-O1|-O2|-O3|-Og) ARGS+=("-Os"); HAS_OPT=1 ;;
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

# Ensure -Os is always set for ReleaseSmall
if [ "$HAS_OPT" -eq 0 ]; then
    ARGS+=("-Os")
fi

# Strip debug info for smaller binary
ARGS+=("-s")

# WASI defines CLOCK_REALTIME/CLOCK_MONOTONIC as pointers, not integers.
# Zig's clang treats -Wint-conversion as an error by default, so demote it.
ARGS+=("-Wno-error=int-conversion" "-Wno-error=incompatible-pointer-types" "-Wno-error=date-time")

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
      "CFLAGS=-Os -DNDEBUG -fno-strict-aliasing -msimd128",
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

  // Step 3b: Patch pyconfig.h - use CPython pthread types instead of musl
  info("Patching pyconfig.h for WASI...");
  const pyconfig = join(BUILD_DIR, "pyconfig.h");
  sedi(pyconfig, /^#define HAVE_PTHREAD_H 1/m, "/* #undef HAVE_PTHREAD_H */");

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

  // Step 3e: Build native extension modules (Zig and/or C)
  const zigModulesDir = join(ROOT_DIR, "zig-modules");
  const cModulesDir = join(ROOT_DIR, "c-modules");
  const nativeModules: NativeModule[] = [
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
    {
      name: "_json",
      zig_src: join(zigModulesDir, "_json", "module.zig"),
    },
    {
      name: "_collections",
      zig_src: join(zigModulesDir, "_collections", "module.zig"),
    },
    {
      name: "_functools",
      zig_src: join(zigModulesDir, "_functools", "module.zig"),
    },
    {
      name: "binascii",
      zig_src: join(zigModulesDir, "binascii", "module.zig"),
    },
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

  // Step 4: Build
  info("Building CPython with zig cc (ReleaseSmall)...");
  const makefile = join(BUILD_DIR, "Makefile");
  let makefileAppend = "\nMODULE_OBJS += Modules/pymode_imports.o\n";
  for (const mod of builtModules) {
    if (mod.zig_src) {
      makefileAppend += `MODULE_OBJS += Modules/${mod.name}.o\n`;
    }
    for (const cSrc of mod.c_srcs || []) {
      const cObjName = basename(cSrc, extname(cSrc)) + `_${mod.name}.o`;
      makefileAppend += `MODULE_OBJS += Modules/${cObjName}\n`;
    }
  }
  writeFileSync(makefile, readFileSync(makefile, "utf-8") + makefileAppend);
  info("  Added Modules/pymode_imports.o to MODULE_OBJS");
  for (const mod of builtModules) {
    info(`  Added ${mod.name} objects to MODULE_OBJS`);
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
  if (makeResult.status !== 0) {
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

    info("Running wasm-opt -O2 (no asyncify — fan-out replay handles async)...");
    const optimized = pythonWasm + ".opt";
    const optResult = spawnSync(
      "wasm-opt",
      [
        "-O2",
        "--enable-simd",
        "--enable-nontrapping-float-to-int",
        "--enable-bulk-memory",
        "--enable-sign-ext",
        "--enable-mutable-globals",
        pythonWasm,
        "-o",
        optimized,
      ],
      { stdio: "inherit" },
    );
    if (optResult.status !== 0) {
      error("wasm-opt -O2 failed");
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
    info("Wizer detected -- creating pre-initialized snapshot...");
    const wizerScript = join(SCRIPT_DIR, "build-wizer.ts");
    const wizerResult = spawnSync("npx", ["tsx", wizerScript], { stdio: "inherit" });
    if (wizerResult.status !== 0) {
      error("build-wizer.ts failed");
    }
  } else {
    info("");
    info("Tip: install wizer (cargo install wizer --all-features) for ~5x faster cold starts");
  }
}

main();
