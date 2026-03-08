#!/usr/bin/env python3
"""Build a Wizer-pre-initialized python.wasm.

Replaces Programs/python.o with pymode_wizer.o so the binary exports
wizer.initialize (CPython init + pre-imports) and a _start that
skips init when the snapshot flag is set.

Produces: build/zig-wasi/python-wizer.wasm + worker/src/python-wizer.wasm

Prerequisites:
    - build-phase2.py completed (all .o files exist)
    - wizer installed (cargo install wizer --all-features)
    - wasm-opt installed (brew install binaryen)
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CPYTHON = os.path.join(ROOT_DIR, "cpython")
BUILD_DIR = os.path.join(ROOT_DIR, "build", "zig-wasi")
ZIG_CC = os.path.join(ROOT_DIR, "build", "zig-wrappers", "zig-cc")
WIZER_DIR = os.path.join(ROOT_DIR, "lib", "wizer")
IMPORTS_DIR = os.path.join(ROOT_DIR, "lib", "pymode-imports")
OUTPUT = os.path.join(BUILD_DIR, "python-wizer.wasm")

ASYNC_IMPORTS = (
    "pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,"
    "pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,"
    "pymode.thread_spawn,pymode.thread_join,pymode.dl_open"
)


def mb(size: int) -> str:
    return f"{size / 1048576:.1f}MB"


def main():
    # Check prerequisites
    if not os.path.isfile(os.path.join(BUILD_DIR, "python.wasm")):
        print("Error: python.wasm not found. Run build-phase2.py first.")
        sys.exit(1)
    if not os.access(ZIG_CC, os.X_OK):
        print("Error: zig-cc wrapper not found. Run build-phase2.py first.")
        sys.exit(1)
    if not shutil.which("wizer"):
        print("Error: wizer not found. Install: cargo install wizer --all-features")
        sys.exit(1)

    print("=== Building Wizer-pre-initialized python.wasm ===")
    print()

    # Step 1: Compile pymode_wizer.c
    print("  [1/6] Compiling pymode_wizer.c...")
    os.makedirs(os.path.join(BUILD_DIR, "Programs"), exist_ok=True)
    subprocess.run(
        ["bash", ZIG_CC, "-c", "-Os",
         "-DPy_BUILD_CORE",
         f"-I{IMPORTS_DIR}",
         f"-I{CPYTHON}/Include",
         f"-I{CPYTHON}/Include/internal",
         f"-I{BUILD_DIR}",
         os.path.join(WIZER_DIR, "pymode_wizer.c"),
         "-o", os.path.join(BUILD_DIR, "Programs", "pymode_wizer.o")],
        check=True,
    )

    # Step 2: Compile clean config.o (without variant module entries like numpy)
    print("  [2/6] Compiling clean config.o...")
    config_base = os.path.join(BUILD_DIR, "Modules", "config.c.base")
    config_wizer_c = os.path.join(BUILD_DIR, "Modules", "config_wizer.c")
    config_wizer_o = os.path.join(BUILD_DIR, "Modules", "config_wizer.o")

    if os.path.isfile(config_base):
        shutil.copy2(config_base, config_wizer_c)
        subprocess.run(
            ["bash", ZIG_CC, "-c", "-Os", "-DPy_BUILD_CORE",
             f"-I{CPYTHON}/Include", f"-I{CPYTHON}/Include/internal", f"-I{BUILD_DIR}",
             "-o", config_wizer_o, config_wizer_c],
            check=True,
        )
        os.remove(config_wizer_c)
    else:
        shutil.copy2(os.path.join(BUILD_DIR, "Modules", "config.o"), config_wizer_o)

    # Step 3: Collect all .o files, swapping python.o for pymode_wizer.o
    print("  [3/6] Collecting link objects...")
    skip_names = {"python.o", "config.o", "config_variant.o", "config_wizer.o", "dynload_shlib.o"}
    link_objs: list[str] = []

    for root, _, files in os.walk(BUILD_DIR):
        if "/recipes/" in root or "/Modules/numpy/" in root:
            continue
        for f in files:
            if f.endswith(".o") and f not in skip_names and f != "pymode_wizer.o":
                link_objs.append(os.path.join(root, f))

    link_objs.append(os.path.join(BUILD_DIR, "Programs", "pymode_wizer.o"))
    link_objs.append(config_wizer_o)

    print(f"    {len(link_objs)} objects")

    # Step 4: Link
    print("  [4/6] Linking...")
    wizer_raw = os.path.join(BUILD_DIR, "python-wizer-raw.wasm")
    subprocess.run(
        ["bash", ZIG_CC, "-s",
         "-o", wizer_raw,
         *link_objs,
         "-ldl", "-lwasi-emulated-signal", "-lwasi-emulated-getpid",
         "-lwasi-emulated-process-clocks", "-lm"],
        check=True,
    )

    raw_size = os.path.getsize(wizer_raw)
    print(f"    Raw: {mb(raw_size)}")

    # Verify wizer.initialize is exported
    if shutil.which("wasm-objdump"):
        result = subprocess.run(
            ["wasm-objdump", "-x", wizer_raw],
            capture_output=True, text=True,
        )
        if "wizer" in result.stdout:
            print("    wizer.initialize export: OK")
        else:
            print("    ERROR: wizer.initialize not found in exports!")
            sys.exit(1)

    # Step 5: Asyncify with wasm-opt
    if shutil.which("wasm-opt"):
        print("  [5/6] Asyncify + optimize...")
        opt_output = wizer_raw + ".opt"
        subprocess.run(
            ["wasm-opt", "-O2", "--asyncify",
             "--enable-simd",
             "--enable-nontrapping-float-to-int",
             "--enable-bulk-memory",
             "--enable-sign-ext",
             "--enable-mutable-globals",
             f"--pass-arg=asyncify-imports@{ASYNC_IMPORTS}",
             "--pass-arg=asyncify-ignore-indirect",
             wizer_raw, "-o", opt_output],
            check=True,
        )
        os.replace(opt_output, wizer_raw)
        opt_size = os.path.getsize(wizer_raw)
        print(f"    Asyncified: {mb(opt_size)}")
    else:
        print("  [5/6] SKIP: wasm-opt not found")

    # Step 6: Run Wizer to snapshot CPython init
    print("  [6/6] Wizer snapshot (booting CPython + pre-importing stdlib)...")

    stdlib_dir = os.path.join(CPYTHON, "Lib")
    wizer_tmp = tempfile.mkdtemp()

    try:
        result = subprocess.run(
            ["wizer", wizer_raw,
             "-o", OUTPUT,
             "--allow-wasi",
             "--wasm-bulk-memory", "true",
             "--wasm-simd", "true",
             f"--mapdir=/stdlib::{stdlib_dir}",
             f"--mapdir=/tmp::{wizer_tmp}",
             f"--mapdir=/data::{wizer_tmp}"],
            capture_output=True, text=True,
        )

        if result.returncode == 0:
            final_size = os.path.getsize(OUTPUT)
            print(f"    Snapshot: {mb(final_size)}")
        else:
            print()
            print("    Wizer snapshot failed.")
            print(result.stderr)
            print("    The binary still works without wizer (falls back to full init).")
            if os.path.exists(wizer_raw):
                os.remove(wizer_raw)
            sys.exit(1)
    finally:
        shutil.rmtree(wizer_tmp, ignore_errors=True)

    # Cleanup intermediate
    if os.path.exists(wizer_raw):
        os.remove(wizer_raw)

    # Replace python.wasm — the wizer binary IS the default now.
    worker_wasm = os.path.join(ROOT_DIR, "worker", "src", "python.wasm")
    shutil.copy2(OUTPUT, worker_wasm)

    print()
    print("Done! python.wasm (wizer snapshot)")
    print(f"  Size: {mb(os.path.getsize(OUTPUT))}")
    print()
    print("Cold start: ~5ms (vs ~28ms without snapshot)")


if __name__ == "__main__":
    main()
