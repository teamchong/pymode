#!/usr/bin/env bash
# Build a C extension package as a .wasm side module for PyMode.
#
# Side modules are loaded at runtime by PythonDO via the dl_open/dl_sym
# host imports. They share linear memory with the main python.wasm and
# export PyInit_<name> functions that CPython calls through the standard
# _PyImport_FindSharedFuncptr() flow in dynload_pymode.c.
#
# Usage:
#   ./scripts/build-extension.sh markupsafe
#   ./scripts/build-extension.sh simplejson==3.19.3
#   ./scripts/build-extension.sh --list    # show supported packages
#   ./scripts/build-extension.sh --all     # build all supported
#
# Output:
#   .pymode/extensions/{name}/{module}.wasm  — side module
#   .pymode/extensions/{name}/*.py           — pure Python files from package

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$ROOT_DIR/.pymode/extensions"
CPYTHON_DIR="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# Check prerequisites
command -v zig >/dev/null || error "zig not found. Install: https://ziglang.org/download/"
[ -d "$CPYTHON_DIR/Include" ] || error "CPython not found. Run build-phase1.sh first."
[ -f "$BUILD_DIR/pyconfig.h" ] || error "pyconfig.h not found. Run build-phase2.sh first."

CFLAGS_COMMON=(
    -target wasm32-wasi
    -Os -DNDEBUG
    -I"$CPYTHON_DIR/Include"
    -I"$CPYTHON_DIR/Include/internal"
    -I"$BUILD_DIR"
    -Wno-error=int-conversion
    -Wno-error=incompatible-pointer-types
)

