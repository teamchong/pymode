#!/usr/bin/env python3
"""Phase 2: Build CPython for wasm32-wasi using zig cc (no WASI SDK).

Uses ReleaseSmall equivalent: -Os, strip debug info, minimize binary size.
Prerequisites: python3, wasmtime, zig, Phase 1 native build.
"""

import os
import platform
import re
import shutil
import subprocess
import sys
import textwrap

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CPYTHON_DIR = os.path.join(ROOT_DIR, "cpython")
BUILD_DIR = os.path.join(ROOT_DIR, "build", "zig-wasi")
ZIG_WRAPPER_DIR = os.path.join(ROOT_DIR, "build", "zig-wrappers")

GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
RED = "\033[0;31m"
NC = "\033[0m"


def info(msg: str):
    print(f"{GREEN}[INFO]{NC} {msg}")


def warn(msg: str):
    print(f"{YELLOW}[WARN]{NC} {msg}")


def error(msg: str):
    print(f"{RED}[ERROR]{NC} {msg}", file=sys.stderr)
    sys.exit(1)


def ncpu() -> int:
    return os.cpu_count() or 2


def sedi(filepath: str, pattern: str, replacement: str):
    """In-place sed replacement."""
    with open(filepath) as f:
        content = f.read()
    content = re.sub(pattern, replacement, content, flags=re.MULTILINE)
    with open(filepath, "w") as f:
        f.write(content)


