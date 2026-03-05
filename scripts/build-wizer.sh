#!/usr/bin/env bash
# Build Wizer snapshot of CPython for fast cold starts.
#
# Requires: python.wasm (from build-phase2.sh), wizer, wasm-opt
#
# What this does:
#   1. Compiles pymode_wizer.c (the split entry point) and links it
#      into python.wasm, replacing the default main()
#   2. Runs wizer to execute __wizer_initialize at build time
#   3. Snapshots the linear memory (interpreter warm, stdlib imported)
#   4. At request time: ~5ms cold start instead of ~28ms
#
# Usage: ./scripts/build-wizer.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON_DIR="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"
ZIG_WRAPPER_DIR="$ROOT_DIR/build/zig-wrappers"
WIZER_DIR="$ROOT_DIR/lib/wizer"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# Check prerequisites
[ -f "$BUILD_DIR/python.wasm" ] || error "python.wasm not found. Run build-phase2.sh first."
command -v wizer >/dev/null 2>&1 || error "wizer not found. Install: cargo install wizer --all-features"
command -v wasm-opt >/dev/null 2>&1 || error "wasm-opt not found. Install: brew install binaryen"

# Check for zig-cc wrapper
[ -x "$ZIG_WRAPPER_DIR/zig-cc" ] || error "zig-cc wrapper not found. Run build-phase2.sh first."

# Step 1: Compile the Wizer entry point
info "Compiling pymode_wizer.c..."
WIZER_OBJ_DIR="$BUILD_DIR/wizer"
mkdir -p "$WIZER_OBJ_DIR"

"$ZIG_WRAPPER_DIR/zig-cc" -c -Os \
    -I"$CPYTHON_DIR/Include" \
    -I"$CPYTHON_DIR/Include/internal" \
    -I"$BUILD_DIR" \
    "$WIZER_DIR/pymode_wizer.c" \
    -o "$WIZER_OBJ_DIR/pymode_wizer.o"

info "  Built pymode_wizer.o"

# Step 2: Re-link python.wasm with the Wizer entry point
# We need to replace the default main() from Programs/python.o with our version.
# The simplest approach: link our pymode_wizer.o which provides main() and
# __wizer_initialize, using --allow-multiple-definition to override the original.
info "Re-linking python.wasm with Wizer entry point..."

# Find all the object files and libraries that make up python.wasm
# We use the build log to reconstruct the link command, or re-run make
# with our extra object file

# First, create a library from our wizer entry point
"$ZIG_WRAPPER_DIR/zig-ar" rcs "$WIZER_OBJ_DIR/libpymode_wizer.a" "$WIZER_OBJ_DIR/pymode_wizer.o"

# Copy the original python.wasm before modification
cp "$BUILD_DIR/python.wasm" "$BUILD_DIR/python-no-wizer.wasm"

# Re-link: add our wizer entry point with --allow-multiple-definition
# so our main() overrides the default one from Programs/python.o
SHIMS_OBJ_DIR="$BUILD_DIR/shims"
PYMODE_OBJ_DIR="$BUILD_DIR/pymode-imports"

cd "$BUILD_DIR"
# Use make to rebuild with our extra object
LDFLAGS="-s -L$SHIMS_OBJ_DIR -lwasi_shims -L$PYMODE_OBJ_DIR -lpymode_imports -L$WIZER_OBJ_DIR -lpymode_wizer -Wl,--allow-undefined -Wl,--allow-multiple-definition" \
    make -j1 python.wasm 2>&1 | tail -5 || true

# Check if rebuild worked
if [ ! -f "$BUILD_DIR/python.wasm" ]; then
    # Fallback: python executable without .wasm extension
    if [ -f "$BUILD_DIR/python" ] && file "$BUILD_DIR/python" | grep -q "WebAssembly"; then
        mv "$BUILD_DIR/python" "$BUILD_DIR/python.wasm"
    else
        warn "Re-link may have failed — checking if __wizer_initialize is exported..."
    fi
fi

