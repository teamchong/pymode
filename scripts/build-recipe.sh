#!/usr/bin/env bash
# Build a C extension package from a recipe for wasm32-wasi.
#
# Usage:
#   ./scripts/build-recipe.sh <recipe-name> [--objects-only]
#
# Produces .o files in build/recipes/<name>/ and optionally links into python.wasm variant.
# With --objects-only, just compiles without linking (used by build-variant.sh).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"

RECIPE_NAME="${1:?Usage: build-recipe.sh <recipe-name>}"
OBJECTS_ONLY=false
[[ "${2:-}" == "--objects-only" ]] && OBJECTS_ONLY=true

RECIPE="$ROOT_DIR/recipes/${RECIPE_NAME}.json"
[ -f "$RECIPE" ] || { echo "Recipe not found: $RECIPE"; exit 1; }

# Parse recipe JSON
NAME=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['name'])")
VERSION=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['version'])")
PYPI=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r.get('pypi', r['name']))")
TYPE=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['type'])")

echo "Building $NAME $VERSION (type: $TYPE)..."

# Custom recipes use their own build script
if [ "$TYPE" = "custom" ]; then
    BUILD_SCRIPT=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['build_script'])")
    echo "  Running custom build: $BUILD_SCRIPT"
    exec bash "$ROOT_DIR/$BUILD_SCRIPT"
fi

# Download source from PyPI
SRC_DIR="$ROOT_DIR/build/recipes/$NAME"
DOWNLOAD_DIR="$SRC_DIR/download"
mkdir -p "$DOWNLOAD_DIR" "$SRC_DIR/obj"

