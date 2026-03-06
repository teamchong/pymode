#!/usr/bin/env bash
# Phase 2: Build CPython for wasm32-wasi using zig cc (no WASI SDK)
# Uses ReleaseSmall equivalent: -Os, strip debug info, minimize binary size
# Prerequisites: python3, wasmtime, zig, Phase 1 native build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON_DIR="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"
ZIG_WRAPPER_DIR="$ROOT_DIR/build/zig-wrappers"

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
[ -d "$CPYTHON_DIR" ] || error "CPython source not found. Run build-phase1.sh first to clone it."

# Step 1: Locate or build the native Python (needed for cross-compilation)
NATIVE_PYTHON=""
for candidate in \
    "$CPYTHON_DIR/cross-build/build/python.exe" \
    "$CPYTHON_DIR/cross-build/build/python" \
    "$ROOT_DIR/build/native/python"; do
    if [ -x "$candidate" ]; then
        NATIVE_PYTHON="$candidate"
        break
    fi
done

if [ -z "$NATIVE_PYTHON" ]; then
    info "No native Python found. Building one..."
    mkdir -p "$ROOT_DIR/build/native"
    cd "$CPYTHON_DIR"
    make distclean 2>/dev/null || true
    ./configure --prefix="$ROOT_DIR/build/native/install"
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 2)"
    # Copy native python out of source tree before cleaning
    if [ -x "$CPYTHON_DIR/python.exe" ]; then
        cp "$CPYTHON_DIR/python.exe" "$ROOT_DIR/build/native/python"
    elif [ -x "$CPYTHON_DIR/python" ]; then
        cp "$CPYTHON_DIR/python" "$ROOT_DIR/build/native/python"
    fi
    NATIVE_PYTHON="$ROOT_DIR/build/native/python"
fi

info "Using native Python: $NATIVE_PYTHON"

# Clean CPython source tree after native build (required for out-of-tree WASI build)
cd "$CPYTHON_DIR"
make distclean 2>/dev/null || true
git clean -fdx 2>/dev/null || true
cd "$ROOT_DIR"

# Step 2: Create zig cc wrapper scripts
# These filter out flags zig cc doesn't support and apply ReleaseSmall optimizations
mkdir -p "$ZIG_WRAPPER_DIR"

cat > "$ZIG_WRAPPER_DIR/zig-cc" << 'ZIGCC'
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

# zig cc as CPP (preprocessor only)
cat > "$ZIG_WRAPPER_DIR/zig-cpp" << 'ZIGCPP'
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
ZIGCPP
chmod +x "$ZIG_WRAPPER_DIR/zig-cpp"