# Compile C files into a .wasm side module
# Args: output_wasm src_dir [extra_c_files...]
compile_side_module() {
    local output_wasm="$1"
    shift
    local src_files=("$@")

    local obj_dir
    obj_dir=$(mktemp -d)
    trap 'rm -rf "$obj_dir"' RETURN

    local objects=()
    for src in "${src_files[@]}"; do
        local obj_name
        obj_name="$(basename "$src" .c).o"
        info "  Compiling $(basename "$src")"
        zig cc "${CFLAGS_COMMON[@]}" \
            -c "$src" -o "$obj_dir/$obj_name" || {
                warn "  Failed to compile $(basename "$src")"
                return 1
            }
        objects+=("$obj_dir/$obj_name")
    done

    if [ ${#objects[@]} -eq 0 ]; then
        error "No object files produced"
    fi

    info "  Linking -> $(basename "$output_wasm")"
    # Link as a WASM side module:
    # --import-memory: share memory with python.wasm (host provides it)
    # --allow-undefined: CPython API symbols resolved by main module
    # --no-entry: library, not executable
    # --export-dynamic: export all non-static symbols (including PyInit_*)
    zig cc -target wasm32-wasi \
        -nostdlib \
        -Os -s \
        -Wl,--import-memory \
        -Wl,--allow-undefined \
        -Wl,--no-entry \
        -Wl,--export-dynamic \
        "${objects[@]}" \
        -o "$output_wasm"
}

# Download and extract a package source
download_source() {
    local name="$1" dest="$2"
    mkdir -p "$dest/dl"

    # Try sdist first (has C source), fall back to wheel
    pip3 download --no-binary :all: "$name" -d "$dest/dl" 2>/dev/null || \
        pip3 download "$name" -d "$dest/dl" 2>/dev/null || \
        error "Failed to download $name"

    local sdist
    sdist=$(ls "$dest/dl/"*.tar.gz 2>/dev/null | head -1)
    local wheel
    wheel=$(ls "$dest/dl/"*.whl 2>/dev/null | head -1)

    if [ -n "$sdist" ]; then
        tar xzf "$sdist" -C "$dest" --strip-components=1
    elif [ -n "$wheel" ]; then
        python3 -m zipfile -e "$wheel" "$dest/src"
    else
        error "No sdist or wheel found for $name"
    fi
}

# Build a single extension
build_ext() {
    local name="$1"
    local pkg_dir="$EXT_DIR/$name"
    mkdir -p "$pkg_dir"

    case "$name" in
        markupsafe)
            info "Building markupsafe (_speedups.wasm)..."
            download_source markupsafe "$pkg_dir"

            local src_dir="$pkg_dir/src/markupsafe"
            [ -d "$src_dir" ] || src_dir="$pkg_dir/markupsafe"
            [ -f "$src_dir/_speedups.c" ] || error "markupsafe/_speedups.c not found"

            compile_side_module "$pkg_dir/_speedups.wasm" "$src_dir/_speedups.c"

            # Copy pure Python files alongside the .wasm
            for pyfile in "$src_dir"/*.py; do
                [ -f "$pyfile" ] && cp "$pyfile" "$pkg_dir/"
            done
            ;;

        simplejson)
            info "Building simplejson (_speedups.wasm)..."
            download_source simplejson "$pkg_dir"

            local src_dir="$pkg_dir/simplejson"
            [ -f "$src_dir/_speedups.c" ] || error "simplejson/_speedups.c not found"

            compile_side_module "$pkg_dir/_speedups.wasm" "$src_dir/_speedups.c"

            for pyfile in "$src_dir"/*.py; do
                [ -f "$pyfile" ] && cp "$pyfile" "$pkg_dir/"
            done
            ;;

        msgpack)
            info "Building msgpack (_cmsgpack.wasm)..."
            download_source msgpack "$pkg_dir"

            local src_dir="$pkg_dir/msgpack"
            [ -f "$src_dir/_cmsgpack.c" ] || error "msgpack/_cmsgpack.c not found"

            compile_side_module "$pkg_dir/_cmsgpack.wasm" "$src_dir/_cmsgpack.c"

            for pyfile in "$src_dir"/*.py; do
                [ -f "$pyfile" ] && cp "$pyfile" "$pkg_dir/"
            done
            ;;

        pyyaml|PyYAML)
            info "Building pyyaml (_yaml.wasm)..."
            download_source pyyaml "$pkg_dir"

            local src_dir="$pkg_dir/yaml"
            [ -f "$src_dir/_yaml.c" ] || src_dir="$pkg_dir"
            [ -f "$src_dir/_yaml.c" ] || error "yaml/_yaml.c not found"

            compile_side_module "$pkg_dir/_yaml.wasm" "$src_dir/_yaml.c"

            for pyfile in "$src_dir"/*.py; do
                [ -f "$pyfile" ] && cp "$pyfile" "$pkg_dir/"
            done
            ;;

        *)
            error "Unknown extension: $name. Run with --list to see supported packages."
            ;;
    esac

    # Report
    if ls "$pkg_dir"/*.wasm >/dev/null 2>&1; then
        for wasm_file in "$pkg_dir"/*.wasm; do
            local size
            size=$(du -h "$wasm_file" | cut -f1)
            info "Built: $wasm_file ($size)"
        done
    fi
}

# List supported extensions
list_extensions() {
    echo "Supported C extension packages:"
    echo "  markupsafe   - HTML escaping (1 C file, ~15KB .wasm)"
    echo "  simplejson   - Fast JSON encoder/decoder (1 C file)"
    echo "  msgpack      - MessagePack serialization (1 C file)"
    echo "  pyyaml       - YAML parser (requires libyaml headers)"
    echo ""
    echo "Usage:"
    echo "  ./scripts/build-extension.sh markupsafe"
    echo "  ./scripts/build-extension.sh --all"
    echo ""
    echo "Output goes to .pymode/extensions/<name>/<module>.wasm"
    echo "These .wasm files are loaded at runtime by PythonDO via dl_open/dl_sym."
}

# Build all supported extensions
build_all() {
    local failed=0
    for ext in markupsafe simplejson msgpack; do
        build_ext "$ext" || {
            warn "Failed to build $ext"
            failed=$((failed + 1))
        }
    done

    if [ $failed -eq 0 ]; then
        info "All extensions built successfully"
    else
        warn "$failed extension(s) failed to build"
    fi
}

# Main
case "${1:-}" in
    --list|-l)
        list_extensions
        exit 0
        ;;
    --all|-a)
        build_all
        exit 0
        ;;
    "")
        error "Usage: $0 <package-name> | --list | --all"
        ;;
    *)
        build_ext "$1"
        ;;
esac
