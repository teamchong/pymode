#!/usr/bin/env bash
# Phase 2: Build CPython for wasm32-wasi using zig cc (no WASI SDK)
# Prerequisites: python3, wasmtime, zig
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON_DIR="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# Check prerequisites
command -v python3 >/dev/null || error "python3 not found"
command -v wasmtime >/dev/null || error "wasmtime not found"
command -v zig >/dev/null || error "zig not found"

ZIG_VERSION=$(zig version)
info "Using zig $ZIG_VERSION"

# Ensure CPython source exists
if [ ! -d "$CPYTHON_DIR" ]; then
    error "CPython source not found. Run build-phase1.sh first to clone it."
fi

# Step 1: Build a native CPython for cross-compilation
# (CPython needs a host python to generate grammar/frozen modules)
NATIVE_BUILD_DIR="$ROOT_DIR/build/native"
if [ ! -f "$NATIVE_BUILD_DIR/python" ]; then
    info "Building native CPython (needed for cross-compilation)..."
    mkdir -p "$NATIVE_BUILD_DIR"
    cd "$CPYTHON_DIR"
    ./configure --prefix="$NATIVE_BUILD_DIR/install"
    make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" python
    cp python "$NATIVE_BUILD_DIR/python"
    make distclean || true
else
    info "Native CPython already built"
fi

# Step 2: Create zig cc wrapper scripts
# These wrappers handle zig cc quirks for autoconf compatibility
ZIG_WRAPPER_DIR="$ROOT_DIR/build/zig-wrappers"
mkdir -p "$ZIG_WRAPPER_DIR"

cat > "$ZIG_WRAPPER_DIR/zig-cc" << 'ZIGCC'
#!/usr/bin/env bash
# zig cc wrapper for wasm32-wasi cross-compilation
# Filters out flags that zig cc doesn't support

ARGS=()
for arg in "$@"; do
    case "$arg" in
        # Skip flags zig cc doesn't understand
        -pthread) continue ;;
        -lpthread) continue ;;
        -ldl) continue ;;
        -lm) continue ;;
        -lutil) continue ;;
        -lrt) continue ;;
        -Wl,--version-script=*) continue ;;
        -Wl,-export-dynamic) continue ;;
        -Wl,--no-as-needed) continue ;;
        # Skip optimization flags that cause issues
        -flto=thin) ARGS+=("-flto") ;;
        *) ARGS+=("$arg") ;;
    esac
done

exec zig cc -target wasm32-wasi "${ARGS[@]}"
ZIGCC
chmod +x "$ZIG_WRAPPER_DIR/zig-cc"

cat > "$ZIG_WRAPPER_DIR/zig-ar" << 'ZIGAR'
#!/usr/bin/env bash
exec zig ar "$@"
ZIGAR
chmod +x "$ZIG_WRAPPER_DIR/zig-ar"

cat > "$ZIG_WRAPPER_DIR/zig-ranlib" << 'ZIGRANLIB'
#!/usr/bin/env bash
exec zig ranlib "$@"
ZIGRANLIB
chmod +x "$ZIG_WRAPPER_DIR/zig-ranlib"

# Step 3: Configure CPython with zig cc
info "Configuring CPython with zig cc for wasm32-wasi..."
mkdir -p "$BUILD_DIR"
cd "$CPYTHON_DIR"

# Clean previous builds
make distclean 2>/dev/null || true

CONFIG_SITE="$ROOT_DIR/scripts/config.site-wasi" \
./configure \
    --host=wasm32-wasi \
    --build="$(./config.guess)" \
    --with-build-python="$NATIVE_BUILD_DIR/python" \
    CC="$ZIG_WRAPPER_DIR/zig-cc" \
    AR="$ZIG_WRAPPER_DIR/zig-ar" \
    RANLIB="$ZIG_WRAPPER_DIR/zig-ranlib" \
    --disable-ipv6 \
    --disable-shared \
    --without-ensurepip \
    --without-pymalloc \
    --config-cache \
    ac_cv_file__dev_ptmx=no \
    ac_cv_file__dev_ptc=no

# Step 4: Build
info "Building CPython..."
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" 2>&1 | tee "$BUILD_DIR/build.log"

# Step 5: Copy output
info "Copying build artifacts..."
if [ -f python.wasm ] || [ -f python ]; then
    cp python.wasm "$BUILD_DIR/python.wasm" 2>/dev/null || cp python "$BUILD_DIR/python.wasm" 2>/dev/null || true
fi

# Step 6: Create runner script
cat > "$BUILD_DIR/python.sh" << RUNNER
#!/usr/bin/env bash
exec wasmtime run --dir=. --dir=/tmp "$BUILD_DIR/python.wasm" -- "\$@"
RUNNER
chmod +x "$BUILD_DIR/python.sh"

# Step 7: Test
info "Testing zig cc WASI build..."
RESULT=$("$BUILD_DIR/python.sh" -c "import sys; print(f'Python {sys.version} on {sys.platform}')" 2>&1) || true
if echo "$RESULT" | grep -q "Python"; then
    info "SUCCESS: $RESULT"
else
    warn "Build produced binary but test failed. Check $BUILD_DIR/build.log"
    echo "$RESULT"
fi

echo ""
info "Phase 2 complete. Zig-compiled CPython WASI build is at:"
info "  $BUILD_DIR/python.sh"

# Compare sizes
if [ -f "$BUILD_DIR/python.wasm" ]; then
    SIZE=$(du -h "$BUILD_DIR/python.wasm" | cut -f1)
    info "WASM size: $SIZE"
fi
