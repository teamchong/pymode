#!/usr/bin/env bash
# Build a Wizer-pre-initialized python.wasm.
#
# Replaces Programs/python.o with pymode_wizer.o so the binary exports
# wizer.initialize (CPython init + pre-imports) and a _start that
# skips init when the snapshot flag is set.
#
# Produces: build/zig-wasi/python-wizer.wasm + worker/src/python-wizer.wasm
#
# Prerequisites:
#   - build-phase2.sh completed (all .o files exist)
#   - wizer installed (cargo install wizer --all-features)
#   - wasm-opt installed (brew install binaryen)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"
ZIG_CC="$ROOT_DIR/build/zig-wrappers/zig-cc"
WIZER_DIR="$ROOT_DIR/lib/wizer"
IMPORTS_DIR="$ROOT_DIR/lib/pymode-imports"
OUTPUT="$BUILD_DIR/python-wizer.wasm"

# Check prerequisites
[ -f "$BUILD_DIR/python.wasm" ] || { echo "Error: python.wasm not found. Run build-phase2.sh first."; exit 1; }
[ -x "$ZIG_CC" ] || { echo "Error: zig-cc wrapper not found. Run build-phase2.sh first."; exit 1; }
command -v wizer &>/dev/null || { echo "Error: wizer not found. Install: cargo install wizer --all-features"; exit 1; }

echo "=== Building Wizer-pre-initialized python.wasm ==="
echo ""

# Step 1: Compile pymode_wizer.c (replaces Programs/python.o)
echo "  [1/6] Compiling pymode_wizer.c..."
bash "$ZIG_CC" -c -Os \
    -DPy_BUILD_CORE \
    -I"$IMPORTS_DIR" \
    -I"$CPYTHON/Include" \
    -I"$CPYTHON/Include/internal" \
    -I"$BUILD_DIR" \
    "$WIZER_DIR/pymode_wizer.c" \
    -o "$BUILD_DIR/Programs/pymode_wizer.o"

# Step 2: Compile clean config.o (without variant module entries like numpy)
echo "  [2/6] Compiling clean config.o..."
if [ -f "$BUILD_DIR/Modules/config.c.base" ]; then
    cp "$BUILD_DIR/Modules/config.c.base" "$BUILD_DIR/Modules/config_wizer.c"
    bash "$ZIG_CC" -c -Os -DPy_BUILD_CORE \
        -I"$CPYTHON/Include" -I"$CPYTHON/Include/internal" -I"$BUILD_DIR" \
        -o "$BUILD_DIR/Modules/config_wizer.o" "$BUILD_DIR/Modules/config_wizer.c"
    rm -f "$BUILD_DIR/Modules/config_wizer.c"
else
    cp "$BUILD_DIR/Modules/config.o" "$BUILD_DIR/Modules/config_wizer.o"
fi

# Step 3: Collect all .o files, swapping python.o for pymode_wizer.o
echo "  [3/6] Collecting link objects..."
LINK_OBJS=()
while IFS= read -r obj; do
    base=$(basename "$obj")
    [[ "$base" == "python.o" ]] && continue
    [[ "$base" == "config.o" ]] && continue
    [[ "$base" == "config_variant.o" ]] && continue
    [[ "$base" == "config_wizer.o" ]] && continue
    [[ "$base" == "dynload_shlib.o" ]] && continue
    LINK_OBJS+=("$obj")
done < <(find "$BUILD_DIR" -name "*.o" -not -path "*/recipes/*" -not -path "*/Modules/numpy/*" -not -name "pymode_wizer.o")

LINK_OBJS+=("$BUILD_DIR/Programs/pymode_wizer.o")
LINK_OBJS+=("$BUILD_DIR/Modules/config_wizer.o")

echo "    ${#LINK_OBJS[@]} objects"

# Step 4: Link
echo "  [4/6] Linking..."
WIZER_RAW="$BUILD_DIR/python-wizer-raw.wasm"
bash "$ZIG_CC" -s \
    -o "$WIZER_RAW" \
    "${LINK_OBJS[@]}" \
    -ldl -lwasi-emulated-signal -lwasi-emulated-getpid -lwasi-emulated-process-clocks -lm

RAW_SIZE=$(wc -c < "$WIZER_RAW" | tr -d ' ')
echo "    Raw: $(echo "scale=1; $RAW_SIZE / 1048576" | bc)MB"

# Verify wizer.initialize is exported
if command -v wasm-objdump &>/dev/null; then
    EXPORTS=$(wasm-objdump -x "$WIZER_RAW" 2>/dev/null | grep "wizer" || true)
    if echo "$EXPORTS" | grep -q "wizer"; then
        echo "    wizer.initialize export: OK"
    else
        echo "    ERROR: wizer.initialize not found in exports!"
        exit 1
    fi
fi

# Step 5: Asyncify with wasm-opt
if command -v wasm-opt &>/dev/null; then
    echo "  [5/6] Asyncify + optimize..."
    ASYNC_IMPORTS="pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,pymode.thread_spawn,pymode.thread_join,pymode.dl_open"
    wasm-opt -O2 --asyncify \
        --enable-simd \
        --enable-nontrapping-float-to-int \
        --enable-bulk-memory \
        --enable-sign-ext \
        --enable-mutable-globals \
        --pass-arg="asyncify-imports@${ASYNC_IMPORTS}" \
        --pass-arg=asyncify-ignore-indirect \
        "$WIZER_RAW" -o "${WIZER_RAW}.opt"
    mv "${WIZER_RAW}.opt" "$WIZER_RAW"
    OPT_SIZE=$(wc -c < "$WIZER_RAW" | tr -d ' ')
    echo "    Asyncified: $(echo "scale=1; $OPT_SIZE / 1048576" | bc)MB"
else
    echo "  [5/6] SKIP: wasm-opt not found"
fi

# Step 6: Run Wizer to snapshot CPython init
echo "  [6/6] Wizer snapshot (booting CPython + pre-importing stdlib)..."

# Map the full CPython Lib so Py_InitializeFromConfig can find stdlib
STDLIB_DIR="$CPYTHON/Lib"

# Create a temp dir for wizer's /tmp preopen so wasi-libc registers it
WIZER_TMP=$(mktemp -d)
trap "rm -rf $WIZER_TMP" EXIT

if wizer "$WIZER_RAW" \
    -o "$OUTPUT" \
    --allow-wasi \
    --wasm-bulk-memory true \
    --wasm-simd true \
    --mapdir /stdlib::"$STDLIB_DIR" \
    --mapdir /tmp::"$WIZER_TMP" \
    --mapdir /data::"$WIZER_TMP" 2>&1; then

    FINAL_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
    echo "    Snapshot: $(echo "scale=1; $FINAL_SIZE / 1048576" | bc)MB"
else
    echo ""
    echo "    Wizer snapshot failed."
    echo "    The binary still works without wizer (falls back to full init)."
    rm -f "$WIZER_RAW"
    exit 1
fi

# Cleanup intermediate
rm -f "$WIZER_RAW"

# Copy to worker/src
cp "$OUTPUT" "$ROOT_DIR/worker/src/python-wizer.wasm"

echo ""
echo "Done! python-wizer.wasm"
echo "  Size: $(wc -c < "$OUTPUT" | tr -d ' ' | awk '{printf "%.1fMB", $1/1048576}')"
echo "  Location: worker/src/python-wizer.wasm"
echo ""
echo "Cold start: ~5ms (vs ~28ms without snapshot)"