# Step 3: Out-of-tree build with zig cc
info "Configuring CPython with zig cc for wasm32-wasi (ReleaseSmall)..."
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Clean previous zig-wasi build (including config cache)
rm -rf "$BUILD_DIR"/*
rm -f "$BUILD_DIR"/../config.cache 2>/dev/null

# Detect build triple for cross-compilation
case "$(uname -s)" in
    Darwin) BUILD_TRIPLE="$(uname -m)-apple-darwin" ;;
    Linux)  BUILD_TRIPLE="$(uname -m)-pc-linux-gnu" ;;
    *)      BUILD_TRIPLE="$(uname -m)-unknown-$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac

CONFIG_SITE="$ROOT_DIR/scripts/config.site-wasi" \
PKG_CONFIG=false \
"$CPYTHON_DIR/configure" \
    --host=wasm32-wasi \
    --build="$BUILD_TRIPLE" \
    --with-build-python="$NATIVE_PYTHON" \
    CC="$ZIG_WRAPPER_DIR/zig-cc" \
    CPP="$ZIG_WRAPPER_DIR/zig-cpp" \
    AR="$ZIG_WRAPPER_DIR/zig-ar" \
    RANLIB="$ZIG_WRAPPER_DIR/zig-ranlib" \
    CFLAGS="-Os -DNDEBUG -fno-strict-aliasing" \
    LDFLAGS="-s" \
    --disable-ipv6 \
    --disable-shared \
    --without-ensurepip \
    --without-pymalloc \
    --disable-test-modules \
    --config-cache \
    ac_cv_file__dev_ptmx=no \
    ac_cv_file__dev_ptc=no \
    py_cv_module__bz2=n/a \
    py_cv_module__lzma=n/a \
    py_cv_module_zlib=n/a \
    py_cv_module__socket=n/a \
    py_cv_module__ctypes=n/a \
    py_cv_module_select=n/a \
    py_cv_module_faulthandler=n/a \
    py_cv_module_resource=n/a \
    py_cv_module_grp=n/a \
    py_cv_module_pwd=n/a \
    py_cv_module_fcntl=n/a \
    py_cv_module_mmap=n/a \
    py_cv_module_termios=n/a \
    py_cv_module_syslog=n/a \
    py_cv_module__multiprocessing=n/a \
    py_cv_module__posixsubprocess=n/a \
    py_cv_module__posixshmem=n/a \
    py_cv_module__curses=n/a \
    py_cv_module__curses_panel=n/a \
    py_cv_module__dbm=n/a \
    py_cv_module__gdbm=n/a \
    py_cv_module__tkinter=n/a \
    py_cv_module__scproxy=n/a

# Cross-platform sed -i (macOS requires '' arg, Linux does not)
sedi() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# Step 3b: Patch pyconfig.h - use CPython pthread types instead of musl
info "Patching pyconfig.h for WASI..."
sedi 's/^#define HAVE_PTHREAD_H 1/\/* #undef HAVE_PTHREAD_H *\//' "$BUILD_DIR/pyconfig.h"

# Step 3b2: Register _pymode as a built-in module in config.c
# This makes `import _pymode` work without needing shared library loading.
info "Registering _pymode built-in module..."
CONFIG_C="$BUILD_DIR/Modules/config.c"
if [ -f "$CONFIG_C" ] && ! grep -q "PyInit__pymode" "$CONFIG_C"; then
    # Add extern declaration before the ADDMODULE MARKER 1
    sedi '/\/\* -- ADDMODULE MARKER 1 --/i\
extern PyObject* PyInit__pymode(void);
' "$CONFIG_C"
    # Add entry to _PyImport_Inittab before the ADDMODULE MARKER 2
    sedi '/\/\* -- ADDMODULE MARKER 2 --/i\
    {"_pymode", PyInit__pymode},
' "$CONFIG_C"
    info "  _pymode registered in config.c"
fi

# Step 3c: Compile WASI shims (single-threaded pthread, etc.)
info "Compiling WASI shims..."
SHIMS_DIR="$ROOT_DIR/lib/wasi-shims"
SHIMS_OBJ_DIR="$BUILD_DIR/shims"
mkdir -p "$SHIMS_OBJ_DIR"

for shim_src in "$SHIMS_DIR"/*.c; do
    [ -f "$shim_src" ] || continue
    shim_name="$(basename "$shim_src" .c)"
    # dynload_pymode needs CPython headers
    if [ "$shim_name" = "dynload_pymode" ]; then
        info "  Compiling $shim_name.c (with CPython headers)"
        "$ZIG_WRAPPER_DIR/zig-cc" -c -Os \
            -DPy_BUILD_CORE \
            -I"$CPYTHON_DIR/Include" \
            -I"$CPYTHON_DIR/Include/internal" \
            -I"$BUILD_DIR" \
            "$shim_src" -o "$SHIMS_OBJ_DIR/$shim_name.o"
    else
        info "  Compiling $shim_name.c"
        "$ZIG_WRAPPER_DIR/zig-cc" -c -Os "$shim_src" -o "$SHIMS_OBJ_DIR/$shim_name.o"
    fi
done

# Create static library from shims
"$ZIG_WRAPPER_DIR/zig-ar" rcs "$SHIMS_OBJ_DIR/libwasi_shims.a" "$SHIMS_OBJ_DIR"/*.o
info "  Built libwasi_shims.a"

# Step 3d: Compile pymode host imports (WASM imports from the pymode.* namespace)
info "Compiling pymode host imports..."
PYMODE_IMPORTS_DIR="$ROOT_DIR/lib/pymode-imports"
PYMODE_OBJ_DIR="$BUILD_DIR/pymode-imports"
mkdir -p "$PYMODE_OBJ_DIR"

if [ -f "$PYMODE_IMPORTS_DIR/pymode_imports.c" ]; then
    "$ZIG_WRAPPER_DIR/zig-cc" -c -Os \
        -I"$PYMODE_IMPORTS_DIR" \
        -I"$CPYTHON_DIR/Include" \
        -I"$CPYTHON_DIR/Include/internal" \
        -I"$BUILD_DIR" \
        "$PYMODE_IMPORTS_DIR/pymode_imports.c" \
        -o "$PYMODE_OBJ_DIR/pymode_imports.o"
    "$ZIG_WRAPPER_DIR/zig-ar" rcs "$PYMODE_OBJ_DIR/libpymode_imports.a" "$PYMODE_OBJ_DIR/pymode_imports.o"
    info "  Built libpymode_imports.a"
fi

# Step 4: Build
info "Building CPython with zig cc (ReleaseSmall)..."
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
# Add shims and pymode imports libraries to LDFLAGS for linking
# --allow-undefined lets the linker accept unresolved pymode.* WASM imports
LDFLAGS="-s -L$SHIMS_OBJ_DIR -lwasi_shims -L$PYMODE_OBJ_DIR -lpymode_imports -Wl,--allow-undefined" make -j"$NCPU" 2>&1 | tee "$BUILD_DIR/build.log"

# Step 5: Verify python.wasm exists
if [ ! -f "$BUILD_DIR/python.wasm" ]; then
    # Some builds produce just 'python' without .wasm extension
    if [ -f "$BUILD_DIR/python" ] && file "$BUILD_DIR/python" | grep -q "WebAssembly"; then
        mv "$BUILD_DIR/python" "$BUILD_DIR/python.wasm"
    else
        error "python.wasm not found after build. Check $BUILD_DIR/build.log"
    fi
fi

# Step 6: Asyncify + optimize with wasm-opt
# Asyncify instruments the binary so async host imports (tcp_recv, http_fetch,
# kv_get, etc.) can suspend/resume the WASM stack. This eliminates the
# trampoline — single _start() invocation, async ops pause in-place.
if command -v wasm-opt >/dev/null 2>&1; then
    ORIG_SIZE=$(stat -f%z "$BUILD_DIR/python.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python.wasm")

    # List of async pymode imports that can suspend the WASM stack
    ASYNC_IMPORTS="pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,pymode.thread_spawn,pymode.thread_join,pymode.dl_open"

    info "Running wasm-opt --asyncify (async imports: tcp_recv, http_fetch, kv_*, r2_*, d1_exec)..."
    wasm-opt -O2 --asyncify \
        --pass-arg="asyncify-imports@${ASYNC_IMPORTS}" \
        --pass-arg=asyncify-ignore-indirect \
        "$BUILD_DIR/python.wasm" -o "$BUILD_DIR/python.wasm.asyncified"
    mv "$BUILD_DIR/python.wasm.asyncified" "$BUILD_DIR/python.wasm"

    NEW_SIZE=$(stat -f%z "$BUILD_DIR/python.wasm" 2>/dev/null || stat -c%s "$BUILD_DIR/python.wasm")
    info "asyncify + optimize: ${ORIG_SIZE} -> ${NEW_SIZE} bytes"
else
    warn "wasm-opt not found. Skipping asyncify — trampoline fallback will be used at runtime."
    warn "Install binaryen: brew install binaryen (or apt install binaryen)"
fi

# Step 7: Create runner script
cat > "$BUILD_DIR/python.sh" << RUNNER
#!/usr/bin/env bash
# Run zig-compiled CPython WASM via wasmtime
exec wasmtime run \\
    --wasm max-wasm-stack=8388608 \\
    --wasi preview2 \\
    --dir "$CPYTHON_DIR"::/ \\
    --env PYTHONPATH=/cross-build/wasm32-wasi/build/lib.wasi-wasm32-3.13 \\
    "$BUILD_DIR/python.wasm" -- "\$@"
RUNNER
chmod +x "$BUILD_DIR/python.sh"

# Step 8: Test
info "Testing zig cc WASI build..."
RESULT=$("$BUILD_DIR/python.sh" -c "import sys; print(f'Python {sys.version} on {sys.platform}')" 2>&1) || true
if echo "$RESULT" | grep -q "Python"; then
    info "SUCCESS: $RESULT"
else
    warn "Build produced binary but test failed. Check $BUILD_DIR/build.log"
    echo "$RESULT"
fi

# Report sizes
echo ""
WASM_SIZE=$(du -h "$BUILD_DIR/python.wasm" | cut -f1)
WASI_SDK_WASM=""
for candidate in \
    "$CPYTHON_DIR/cross-build/wasm32-wasi/python.wasm" \
    "$CPYTHON_DIR/cross-build/wasm32-wasip1/python.wasm"; do
    if [ -f "$candidate" ]; then
        WASI_SDK_WASM=$(du -h "$candidate" | cut -f1)
        break
    fi
done

info "Phase 2 complete."
info "  zig cc WASM size:   $WASM_SIZE"
if [ -n "$WASI_SDK_WASM" ]; then
    info "  WASI SDK WASM size: $WASI_SDK_WASM"
fi
info "  Binary: $BUILD_DIR/python.sh"
echo ""
info "Test with:"
info "  $BUILD_DIR/python.sh -c \"print('hello from zig-compiled WASI Python')\""