# Verify __wizer_initialize is exported
if command -v wasm-objdump >/dev/null 2>&1; then
    if wasm-objdump -x "$BUILD_DIR/python.wasm" 2>/dev/null | grep -q "__wizer_initialize"; then
        info "  __wizer_initialize export found"
    else
        warn "  __wizer_initialize not found in exports — Wizer snapshot may fail"
    fi
fi

# Step 3: Asyncify the binary (if not already done)
ASYNC_IMPORTS="pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,pymode.thread_spawn,pymode.thread_join"

info "Running wasm-opt --asyncify..."
BEFORE_SIZE=$(stat -f%z "$BUILD_DIR/python.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python.wasm")
wasm-opt -O2 --asyncify \
    --pass-arg="asyncify-imports@${ASYNC_IMPORTS}" \
    --pass-arg=asyncify-ignore-indirect \
    "$BUILD_DIR/python.wasm" -o "$BUILD_DIR/python-asyncified.wasm"
mv "$BUILD_DIR/python-asyncified.wasm" "$BUILD_DIR/python.wasm"
AFTER_SIZE=$(stat -f%z "$BUILD_DIR/python.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python.wasm")
info "  asyncify: ${BEFORE_SIZE} -> ${AFTER_SIZE} bytes"

# Step 4: Build the stdlib filesystem for Wizer to access
info "Preparing stdlib for Wizer..."
STDLIB_DIR="$BUILD_DIR/stdlib-for-wizer"
mkdir -p "$STDLIB_DIR"

# Copy the stdlib that Wizer needs to access during __wizer_initialize
if [ -d "$CPYTHON_DIR/Lib" ]; then
    # Copy Python stdlib
    rsync -a --include='*.py' --include='*/' --exclude='*' \
        "$CPYTHON_DIR/Lib/" "$STDLIB_DIR/" 2>/dev/null || \
    cp -r "$CPYTHON_DIR/Lib/"*.py "$STDLIB_DIR/" 2>/dev/null || true
fi

# Copy pymode shims
if [ -d "$ROOT_DIR/lib/pymode" ]; then
    mkdir -p "$STDLIB_DIR/pymode"
    cp "$ROOT_DIR/lib/pymode/"*.py "$STDLIB_DIR/pymode/"
fi

# Step 5: Run Wizer to create the snapshot
info "Running Wizer (executing __wizer_initialize at build time)..."
BEFORE_WIZER=$(stat -f%z "$BUILD_DIR/python.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python.wasm")

wizer "$BUILD_DIR/python.wasm" \
    -o "$BUILD_DIR/python-snapshot.wasm" \
    --allow-wasi \
    --wasm-bulk-memory true \
    --init-func __wizer_initialize \
    --mapdir "/stdlib::$STDLIB_DIR" \
    2>&1 || {
        warn "Wizer failed. The snapshot could not be created."
        warn "python.wasm without snapshot is still usable (slower cold start)."
        exit 0
    }

AFTER_WIZER=$(stat -f%z "$BUILD_DIR/python-snapshot.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python-snapshot.wasm")
info "  Wizer snapshot: ${BEFORE_WIZER} -> ${AFTER_WIZER} bytes"

# Step 6: Copy snapshot to the worker directory for deployment
if [ -f "$BUILD_DIR/python-snapshot.wasm" ]; then
    cp "$BUILD_DIR/python-snapshot.wasm" "$ROOT_DIR/worker/src/python.wasm"
    info "  Copied snapshot to worker/src/python.wasm"
fi

# Report
echo ""
info "Wizer snapshot complete."
info "  Original:  $(du -h "$BUILD_DIR/python-no-wizer.wasm" | cut -f1)"
info "  Asyncified: $(du -h "$BUILD_DIR/python.wasm" | cut -f1)"
info "  Snapshot:  $(du -h "$BUILD_DIR/python-snapshot.wasm" | cut -f1)"
echo ""
info "Cold start improvement:"
info "  Without snapshot: ~28ms (Py_Initialize + import stdlib)"
info "  With snapshot:    ~5ms  (memory restore only)"
