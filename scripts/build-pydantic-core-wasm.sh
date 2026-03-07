#!/usr/bin/env bash
# Build pydantic_core (Rust + PyO3) for wasm32-wasip1.
#
# pydantic_core uses PyO3 to expose Rust validation/serialization as a
# CPython C extension. PyO3's `generate-import-lib` feature creates
# synthetic import libs for cross-compilation without needing libpython.
#
# Prerequisites:
#   rustup target add wasm32-wasip1
#   python3 (host) — for generate_self_schema.py
#   CPython headers from build-phase2.sh
#
# Output: build/recipes/pydantic-core/obj/_pydantic_core.o
#         build/recipes/pydantic-core/pydantic-core-site-packages.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"

SRC_DIR="$ROOT_DIR/build/recipes/pydantic-core"
mkdir -p "$SRC_DIR/obj"

# ── Download source ──────────────────────────────────────────────
if [ ! -d "$SRC_DIR/src" ]; then
    echo "Downloading pydantic-core 2.33.2..."
    DOWNLOAD_DIR="$SRC_DIR/download"
    mkdir -p "$DOWNLOAD_DIR"
    pip3 download pydantic-core==2.33.2 --no-binary :all: --no-deps -d "$DOWNLOAD_DIR" 2>/dev/null
    TARBALL=$(ls "$DOWNLOAD_DIR"/*.tar.gz 2>/dev/null | head -1)
    mkdir -p "$SRC_DIR/src"
    tar xzf "$TARBALL" -C "$SRC_DIR/src" --strip-components=1
fi

PKG_SRC="$SRC_DIR/src"

# ── Check prerequisites ─────────────────────────────────────────
command -v rustup >/dev/null 2>&1 || { echo "ERROR: rustup not found"; exit 1; }
command -v cargo >/dev/null 2>&1 || { echo "ERROR: cargo not found"; exit 1; }
[ -f "$BUILD_DIR/pyconfig.h" ] || { echo "ERROR: CPython build not found. Run build-phase2.sh first."; exit 1; }

# Ensure wasm32-wasip1 target is installed
if ! rustup target list --installed | grep -q wasm32-wasip1; then
    echo "Installing wasm32-wasip1 Rust target..."
    rustup target add wasm32-wasip1
fi

# ── Generate self_schema.py ──────────────────────────────────────
cd "$PKG_SRC"
if [ ! -f src/self_schema.py ]; then
    echo "Generating self_schema.py..."
    python3 generate_self_schema.py
fi

# ── Configure PyO3 cross-compilation ────────────────────────────
# PyO3 needs to know the target Python version and where headers are.
# generate-import-lib creates a fake libpython for linking.
export PYO3_CROSS_PYTHON_VERSION=3.13
export PYO3_CROSS_LIB_DIR="$BUILD_DIR/build/lib.wasi-wasm32-3.13"
export PYO3_PYTHON="$(which python3)"

# Point to our CPython headers
export CFLAGS="-I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$BUILD_DIR"

# ── Build ────────────────────────────────────────────────────────
echo "Building pydantic_core for wasm32-wasip1..."

# Build as staticlib so we get a .a with relocatable objects
# instead of a cdylib .wasm that can't be linked into python.wasm
#
# Patch Cargo.toml to add staticlib crate type
if ! grep -q 'staticlib' Cargo.toml; then
    sed -i.bak 's/crate-type = \["cdylib", "rlib"\]/crate-type = ["cdylib", "rlib", "staticlib"]/' Cargo.toml
fi

cargo build \
    --target wasm32-wasip1 \
    --release \
    --features extension-module \
    2>&1 | tail -20

# ── Extract objects ──────────────────────────────────────────────
# The staticlib .a contains all objects needed
STATIC_LIB=$(find target/wasm32-wasip1/release -name "lib_pydantic_core.a" | head -1)
if [ -n "$STATIC_LIB" ]; then
    echo "Extracting objects from $STATIC_LIB..."
    cp "$STATIC_LIB" "$SRC_DIR/obj/_pydantic_core.a"
    echo "  Output: $SRC_DIR/obj/_pydantic_core.a"
else
    # Fallback: check for .wasm
    WASM_LIB=$(find target/wasm32-wasip1/release -name "_pydantic_core.wasm" | head -1)
    if [ -n "$WASM_LIB" ]; then
        echo "Found cdylib: $WASM_LIB"
        cp "$WASM_LIB" "$SRC_DIR/obj/_pydantic_core.wasm"
        echo "  Output: $SRC_DIR/obj/_pydantic_core.wasm"
        echo "  NOTE: cdylib needs wasm-ld to merge into python.wasm"
    else
        echo "ERROR: No build output found"
        find target/wasm32-wasip1/release -name "*pydantic*" -o -name "*.a" -o -name "*.wasm" 2>/dev/null
        exit 1
    fi
fi

# ── Bundle Python files ──────────────────────────────────────────
echo "Bundling Python files..."
SITE_PKG_ZIP="$SRC_DIR/pydantic-core-site-packages.zip"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$SITE_PKG_ZIP', 'w', zipfile.ZIP_STORED) as zf:
    pkg = 'python/pydantic_core'
    for root, dirs, files in os.walk(pkg):
        dirs[:] = [d for d in dirs if d not in ('__pycache__', 'tests')]
        for f in files:
            if f.endswith(('.py', '.pyi', '.typed')):
                full = os.path.join(root, f)
                # Strip 'python/' prefix so import pydantic_core works
                arcname = os.path.relpath(full, 'python')
                zf.write(full, arcname)
count = len(zipfile.ZipFile('$SITE_PKG_ZIP').namelist())
print(f'  {count} Python files -> {os.path.getsize(\"$SITE_PKG_ZIP\") // 1024}KB')
"

cd "$ROOT_DIR"
echo ""
echo "Done! To include in a variant:"
echo "  ./scripts/build-variant.sh pydantic-core"