def main():
    # Check prerequisites
    for cmd in ["python3", "wasmtime", "zig"]:
        if not shutil.which(cmd):
            error(f"{cmd} not found")

    zig_version = subprocess.check_output(["zig", "version"], text=True).strip()
    info(f"Using zig {zig_version}")

    if not os.path.isdir(CPYTHON_DIR):
        error("CPython source not found. Run build-phase1.sh first to clone it.")

    # Step 1: Locate or build the native Python (needed for cross-compilation)
    native_python = ""
    for candidate in [
        os.path.join(CPYTHON_DIR, "cross-build", "build", "python.exe"),
        os.path.join(CPYTHON_DIR, "cross-build", "build", "python"),
        os.path.join(ROOT_DIR, "build", "native", "python.exe"),
        os.path.join(ROOT_DIR, "build", "native", "python"),
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            native_python = candidate
            break

    if not native_python:
        info("No native Python found. Building one (out-of-tree)...")
        native_build_dir = os.path.join(ROOT_DIR, "build", "native")
        os.makedirs(native_build_dir, exist_ok=True)
        subprocess.run(
            [os.path.join(CPYTHON_DIR, "configure"), f"--prefix={native_build_dir}/install"],
            cwd=native_build_dir, check=True,
        )
        subprocess.run(["make", f"-j{ncpu()}"], cwd=native_build_dir, check=True)
        for name in ["python.exe", "python"]:
            path = os.path.join(native_build_dir, name)
            if os.path.isfile(path) and os.access(path, os.X_OK):
                native_python = path
                break

    info(f"Using native Python: {native_python}")

    # Step 2: Create zig cc wrapper scripts
    os.makedirs(ZIG_WRAPPER_DIR, exist_ok=True)

    zig_cc_script = os.path.join(ZIG_WRAPPER_DIR, "zig-cc")
    with open(zig_cc_script, "w") as f:
        f.write(textwrap.dedent("""\
            #!/usr/bin/env bash
            # zig cc wrapper for wasm32-wasi cross-compilation
            # Applies ReleaseSmall: -Os, strip, no debug info

            ARGS=()
            HAS_OPT=0
            for arg in "$@"; do
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
                    -z) continue ;;  # next arg is the z-flag value
                    stack-size=*) continue ;;
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

            exec zig cc -target wasm32-wasi "${ARGS[@]}"
        """))
    os.chmod(zig_cc_script, 0o755)

    for name, content in [
        ("zig-ar", "#!/usr/bin/env bash\nexec zig ar \"$@\"\n"),
        ("zig-ranlib", "#!/usr/bin/env bash\nexec zig ranlib \"$@\"\n"),
    ]:
        path = os.path.join(ZIG_WRAPPER_DIR, name)
        with open(path, "w") as f:
            f.write(content)
        os.chmod(path, 0o755)

    zig_cpp_script = os.path.join(ZIG_WRAPPER_DIR, "zig-cpp")
    with open(zig_cpp_script, "w") as f:
        f.write(textwrap.dedent("""\
            #!/usr/bin/env bash
            ARGS=()
            for arg in "$@"; do
                case "$arg" in
                    -pthread|-lpthread|-ldl|-lm|-lutil|-lrt) continue ;;
                    -framework|CoreFoundation|SystemConfiguration) continue ;;
                    *) ARGS+=("$arg") ;;
                esac
            done
            exec zig cc -target wasm32-wasi -E "${ARGS[@]}"
        """))
    os.chmod(zig_cpp_script, 0o755)

    # Step 3: Out-of-tree build with zig cc
    info("Configuring CPython with zig cc for wasm32-wasi (ReleaseSmall)...")
    os.makedirs(BUILD_DIR, exist_ok=True)

    # Clean previous zig-wasi build
    for item in os.listdir(BUILD_DIR):
        path = os.path.join(BUILD_DIR, item)
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

    config_cache = os.path.join(os.path.dirname(BUILD_DIR), "config.cache")
    if os.path.exists(config_cache):
        os.remove(config_cache)

    # Detect build triple
    system = platform.system()
    machine = platform.machine()
    if system == "Darwin":
        build_triple = f"{machine}-apple-darwin"
    elif system == "Linux":
        build_triple = f"{machine}-pc-linux-gnu"
    else:
        build_triple = f"{machine}-unknown-{system.lower()}"

    # Disabled modules
    disabled_modules = [
        "py_cv_module__bz2=n/a", "py_cv_module__lzma=n/a", "py_cv_module_zlib=n/a",
        "py_cv_module__socket=n/a", "py_cv_module__ctypes=n/a", "py_cv_module_select=n/a",
        "py_cv_module_faulthandler=n/a", "py_cv_module_resource=n/a", "py_cv_module_grp=n/a",
        "py_cv_module_pwd=n/a", "py_cv_module_fcntl=n/a", "py_cv_module_mmap=n/a",
        "py_cv_module_termios=n/a", "py_cv_module_syslog=n/a",
        "py_cv_module__multiprocessing=n/a", "py_cv_module__posixsubprocess=n/a",
        "py_cv_module__posixshmem=n/a", "py_cv_module__curses=n/a",
        "py_cv_module__curses_panel=n/a", "py_cv_module__dbm=n/a",
        "py_cv_module__gdbm=n/a", "py_cv_module__tkinter=n/a", "py_cv_module__scproxy=n/a",
    ]

    configure_env = os.environ.copy()
    configure_env["CONFIG_SITE"] = os.path.join(ROOT_DIR, "scripts", "config.site-wasi")
    configure_env["PKG_CONFIG"] = "false"

    subprocess.run(
        [
            os.path.join(CPYTHON_DIR, "configure"),
            "--host=wasm32-wasi",
            f"--build={build_triple}",
            f"--with-build-python={native_python}",
            f"CC={zig_cc_script}",
            f"CPP={zig_cpp_script}",
            f"AR={os.path.join(ZIG_WRAPPER_DIR, 'zig-ar')}",
            f"RANLIB={os.path.join(ZIG_WRAPPER_DIR, 'zig-ranlib')}",
            "CFLAGS=-Os -DNDEBUG -fno-strict-aliasing -msimd128",
            "LDFLAGS=-s",
            "--disable-ipv6", "--disable-shared", "--without-ensurepip",
            "--without-pymalloc", "--disable-test-modules", "--config-cache",
            "ac_cv_file__dev_ptmx=no", "ac_cv_file__dev_ptc=no",
            *disabled_modules,
        ],
        cwd=BUILD_DIR, env=configure_env, check=True,
    )

    # Step 3b: Patch pyconfig.h - use CPython pthread types instead of musl
    info("Patching pyconfig.h for WASI...")
    pyconfig = os.path.join(BUILD_DIR, "pyconfig.h")
    sedi(pyconfig, r"^#define HAVE_PTHREAD_H 1", "/* #undef HAVE_PTHREAD_H */")

    # Step 3b2: Save clean config.c as base (before variant patching)
    config_c = os.path.join(BUILD_DIR, "Modules", "config.c")
    config_c_base = os.path.join(BUILD_DIR, "Modules", "config.c.base")
    if os.path.isfile(config_c) and not os.path.isfile(config_c_base):
        shutil.copy2(config_c, config_c_base)
        info("  Saved config.c.base (clean copy for variant builds)")

    # Register _pymode as a built-in module
    info("Registering _pymode built-in module...")
    if os.path.isfile(config_c):
        with open(config_c) as f:
            content = f.read()
        if "PyInit__pymode" not in content:
            content = content.replace(
                "/* -- ADDMODULE MARKER 1 -- */",
                "extern PyObject* PyInit__pymode(void);\n/* -- ADDMODULE MARKER 1 -- */",
            )
            content = content.replace(
                "/* -- ADDMODULE MARKER 2 -- */",
                '    {"_pymode", PyInit__pymode},\n/* -- ADDMODULE MARKER 2 -- */',
            )
            with open(config_c, "w") as f:
                f.write(content)
            # Update base copy too
            shutil.copy2(config_c, config_c_base)
            info("  _pymode registered in config.c")

    # Step 3c: Compile dynload_pymode shim
    info("Compiling dynload_pymode shim...")
    shims_dir = os.path.join(ROOT_DIR, "lib", "wasi-shims")
    os.makedirs(os.path.join(BUILD_DIR, "Python"), exist_ok=True)
    subprocess.run(
        ["bash", zig_cc_script, "-c", "-Os", "-DPy_BUILD_CORE",
         f"-I{CPYTHON_DIR}/Include", f"-I{CPYTHON_DIR}/Include/internal", f"-I{BUILD_DIR}",
         os.path.join(shims_dir, "dynload_pymode.c"),
         "-o", os.path.join(BUILD_DIR, "Python", "dynload_pymode.o")],
        check=True,
    )
    info("  Built Python/dynload_pymode.o")

    # Step 3d: Compile pymode host imports
    info("Compiling pymode host imports...")
    imports_dir = os.path.join(ROOT_DIR, "lib", "pymode-imports")
    imports_c = os.path.join(imports_dir, "pymode_imports.c")
    if os.path.isfile(imports_c):
        os.makedirs(os.path.join(BUILD_DIR, "Modules"), exist_ok=True)
        subprocess.run(
            ["bash", zig_cc_script, "-c", "-Os", "-DPy_BUILD_CORE",
             f"-I{imports_dir}", f"-I{CPYTHON_DIR}/Include",
             f"-I{CPYTHON_DIR}/Include/internal", f"-I{BUILD_DIR}",
             imports_c, "-o", os.path.join(BUILD_DIR, "Modules", "pymode_imports.o")],
            check=True,
        )
        info("  Built Modules/pymode_imports.o")

    # Step 3e: Build native extension modules (Zig and/or C)
    zig_modules_dir = os.path.join(ROOT_DIR, "zig-modules")
    c_modules_dir = os.path.join(ROOT_DIR, "c-modules")
    native_modules = [
        {
            "name": "_xxhash",
            "zig_src": os.path.join(zig_modules_dir, "xxhash", "module.zig"),
            "c_srcs": [os.path.join(zig_modules_dir, "xxhash", "xxhash.c")],
            "c_flags": ["-DXXH_IMPLEMENTATION", "-DXXH_STATIC_LINKING_ONLY"],
            "extra_includes": [os.path.join(zig_modules_dir, "xxhash")],
        },
        {
            "name": "_regex",
            "c_srcs": [
                os.path.join(c_modules_dir, "regex", "_regex.c"),
                os.path.join(c_modules_dir, "regex", "_regex_unicode.c"),
            ],
            "extra_includes": [os.path.join(c_modules_dir, "regex")],
        },
    ]
    built_modules = []
    for mod in native_modules:
        zig_src = mod.get("zig_src")
        c_srcs = mod.get("c_srcs", [])
        if zig_src and not os.path.isfile(zig_src):
            warn(f"  Module {mod['name']} Zig source not found, skipping")
            continue
        if not zig_src and not c_srcs:
            warn(f"  Module {mod['name']} has no sources, skipping")
            continue
        if c_srcs and not os.path.isfile(c_srcs[0]):
            warn(f"  Module {mod['name']} C source not found, skipping")
            continue
        info(f"Compiling native module {mod['name']}...")
        built_modules.append(mod)
        mod_obj_dir = os.path.join(BUILD_DIR, "Modules")
        os.makedirs(mod_obj_dir, exist_ok=True)

        # Compile C sources with zig cc
        c_objs = []
        for c_src in c_srcs:
            c_obj_name = os.path.splitext(os.path.basename(c_src))[0] + f"_{mod['name']}.o"
            c_obj = os.path.join(mod_obj_dir, c_obj_name)
            c_cmd = [
                "bash", zig_cc_script, "-c", "-Os",
                f"-I{CPYTHON_DIR}/Include", f"-I{CPYTHON_DIR}/Include/internal", f"-I{BUILD_DIR}",
            ]
            for inc in mod.get("extra_includes", []):
                c_cmd.append(f"-I{inc}")
            for flag in mod.get("c_flags", []):
                c_cmd.append(flag)
            c_cmd.extend([c_src, "-o", c_obj])
            subprocess.run(c_cmd, check=True)
            c_objs.append(c_obj_name)

        # Compile Zig source (if present)
        if zig_src:
            zig_cmd = [
                "zig", "build-obj",
                "-target", "wasm32-wasi",
                "-OReleaseFast",
                "-lc",
                f"-I{BUILD_DIR}", f"-I{CPYTHON_DIR}/Include", f"-I{CPYTHON_DIR}/Include/internal",
            ]
            for inc in mod.get("extra_includes", []):
                zig_cmd.append(f"-I{inc}")
            zig_cmd.extend([zig_src, "--name", mod["name"]])
            subprocess.run(zig_cmd, check=True, cwd=mod_obj_dir)

        info(f"  Built {mod['name']}: {'Zig + ' if zig_src else ''}{len(c_objs)} C object(s)")

        # Register as built-in module
        if os.path.isfile(config_c):
            with open(config_c) as f:
                content = f.read()
            init_func = f"PyInit_{mod['name']}"
            if init_func not in content:
                content = content.replace(
                    "/* -- ADDMODULE MARKER 1 -- */",
                    f"extern PyObject* {init_func}(void);\n/* -- ADDMODULE MARKER 1 -- */",
                )
                content = content.replace(
                    "/* -- ADDMODULE MARKER 2 -- */",
                    f'    {{"{mod["name"]}", {init_func}}},\n/* -- ADDMODULE MARKER 2 -- */',
                )
                with open(config_c, "w") as f:
                    f.write(content)
                shutil.copy2(config_c, config_c_base)
                info(f"  {mod['name']} registered in config.c")

    # Step 4: Build
    info("Building CPython with zig cc (ReleaseSmall)...")
    makefile = os.path.join(BUILD_DIR, "Makefile")
    with open(makefile, "a") as f:
        f.write("\nMODULE_OBJS += Modules/pymode_imports.o\n")
        for mod in built_modules:
            if mod.get("zig_src"):
                f.write(f"MODULE_OBJS += Modules/{mod['name']}.o\n")
            for c_src in mod.get("c_srcs", []):
                c_obj_name = os.path.splitext(os.path.basename(c_src))[0] + f"_{mod['name']}.o"
                f.write(f"MODULE_OBJS += Modules/{c_obj_name}\n")
    info("  Added Modules/pymode_imports.o to MODULE_OBJS")
    for mod in built_modules:
        info(f"  Added {mod['name']} objects to MODULE_OBJS")

    build_log = os.path.join(BUILD_DIR, "build.log")
    with open(build_log, "w") as log:
        result = subprocess.run(
            ["make", f"-j{ncpu()}"],
            cwd=BUILD_DIR, stdout=log, stderr=subprocess.STDOUT,
        )
    if result.returncode != 0:
        warn("Build had errors. Check build.log")

    # Step 5: Verify python.wasm exists
    python_wasm = os.path.join(BUILD_DIR, "python.wasm")
    if not os.path.isfile(python_wasm):
        python_bin = os.path.join(BUILD_DIR, "python")
        if os.path.isfile(python_bin):
            result = subprocess.run(["file", python_bin], capture_output=True, text=True)
            if "WebAssembly" in result.stdout:
                os.rename(python_bin, python_wasm)
            else:
                error(f"python.wasm not found after build. Check {build_log}")
        else:
            error(f"python.wasm not found after build. Check {build_log}")

    # Step 6: Asyncify + optimize with wasm-opt
    if shutil.which("wasm-opt"):
        orig_size = os.path.getsize(python_wasm)

        async_imports = (
            "pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,"
            "pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,"
            "pymode.thread_spawn,pymode.thread_join,pymode.dl_open"
        )

        info("Running wasm-opt --asyncify (async imports: tcp_recv, http_fetch, kv_*, r2_*, d1_exec)...")
        shutil.copy2(python_wasm, python_wasm + ".pre-asyncify")
        asyncified = python_wasm + ".asyncified"
        subprocess.run(
            ["wasm-opt", "-O2", "--asyncify",
             "--enable-simd", "--enable-nontrapping-float-to-int",
             "--enable-bulk-memory", "--enable-sign-ext", "--enable-mutable-globals",
             f"--pass-arg=asyncify-imports@{async_imports}",
             "--pass-arg=asyncify-ignore-indirect",
             python_wasm, "-o", asyncified],
            check=True,
        )
        os.replace(asyncified, python_wasm)

        new_size = os.path.getsize(python_wasm)
        info(f"asyncify + optimize: {orig_size} -> {new_size} bytes")
    else:
        warn("wasm-opt not found. Skipping asyncify — trampoline fallback will be used at runtime.")
        warn("Install binaryen: brew install binaryen (or apt install binaryen)")

    # Step 7: Create runner script
    runner = os.path.join(BUILD_DIR, "python.sh")
    with open(runner, "w") as f:
        f.write(f"""\
#!/usr/bin/env bash
# Run zig-compiled CPython WASM via wasmtime
exec wasmtime run \\
    --wasm max-wasm-stack=8388608 \\
    --wasi preview2 \\
    --dir {CPYTHON_DIR}::/ \\
    --env PYTHONPATH=/cross-build/wasm32-wasi/build/lib.wasi-wasm32-3.13 \\
    {python_wasm} -- "$@"
""")
    os.chmod(runner, 0o755)

    # Step 8: Test
    info("Testing zig cc WASI build...")
    result = subprocess.run(
        [runner, "-c", "import sys; print(f'Python {sys.version} on {sys.platform}')"],
        capture_output=True, text=True, timeout=30,
    )
    output = result.stdout + result.stderr
    if "Python" in output:
        info(f"SUCCESS: {output.strip()}")
    else:
        warn("Build produced binary but test failed. Check build.log")
        print(output)

    # Report sizes
    print()
    wasm_size = os.path.getsize(python_wasm)
    info("Phase 2 complete.")
    info(f"  zig cc WASM size:   {wasm_size / 1048576:.1f}MB")
    info(f"  Binary: {runner}")
    print()
    info("Test with:")
    info(f"  {runner} -c \"print('hello from zig-compiled WASI Python')\"")

    # Step 9: Wizer pre-initialization (if wizer is available)
    if shutil.which("wizer") and shutil.which("wasm-opt"):
        info("")
        info("Wizer detected — creating pre-initialized snapshot...")
        subprocess.run(
            [sys.executable, os.path.join(SCRIPT_DIR, "build-wizer.py")],
            check=True,
        )
    else:
        info("")
        info("Tip: install wizer (cargo install wizer --all-features) for ~5x faster cold starts")


if __name__ == "__main__":
    main()