if [ ! -d "$SRC_DIR/src" ]; then
    echo "  Downloading $PYPI==$VERSION from PyPI..."
    pip3 download "$PYPI==$VERSION" --no-binary :all: --no-deps -d "$DOWNLOAD_DIR" 2>/dev/null

    # Extract
    TARBALL=$(ls "$DOWNLOAD_DIR"/*.tar.gz 2>/dev/null | head -1)
    if [ -n "$TARBALL" ]; then
        mkdir -p "$SRC_DIR/src"
        tar xzf "$TARBALL" -C "$SRC_DIR/src" --strip-components=1
    else
        # Try zip
        ZIPFILE=$(ls "$DOWNLOAD_DIR"/*.zip 2>/dev/null | head -1)
        if [ -n "$ZIPFILE" ]; then
            mkdir -p "$SRC_DIR/src"
            unzip -q "$ZIPFILE" -d "$SRC_DIR/src-tmp"
            mv "$SRC_DIR/src-tmp"/*/* "$SRC_DIR/src/" 2>/dev/null || mv "$SRC_DIR/src-tmp"/* "$SRC_DIR/src/"
            rm -rf "$SRC_DIR/src-tmp"
        else
            echo "  ERROR: No source archive found"
            exit 1
        fi
    fi
fi

PKG_SRC="$SRC_DIR/src"

# Check prerequisites
[ -f "$BUILD_DIR/pyconfig.h" ] || { echo "Error: CPython build not found. Run build-phase2.sh first."; exit 1; }

# Base compiler flags
CFLAGS=(
    -target wasm32-wasi -c -Os
    -DNDEBUG
    "-I$CPYTHON/Include"
    "-I$CPYTHON/Include/cpython"
    "-I$BUILD_DIR"
)

# Add recipe includes
INCLUDES=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(i) for i in r.get('includes', [])]")
for inc in $INCLUDES; do
    CFLAGS+=("-I$PKG_SRC/$inc")
done

# Add recipe cflags
RECIPE_CFLAGS=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(f) for f in r.get('cflags', [])]")
for flag in $RECIPE_CFLAGS; do
    CFLAGS+=("$flag")
done

# Run Cython if needed
if [ "$TYPE" = "cython" ]; then
    CYTHON_SRCS=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(s) for s in r.get('cython_sources', [])]")
    for pyx in $CYTHON_SRCS; do
        c_file="${pyx%.pyx}.c"
        if [ ! -f "$PKG_SRC/$c_file" ]; then
            echo "  Cythonizing $pyx..."
            if command -v cython3 &>/dev/null; then
                cython3 "$PKG_SRC/$pyx" -o "$PKG_SRC/$c_file"
            elif command -v cython &>/dev/null; then
                cython "$PKG_SRC/$pyx" -o "$PKG_SRC/$c_file"
            elif python3 -c "import Cython" 2>/dev/null; then
                python3 -m cython "$PKG_SRC/$pyx" -o "$PKG_SRC/$c_file"
            else
                echo "  ERROR: Cython not found. Install with: pip3 install cython"
                exit 1
            fi
        fi
    done
fi

# Compile C sources
SOURCES=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(s) for s in r['sources']]")
SUCCESS=0
FAIL=0

for src in $SOURCES; do
    outname=$(basename "${src%.c}" | tr '/' '_')
    outfile="$SRC_DIR/obj/${NAME}_${outname}.o"

    if [ ! -f "$PKG_SRC/$src" ]; then
        echo "  SKIP: $src (not found)"
        continue
    fi

    if zig cc "${CFLAGS[@]}" -o "$outfile" "$PKG_SRC/$src" 2>&1; then
        SUCCESS=$((SUCCESS + 1))
    else
        echo "  FAIL: $src"
        FAIL=$((FAIL + 1))
    fi
done

# Compile vendor sources (e.g., bundled zstd)
VENDOR_SRCS=$(python3 -c "
import json, glob, os
r=json.load(open('$RECIPE'))
for pattern in r.get('vendor_sources', []):
    for f in sorted(glob.glob(os.path.join('$PKG_SRC', pattern))):
        print(f)
" 2>/dev/null)

for src in $VENDOR_SRCS; do
    outname=$(basename "${src%.c}" | tr '/' '_')
    outfile="$SRC_DIR/obj/vendor_${outname}.o"

    if zig cc "${CFLAGS[@]}" -o "$outfile" "$src" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        echo "  FAIL: $src"
        FAIL=$((FAIL + 1))
    fi
done

echo "  Compiled: $SUCCESS ok, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
    echo "  WARNING: Some files failed to compile"
fi

# Bundle Python files into a zip
PYTHON_PKGS=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(p) for p in r.get('python_packages', [])]")
if [ -n "$PYTHON_PKGS" ]; then
    echo "  Bundling Python files..."
    SITE_PKG_ZIP="$SRC_DIR/${NAME}-site-packages.zip"
    cd "$PKG_SRC"
    python3 -c "
import zipfile, os, sys
with zipfile.ZipFile('$SITE_PKG_ZIP', 'w', zipfile.ZIP_STORED) as zf:
    for pkg_dir in sys.argv[1:]:
        if not os.path.isdir(pkg_dir):
            continue
        for root, dirs, files in os.walk(pkg_dir):
            dirs[:] = [d for d in dirs if d not in ('tests', 'testing', 'test', '__pycache__')]
            for f in files:
                if f.endswith('.py'):
                    path = os.path.join(root, f)
                    zf.write(path)
count = len(zipfile.ZipFile('$SITE_PKG_ZIP').namelist())
print(f'  {count} Python files -> {os.path.getsize(\"$SITE_PKG_ZIP\") // 1024}KB')
" $PYTHON_PKGS
    cd "$ROOT_DIR"
fi

OBJ_COUNT=$(ls "$SRC_DIR/obj/"*.o 2>/dev/null | wc -l | tr -d ' ')
echo "  Output: $OBJ_COUNT object files in build/recipes/$NAME/obj/"

if [ "$OBJECTS_ONLY" = true ]; then
    echo "  Done (objects only)."
    exit 0
fi

echo ""
echo "Done! To include in a variant, run:"
echo "  ./scripts/build-variant.sh $NAME"
