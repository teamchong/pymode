#!/usr/bin/env bash
# Phase 1: Build CPython for wasm32-wasi using WASI SDK
# Prerequisites: python3, wasmtime, WASI SDK
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON_DIR="$ROOT_DIR/cpython"
WASI_SDK_VERSION="25"
# WASI SDK tarballs extract with platform suffix (e.g. wasi-sdk-25.0-arm64-macos)
WASI_SDK_DIR="$(ls -d "$ROOT_DIR"/wasi-sdk-${WASI_SDK_VERSION}.0* 2>/dev/null | head -1)"
if [ -z "$WASI_SDK_DIR" ]; then
    WASI_SDK_DIR="$ROOT_DIR/wasi-sdk-${WASI_SDK_VERSION}.0"
fi

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
command -v git >/dev/null || error "git not found"

# Step 1: Ensure CPython source exists
if [ ! -d "$CPYTHON_DIR" ]; then
    info "Cloning CPython 3.13.0..."
    git clone --depth 1 --branch v3.13.0 https://github.com/python/cpython.git "$CPYTHON_DIR"
else
    info "CPython source exists at $CPYTHON_DIR"
fi

# Step 2: Install WASI SDK if not present
if [ ! -d "$WASI_SDK_DIR" ]; then
    info "Downloading WASI SDK ${WASI_SDK_VERSION}..."
    PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"

    # Map architecture
    case "$ARCH" in
        x86_64) ARCH="x86_64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *) error "Unsupported architecture: $ARCH" ;;
    esac

    # Map platform
    case "$PLATFORM" in
        darwin) PLATFORM="macos" ;;
        linux) PLATFORM="linux" ;;
        *) error "Unsupported platform: $PLATFORM" ;;
    esac

    WASI_SDK_URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-${ARCH}-${PLATFORM}.tar.gz"
    info "URL: $WASI_SDK_URL"

    curl -L "$WASI_SDK_URL" -o /tmp/wasi-sdk.tar.gz
    tar xzf /tmp/wasi-sdk.tar.gz -C "$ROOT_DIR"
    rm /tmp/wasi-sdk.tar.gz
else
    info "WASI SDK found at $WASI_SDK_DIR"
fi

export WASI_SDK_PATH="$WASI_SDK_DIR"

# Step 3: Build CPython for WASI
info "Building CPython for wasm32-wasi..."
cd "$CPYTHON_DIR"

# Apply any patches
if [ -d "$ROOT_DIR/patches" ] && ls "$ROOT_DIR/patches"/*.patch 1>/dev/null 2>&1; then
    for patch in "$ROOT_DIR/patches"/*.patch; do
        patchname="$(basename "$patch")"
        if ! git -C "$CPYTHON_DIR" log --oneline | grep -q "$patchname"; then
            info "Applying patch: $patchname"
            git -C "$CPYTHON_DIR" apply "$patch" || warn "Patch $patchname may already be applied"
        fi
    done
fi

# Use zig cc as the native compiler if system cc isn't available.
# This bypasses the Xcode license requirement on macOS.
if ! cc -x c -o /dev/null - <<< 'int main(){return 0;}' 2>/dev/null; then
    if command -v zig >/dev/null 2>&1; then
        info "System cc unavailable, using zig cc as native compiler"
        export CC="zig cc"
        export CXX="zig c++"
        export AR="zig ar"
        export RANLIB="zig ranlib"
    else
        error "No C compiler available. Install Xcode CLI tools or Zig."
    fi
fi

# Use CPython's built-in WASI build script
python3 Tools/wasm/wasi.py build -- --config-cache

info "Build complete!"

# Step 4: Verify
info "Testing WASI build..."
# Check multiple possible WASI directory names
PYTHON_SH=""
for wasi_dir in wasm32-wasi wasm32-wasip1 wasm32-wasip2; do
    if [ -f "$CPYTHON_DIR/cross-build/$wasi_dir/python.sh" ]; then
        PYTHON_SH="$CPYTHON_DIR/cross-build/$wasi_dir/python.sh"
        break
    fi
done
if [ -f "$PYTHON_SH" ]; then
    chmod +x "$PYTHON_SH"
    RESULT=$("$PYTHON_SH" -c "import sys; print(f'Python {sys.version} on {sys.platform}')" 2>&1) || true
    if echo "$RESULT" | grep -q "Python"; then
        info "SUCCESS: $RESULT"
    else
        warn "Build produced binary but test failed: $RESULT"
    fi
else
    error "python.sh not found at $PYTHON_SH"
fi

echo ""
info "Phase 1 complete. CPython WASI build is at:"
info "  $PYTHON_SH"
echo ""
info "Test with:"
info "  $PYTHON_SH -c \"print('hello from WASI Python')\""
