#!/usr/bin/env python3
"""Build a C extension package as a .wasm side module for PyMode.

Side modules are loaded at runtime by PythonDO via the dl_open/dl_sym
host imports. They share linear memory with the main python.wasm and
export PyInit_<name> functions that CPython calls through the standard
_PyImport_FindSharedFuncptr() flow in dynload_pymode.c.

Usage:
    python3 scripts/build-extension.py markupsafe
    python3 scripts/build-extension.py simplejson==3.19.3
    python3 scripts/build-extension.py --list    # show supported packages
    python3 scripts/build-extension.py --all     # build all supported

Output:
    .pymode/extensions/{name}/{module}.wasm  — side module
    .pymode/extensions/{name}/*.py           — pure Python files from package
"""

import glob
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
EXT_DIR = os.path.join(ROOT_DIR, ".pymode", "extensions")
CPYTHON_DIR = os.path.join(ROOT_DIR, "cpython")
BUILD_DIR = os.path.join(ROOT_DIR, "build", "zig-wasi")

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


CFLAGS_COMMON = [
    "-target", "wasm32-wasi",
    "-Os", "-DNDEBUG",
    f"-I{CPYTHON_DIR}/Include",
    f"-I{CPYTHON_DIR}/Include/internal",
    f"-I{BUILD_DIR}",
    "-Wno-error=int-conversion",
    "-Wno-error=incompatible-pointer-types",
]


def compile_side_module(output_wasm: str, src_files: list[str]) -> bool:
    """Compile C files into a .wasm side module."""
    with tempfile.TemporaryDirectory() as obj_dir:
        objects = []
        for src in src_files:
            obj_name = os.path.basename(src).replace(".c", ".o")
            obj_path = os.path.join(obj_dir, obj_name)
            info(f"  Compiling {os.path.basename(src)}")
            result = subprocess.run(
                ["zig", "cc"] + CFLAGS_COMMON + ["-c", src, "-o", obj_path],
                capture_output=True,
            )
            if result.returncode != 0:
                warn(f"  Failed to compile {os.path.basename(src)}")
                return False
            objects.append(obj_path)

        if not objects:
            error("No object files produced")

        info(f"  Linking -> {os.path.basename(output_wasm)}")
        result = subprocess.run(
            ["zig", "cc", "-target", "wasm32-wasi",
             "-nostdlib", "-Os", "-s",
             "-Wl,--import-memory",
             "-Wl,--allow-undefined",
             "-Wl,--no-entry",
             "-Wl,--export-dynamic",
             *objects,
             "-o", output_wasm],
            capture_output=True,
        )
        if result.returncode != 0:
            if result.stderr:
                error(f"  Link error: {result.stderr.decode(errors='replace')}")
            return False
        return True


def download_source(name: str, dest: str):
    """Download and extract a package source."""
    dl_dir = os.path.join(dest, "dl")
    os.makedirs(dl_dir, exist_ok=True)

    # Try sdist first (has C source), fall back to wheel
    result = subprocess.run(
        ["pip3", "download", "--no-binary", ":all:", name, "-d", dl_dir],
        capture_output=True,
    )
    if result.returncode != 0:
        result = subprocess.run(
            ["pip3", "download", name, "-d", dl_dir],
            capture_output=True,
        )
        if result.returncode != 0:
            error(f"Failed to download {name}")

    sdists = glob.glob(os.path.join(dl_dir, "*.tar.gz"))
    wheels = glob.glob(os.path.join(dl_dir, "*.whl"))

    if sdists:
        subprocess.run(
            ["tar", "xzf", sdists[0], "-C", dest, "--strip-components=1"],
            check=True,
        )
    elif wheels:
        subprocess.run(
            [sys.executable, "-m", "zipfile", "-e", wheels[0], os.path.join(dest, "src")],
            check=True,
        )
    else:
        error(f"No sdist or wheel found for {name}")


def copy_py_files(src_dir: str, dest_dir: str):
    """Copy .py files from source to destination."""
    for pyfile in glob.glob(os.path.join(src_dir, "*.py")):
        shutil.copy2(pyfile, dest_dir)


