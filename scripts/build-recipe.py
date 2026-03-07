#!/usr/bin/env python3
"""Build a C extension package from a recipe for wasm32-wasi.

Usage:
    python3 scripts/build-recipe.py <recipe-name> [--objects-only]

Produces .o files in build/recipes/<name>/ and optionally links into python.wasm variant.
With --objects-only, just compiles without linking (used by build-variant.py).
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CPYTHON = os.path.join(ROOT_DIR, "cpython")
BUILD_DIR = os.path.join(ROOT_DIR, "build", "zig-wasi")


def main():
    if len(sys.argv) < 2:
        print("Usage: build-recipe.py <recipe-name> [--objects-only]")
        sys.exit(1)

    recipe_name = sys.argv[1]
    objects_only = "--objects-only" in sys.argv

    recipe_path = os.path.join(ROOT_DIR, "recipes", f"{recipe_name}.json")
    if not os.path.isfile(recipe_path):
        print(f"Recipe not found: {recipe_path}")
        sys.exit(1)

    with open(recipe_path) as f:
        recipe = json.load(f)

    name = recipe["name"]
    version = recipe["version"]
    pypi = recipe.get("pypi", name)
    rtype = recipe["type"]

    print(f"Building {name} {version} (type: {rtype})...")

    # Custom recipes use their own build script
    if rtype == "custom":
        build_script = recipe["build_script"]
        print(f"  Running custom build: {build_script}")
        os.execvp("bash", ["bash", os.path.join(ROOT_DIR, build_script)])

    # Download source from PyPI
    src_dir = os.path.join(ROOT_DIR, "build", "recipes", name)
    download_dir = os.path.join(src_dir, "download")
    obj_dir = os.path.join(src_dir, "obj")
    os.makedirs(download_dir, exist_ok=True)
    os.makedirs(obj_dir, exist_ok=True)

    pkg_src = os.path.join(src_dir, "src")
    if not os.path.isdir(pkg_src):
        print(f"  Downloading {pypi}=={version} from PyPI...")
        subprocess.run(
            ["pip3", "download", f"{pypi}=={version}", "--no-binary=:all:", "--no-deps", "-d", download_dir],
            capture_output=True,
        )

        # Extract
        tarballs = glob.glob(os.path.join(download_dir, "*.tar.gz"))
        zipfiles = glob.glob(os.path.join(download_dir, "*.zip"))
        os.makedirs(pkg_src, exist_ok=True)

        if tarballs:
            subprocess.run(
                ["tar", "xzf", tarballs[0], "-C", pkg_src, "--strip-components=1"],
                check=True,
            )
        elif zipfiles:
            src_tmp = os.path.join(src_dir, "src-tmp")
            subprocess.run(["unzip", "-q", zipfiles[0], "-d", src_tmp], check=True)
            # Move contents up
            entries = os.listdir(src_tmp)
            if len(entries) == 1:
                inner = os.path.join(src_tmp, entries[0])
                for item in os.listdir(inner):
                    shutil.move(os.path.join(inner, item), pkg_src)
            else:
                for item in entries:
                    shutil.move(os.path.join(src_tmp, item), pkg_src)
            shutil.rmtree(src_tmp)
        else:
            print("  ERROR: No source archive found")
            sys.exit(1)

    # Check prerequisites
    pyconfig = os.path.join(BUILD_DIR, "pyconfig.h")
    if not os.path.isfile(pyconfig):
        print("Error: CPython build not found. Run build-phase2.sh first.")
        sys.exit(1)

    # Base compiler flags
    cflags = [
        "-target", "wasm32-wasi", "-c", "-Os",
        "-DNDEBUG",
        f"-I{CPYTHON}/Include",
        f"-I{CPYTHON}/Include/cpython",
        f"-I{BUILD_DIR}",
    ]

    # Add recipe includes
    for inc in recipe.get("includes", []):
        cflags.append(f"-I{pkg_src}/{inc}")

    # Add recipe cflags
    cflags.extend(recipe.get("cflags", []))

    # Run Cython if needed
    if rtype == "cython":
        for pyx in recipe.get("cython_sources", []):
            c_file = pyx.replace(".pyx", ".c")
            if not os.path.isfile(os.path.join(pkg_src, c_file)):
                print(f"  Cythonizing {pyx}...")
                for cmd in ["cython3", "cython"]:
                    if shutil.which(cmd):
                        subprocess.run(
                            [cmd, os.path.join(pkg_src, pyx), "-o", os.path.join(pkg_src, c_file)],
                            check=True,
                        )
                        break
                else:
                    try:
                        subprocess.run(
                            [sys.executable, "-m", "cython", os.path.join(pkg_src, pyx),
                             "-o", os.path.join(pkg_src, c_file)],
                            check=True,
                        )
                    except subprocess.CalledProcessError:
                        print("  ERROR: Cython not found. Install with: pip3 install cython")
                        sys.exit(1)

    # Compile C sources
    sources = recipe["sources"]
    success = 0
    fail = 0

    for src in sources:
        outname = os.path.basename(src).replace(".c", "").replace("/", "_")
        outfile = os.path.join(obj_dir, f"{name}_{outname}.o")
        src_path = os.path.join(pkg_src, src)

        if not os.path.isfile(src_path):
            print(f"  SKIP: {src} (not found)")
            continue

        result = subprocess.run(
            ["zig", "cc"] + cflags + ["-o", outfile, src_path],
            capture_output=True,
        )
        if result.returncode == 0:
            success += 1
        else:
            print(f"  FAIL: {src}")
            fail += 1

    # Compile vendor sources (e.g., bundled zstd)
    for pattern in recipe.get("vendor_sources", []):
        for src_path in sorted(glob.glob(os.path.join(pkg_src, pattern))):
            outname = os.path.basename(src_path).replace(".c", "").replace("/", "_")
            outfile = os.path.join(obj_dir, f"vendor_{outname}.o")
            result = subprocess.run(
                ["zig", "cc"] + cflags + ["-o", outfile, src_path],
                capture_output=True,
            )
            if result.returncode == 0:
                success += 1
            else:
                print(f"  FAIL: {src_path}")
                fail += 1

    print(f"  Compiled: {success} ok, {fail} failed")
    if fail > 0:
        print("  WARNING: Some files failed to compile")

    # Bundle Python files into a zip
    python_packages = recipe.get("python_packages", [])
    if python_packages:
        print("  Bundling Python files...")
        site_pkg_zip = os.path.join(src_dir, f"{name}-site-packages.zip")
        with zipfile.ZipFile(site_pkg_zip, "w", zipfile.ZIP_STORED) as zf:
            for pkg_dir_name in python_packages:
                pkg_path = os.path.join(pkg_src, pkg_dir_name)
                if not os.path.isdir(pkg_path):
                    continue
                skip_dirs = {"tests", "testing", "test", "__pycache__"}
                for root, dirs, files in os.walk(pkg_path):
                    dirs[:] = [d for d in dirs if d not in skip_dirs]
                    for f in files:
                        if f.endswith(".py"):
                            filepath = os.path.join(root, f)
                            arcname = os.path.relpath(filepath, pkg_src)
                            zf.write(filepath, arcname)
        count = len(zipfile.ZipFile(site_pkg_zip).namelist())
        size_kb = os.path.getsize(site_pkg_zip) // 1024
        print(f"  {count} Python files -> {size_kb}KB")

    obj_count = len(glob.glob(os.path.join(obj_dir, "*.o")))
    print(f"  Output: {obj_count} object files in build/recipes/{name}/obj/")

    if objects_only:
        print("  Done (objects only).")
        return

    print()
    print(f"Done! To include in a variant, run:")
    print(f"  ./scripts/build-variant.sh {name}")


if __name__ == "__main__":
    main()
