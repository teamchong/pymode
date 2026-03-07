#!/usr/bin/env python3
"""Build a python.wasm variant by linking base CPython + recipe objects.

Usage:
    python3 scripts/build-variant.py <recipe-name> [<recipe-name>...]

Example:
    python3 scripts/build-variant.py numpy                    # python-numpy.wasm
    python3 scripts/build-variant.py markupsafe frozenlist     # python-markupsafe-frozenlist.wasm

Produces: worker/src/python-<variant>.wasm
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CPYTHON = os.path.join(ROOT_DIR, "cpython")
BUILD_DIR = os.path.join(ROOT_DIR, "build", "zig-wasi")
RECIPES_DIR = os.path.join(ROOT_DIR, "recipes")
ZIG_CC = os.path.join(ROOT_DIR, "build", "zig-wrappers", "zig-cc")

ASYNC_IMPORTS = (
    "pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,"
    "pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,"
    "pymode.thread_spawn,pymode.thread_join,pymode.dl_open"
)


def sedi(pattern: str, replacement: str, filepath: str):
    """In-place sed replacement."""
    with open(filepath) as f:
        content = f.read()
    content = re.sub(pattern, replacement, content)
    with open(filepath, "w") as f:
        f.write(content)


def main():
    if len(sys.argv) < 2:
        print("Usage: build-variant.py <recipe-name> [<recipe-name>...]")
        print()
        print("Available recipes:")
        for r in sorted(glob.glob(os.path.join(RECIPES_DIR, "*.json"))):
            name = os.path.basename(r).replace(".json", "")
            with open(r) as f:
                version = json.load(f)["version"]
            print(f"  {name} ({version})")
        sys.exit(0)

    # Check prerequisites
    if not os.path.isfile(os.path.join(BUILD_DIR, "python.wasm")):
        print("Error: python.wasm not found. Run build-phase2.sh first.")
        sys.exit(1)
    if not os.access(ZIG_CC, os.X_OK):
        print("Error: zig-cc wrapper not found. Run build-phase2.sh first.")
        sys.exit(1)

    recipe_names = sys.argv[1:]
    variant_name = "-".join(recipe_names)
    output = os.path.join(ROOT_DIR, "worker", "src", f"python-{variant_name}.wasm")

    print(f"Building variant: python-{variant_name}.wasm")
    print(f"  Recipes: {' '.join(recipe_names)}")
    print()

    # Step 1: Build each recipe (compile objects)
    all_objs: list[str] = []
    all_modules: list[tuple[str, str]] = []  # (mod_path, init_func)
    extra_link_flags: list[str] = []
    site_packages: list[str] = []

    for recipe_name in recipe_names:
        recipe_path = os.path.join(RECIPES_DIR, f"{recipe_name}.json")
        if not os.path.isfile(recipe_path):
            print(f"Recipe not found: {recipe_name}")
            sys.exit(1)

        with open(recipe_path) as f:
            recipe = json.load(f)

        rtype = recipe["type"]

        if rtype == "custom":
            print(f"  [{recipe_name}] Custom build — checking for pre-built objects...")
            obj_dir = os.path.join(BUILD_DIR, "Modules", "numpy")
            objs = glob.glob(os.path.join(obj_dir, "*.o"))
            if objs:
                all_objs.extend(objs)
                print(f"    Found {len(objs)} objects")
            else:
                print(f"    No pre-built objects. Run build-recipe.py {recipe_name} first.")
                sys.exit(1)
        elif rtype == "rust":
            obj_dir = os.path.join(ROOT_DIR, "build", "recipes", recipe_name, "obj")
            if not os.path.isdir(obj_dir):
                print(f"  [{recipe_name}] Building Rust extension...")
                build_script = recipe["build_script"]
                subprocess.run(["bash", os.path.join(ROOT_DIR, build_script)], check=True)
            for archive in glob.glob(os.path.join(obj_dir, "*.a")):
                all_objs.append(archive)
            for obj in glob.glob(os.path.join(obj_dir, "*.o")):
                all_objs.append(obj)
            sizes = [os.path.getsize(a) for a in glob.glob(os.path.join(obj_dir, "*.a"))]
            if sizes:
                print(f"  [{recipe_name}] Rust archive: {sizes[0] // 1024}KB")
        else:
            obj_dir = os.path.join(ROOT_DIR, "build", "recipes", recipe_name, "obj")
            objs = glob.glob(os.path.join(obj_dir, "*.o"))
            if not objs:
                print(f"  [{recipe_name}] Compiling...")
                subprocess.run(
                    [sys.executable, os.path.join(SCRIPT_DIR, "build-recipe.py"), recipe_name, "--objects-only"],
                    check=True,
                )
                objs = glob.glob(os.path.join(obj_dir, "*.o"))
            all_objs.extend(objs)
            print(f"  [{recipe_name}] {len(objs)} objects")

        # Collect module registrations
        for mod_path, init_func in recipe.get("modules", {}).items():
            all_modules.append((mod_path, init_func))

        # Collect extra link flags
        extra_link_flags.extend(recipe.get("extra_link_flags", []))

        # Collect site-packages zips
        site_zip = os.path.join(ROOT_DIR, "build", "recipes", recipe_name, f"{recipe_name}-site-packages.zip")
        if os.path.isfile(site_zip):
            site_packages.append(site_zip)

    # Step 2: Generate config.c with module registrations
    print()
    print("  Generating config.c...")

    config_variant = os.path.join(BUILD_DIR, "Modules", "config_variant.c")
    config_base = os.path.join(BUILD_DIR, "Modules", "config.c.base")
    config_fallback = os.path.join(BUILD_DIR, "Modules", "config.c")

    if os.path.isfile(config_base):
        shutil.copy2(config_base, config_variant)
    else:
        shutil.copy2(config_fallback, config_variant)

    # Build extern declarations and inittab entries
    extern_decls = ""
    inittab_entries = ""
    for mod_path, init_func in all_modules:
        extern_decls += f"extern PyObject* {init_func}(void);\n"
        inittab_entries += f'    {{"{mod_path}", {init_func}}},\n'

    # Also add _pymode if not already there
    with open(config_variant) as f:
        config_content = f.read()

    if "PyInit__pymode" not in config_content:
        extern_decls = "extern PyObject* PyInit__pymode(void);\n" + extern_decls
        inittab_entries = '    {"_pymode", PyInit__pymode},\n' + inittab_entries

    # Insert before markers
    config_content = config_content.replace(
        "/* -- ADDMODULE MARKER 1 -- */",
        extern_decls + "/* -- ADDMODULE MARKER 1 -- */",
    )
    config_content = config_content.replace(
        "/* -- ADDMODULE MARKER 2 -- */",
        inittab_entries + "/* -- ADDMODULE MARKER 2 -- */",
    )

    with open(config_variant, "w") as f:
        f.write(config_content)

    # Compile config_variant.c
    print("  Compiling config_variant.c...")
    subprocess.run(
        ["bash", ZIG_CC, "-c", "-Os", "-DPy_BUILD_CORE",
         f"-I{CPYTHON}/Include", f"-I{CPYTHON}/Include/internal", f"-I{BUILD_DIR}",
         "-o", os.path.join(BUILD_DIR, "Modules", "config_variant.o"), config_variant],
        check=True,
    )

    # Step 3: Collect all base .o files (excluding config.o and dynload_shlib.o)
    print("  Collecting link objects...")
    link_objs: list[str] = []
    skip_names = {"config.o", "dynload_shlib.o", "config_variant.o"}

    for root, _, files in os.walk(BUILD_DIR):
        # Skip recipe and numpy directories
        if "/recipes/" in root or "/Modules/numpy/" in root:
            continue
        for f in files:
            if f.endswith(".o") and f not in skip_names:
                link_objs.append(os.path.join(root, f))

    # Add our variant config
    link_objs.append(os.path.join(BUILD_DIR, "Modules", "config_variant.o"))

    # Add recipe objects
    link_objs.extend(all_objs)

    print(f"  Total objects: {len(link_objs)}")

    # Step 4: Link
    print(f"  Linking python-{variant_name}.wasm...")
    link_cmd = [
        "bash", ZIG_CC, "-s",
        "-o", output,
        *link_objs,
        "-ldl", "-lwasi-emulated-signal", "-lwasi-emulated-getpid",
        "-lwasi-emulated-process-clocks", "-lm",
        *extra_link_flags,
    ]

    result = subprocess.run(link_cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print()
        print("  ERROR: Link failed!")
        print(result.stderr)
        sys.exit(1)

    pre_size = os.path.getsize(output)
    print(f"  Raw size: {pre_size / 1048576:.1f}MB")

    # Step 5: Asyncify with wasm-opt
    if shutil.which("wasm-opt"):
        print("  Running wasm-opt --asyncify...")
        opt_output = output + ".opt"
        subprocess.run(
            ["wasm-opt", "-O2", "--asyncify",
             "--enable-simd",
             "--enable-nontrapping-float-to-int",
             "--enable-bulk-memory",
             "--enable-sign-ext",
             "--enable-mutable-globals",
             f"--pass-arg=asyncify-imports@{ASYNC_IMPORTS}",
             "--pass-arg=asyncify-ignore-indirect",
             output, "-o", opt_output],
            check=True,
        )
        os.replace(opt_output, output)
        post_size = os.path.getsize(output)
        print(f"  Asyncified: {post_size / 1048576:.1f}MB")
    else:
        print("  WARNING: wasm-opt not found, skipping asyncify")

    # Step 6: Merge site-packages
    if site_packages:
        print("  Merging site-packages...")
        merged_zip = os.path.join(ROOT_DIR, "worker", "src", "extension-site-packages.zip")
        seen: set[str] = set()
        with zipfile.ZipFile(merged_zip, "w", zipfile.ZIP_STORED) as merged:
            for zip_path in site_packages:
                if not os.path.exists(zip_path):
                    continue
                with zipfile.ZipFile(zip_path) as zf:
                    for name in zf.namelist():
                        if name not in seen:
                            seen.add(name)
                            merged.writestr(name, zf.read(name))
        print(f"  {len(seen)} files in extension-site-packages.zip")

    print()
    print(f"Done! python-{variant_name}.wasm -> worker/src/")
    print(f"  Size: {os.path.getsize(output) / 1048576:.1f}MB")


if __name__ == "__main__":
    main()