def build_ext(name: str):
    """Build a single extension."""
    pkg_dir = os.path.join(EXT_DIR, name)
    os.makedirs(pkg_dir, exist_ok=True)

    extensions = {
        "markupsafe": {
            "info_msg": "Building markupsafe (_speedups.wasm)...",
            "src_dirs": ["src/markupsafe", "markupsafe"],
            "c_file": "_speedups.c",
            "wasm": "_speedups.wasm",
        },
        "simplejson": {
            "info_msg": "Building simplejson (_speedups.wasm)...",
            "src_dirs": ["simplejson"],
            "c_file": "_speedups.c",
            "wasm": "_speedups.wasm",
        },
        "msgpack": {
            "info_msg": "Building msgpack (_cmsgpack.wasm)...",
            "src_dirs": ["msgpack"],
            "c_file": "_cmsgpack.c",
            "wasm": "_cmsgpack.wasm",
        },
        "pyyaml": {
            "info_msg": "Building pyyaml (_yaml.wasm)...",
            "src_dirs": ["yaml", "."],
            "c_file": "_yaml.c",
            "wasm": "_yaml.wasm",
        },
    }

    # Normalize name
    lookup = name.lower()
    if lookup not in extensions:
        error(f"Unknown extension: {name}. Run with --list to see supported packages.")

    ext = extensions[lookup]
    info(ext["info_msg"])
    download_source(name, pkg_dir)

    # Find source directory
    src_dir = None
    for candidate in ext["src_dirs"]:
        path = os.path.join(pkg_dir, candidate)
        if os.path.isfile(os.path.join(path, ext["c_file"])):
            src_dir = path
            break

    if not src_dir:
        error(f"{ext['c_file']} not found")

    c_path = os.path.join(src_dir, ext["c_file"])
    wasm_path = os.path.join(pkg_dir, ext["wasm"])

    if not compile_side_module(wasm_path, [c_path]):
        error(f"Failed to compile {name}")

    copy_py_files(src_dir, pkg_dir)

    # Report
    for wasm_file in glob.glob(os.path.join(pkg_dir, "*.wasm")):
        size = os.path.getsize(wasm_file)
        info(f"Built: {wasm_file} ({size // 1024}KB)")


def list_extensions():
    """List supported extensions."""
    print("Supported C extension packages:")
    print("  markupsafe   - HTML escaping (1 C file, ~15KB .wasm)")
    print("  simplejson   - Fast JSON encoder/decoder (1 C file)")
    print("  msgpack      - MessagePack serialization (1 C file)")
    print("  pyyaml       - YAML parser (requires libyaml headers)")
    print()
    print("Usage:")
    print("  python3 scripts/build-extension.py markupsafe")
    print("  python3 scripts/build-extension.py --all")
    print()
    print("Output goes to .pymode/extensions/<name>/<module>.wasm")
    print("These .wasm files are loaded at runtime by PythonDO via dl_open/dl_sym.")


def build_all():
    """Build all supported extensions."""
    failed = 0
    for ext in ["markupsafe", "simplejson", "msgpack"]:
        try:
            build_ext(ext)
        except SystemExit:
            warn(f"Failed to build {ext}")
            failed += 1

    if failed == 0:
        info("All extensions built successfully")
    else:
        warn(f"{failed} extension(s) failed to build")


def main():
    # Check prerequisites
    if not shutil.which("zig"):
        error("zig not found. Install: https://ziglang.org/download/")
    if not os.path.isdir(os.path.join(CPYTHON_DIR, "Include")):
        error("CPython not found. Run build-phase1.sh first.")
    if not os.path.isfile(os.path.join(BUILD_DIR, "pyconfig.h")):
        error("pyconfig.h not found. Run build-phase2.py first.")

    if len(sys.argv) < 2:
        error(f"Usage: {sys.argv[0]} <package-name> | --list | --all")

    arg = sys.argv[1]
    if arg in ("--list", "-l"):
        list_extensions()
    elif arg in ("--all", "-a"):
        build_all()
    else:
        build_ext(arg)


if __name__ == "__main__":
    main()
