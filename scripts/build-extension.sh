#!/usr/bin/env bash
# Build a C extension package as wasm32-wasi and register it in the inittab.
#
# Downloads the package source (wheel or sdist), compiles C files with zig cc,
# creates a static archive, and generates a modules.map entry for auto-discovery.
#
# Usage:
#   ./scripts/build-extension.sh markupsafe
#   ./scripts/build-extension.sh simplejson==3.19.3
#   ./scripts/build-extension.sh --list    # show supported packages
#
# Output:
#   build/extensions/{name}/lib{name}.a     — static archive
#   build/extensions/{name}/modules.map     — PyInit symbol → dotted module name
#   build/extensions/{name}/*.py            — pure Python files from package

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$ROOT_DIR/build/extensions"
SYSROOT="$ROOT_DIR/build/sysroot/wasm32-wasi"
CPYTHON_DIR="$ROOT_DIR/cpython"
PYTHON_INCLUDE="$CPYTHON_DIR/Include"
PYTHON_INTERNAL="$CPYTHON_DIR/Include/internal"
PYCONFIG_H="$ROOT_DIR/build/zig-wasi/pyconfig.h"

ZIG_CC="zig cc -target wasm32-wasi -Os -fPIC -DNDEBUG"
ZIG_AR="zig ar"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# Verify prerequisites
[ -d "$CPYTHON_DIR/Include" ] || error "CPython not found. Run build-phase1.sh first."
[ -f "$PYCONFIG_H" ] || error "pyconfig.h not found. Run build-phase2.sh first."

mkdir -p "$EXT_DIR"

CFLAGS_COMMON="-I$PYTHON_INCLUDE -I$PYTHON_INCLUDE/.. -I$SYSROOT/include -include $PYCONFIG_H"

# Scan a .a file for PyInit_ symbols → modules.map
generate_modules_map() {
    local archive="$1" output="$2" pkg_name="$3"
    info "Scanning $archive for PyInit_ symbols..."
    echo "# Auto-generated modules.map for $pkg_name" > "$output"
    echo "# Format: PyInit_symbol dotted.module.name" >> "$output"

    nm "$archive" 2>/dev/null | grep "T _\?PyInit_" | while read -r line; do
        # Extract symbol name (handle both _PyInit_ and PyInit_ prefixes)
        local sym
        sym=$(echo "$line" | grep -o 'PyInit_[a-zA-Z0-9_]*')
        if [ -n "$sym" ]; then
            # Convert PyInit_foo_bar to foo.bar (heuristic)
            local mod_name="${sym#PyInit_}"
            # For top-level modules, the dotted name equals the symbol suffix
            # For sub-modules, we'd need package-specific knowledge
            echo "$sym $pkg_name.$mod_name" >> "$output"
        fi
    done

    info "  Generated $(grep -c -v '^#' "$output") entries in modules.map"
}

# Build a single extension
build_ext() {
    local name="$1"
    local pkg_dir="$EXT_DIR/$name"
    mkdir -p "$pkg_dir"

    case "$name" in
        markupsafe)
            info "Building markupsafe..."
            pip3 download --no-binary :all: markupsafe -d "$pkg_dir/dl" 2>/dev/null || \
                pip3 download markupsafe -d "$pkg_dir/dl" 2>/dev/null
            local sdist=$(ls "$pkg_dir/dl/"*.tar.gz 2>/dev/null | head -1)
            local wheel=$(ls "$pkg_dir/dl/"*.whl 2>/dev/null | head -1)

            if [ -n "$sdist" ]; then
                tar xzf "$sdist" -C "$pkg_dir" --strip-components=1
            elif [ -n "$wheel" ]; then
                python3 -m zipfile -e "$wheel" "$pkg_dir/src"
            fi

            # markupsafe has one C file: _speedups.c
            local src_dir="$pkg_dir/src/markupsafe"
            [ -d "$src_dir" ] || src_dir="$pkg_dir/markupsafe"
            $ZIG_CC $CFLAGS_COMMON -c "$src_dir/_speedups.c" -o "$pkg_dir/_speedups.o"
            $ZIG_AR rcs "$pkg_dir/libmarkupsafe.a" "$pkg_dir/_speedups.o"
            echo "PyInit__speedups markupsafe._speedups" > "$pkg_dir/modules.map"
            info "markupsafe: done"
            ;;

        simplejson)
            info "Building simplejson..."
            pip3 download --no-binary :all: simplejson -d "$pkg_dir/dl" 2>/dev/null
            tar xzf "$pkg_dir/dl/"*.tar.gz -C "$pkg_dir" --strip-components=1
            $ZIG_CC $CFLAGS_COMMON -c "$pkg_dir/simplejson/_speedups.c" -o "$pkg_dir/_speedups.o"
            $ZIG_AR rcs "$pkg_dir/libsimplejson.a" "$pkg_dir/_speedups.o"
            echo "PyInit__speedups simplejson._speedups" > "$pkg_dir/modules.map"
            info "simplejson: done"
            ;;

        msgpack)
            info "Building msgpack..."
            pip3 download --no-binary :all: msgpack -d "$pkg_dir/dl" 2>/dev/null
            tar xzf "$pkg_dir/dl/"*.tar.gz -C "$pkg_dir" --strip-components=1
            $ZIG_CC $CFLAGS_COMMON -c "$pkg_dir/msgpack/_cmsgpack.c" -o "$pkg_dir/_cmsgpack.o"
            $ZIG_AR rcs "$pkg_dir/libmsgpack.a" "$pkg_dir/_cmsgpack.o"
            echo "PyInit__cmsgpack msgpack._cmsgpack" > "$pkg_dir/modules.map"
            info "msgpack: done"
            ;;

        *)
            error "Unknown extension: $name. Run with --list to see supported packages."
            ;;
    esac
}

# List supported extensions
list_extensions() {
    echo "Supported C extensions:"
    echo "  markupsafe   - HTML escaping (1 C file)"
    echo "  simplejson   - Fast JSON (1 C file)"
    echo "  msgpack      - MessagePack (1 C file)"
    echo ""
    echo "More coming: ujson, pyyaml, regex, bitarray, crcmod, mmh3"
}

# Generate a combined inittab C file from all built extensions
generate_inittab() {
    local output="$EXT_DIR/pymode_inittab.c"
    info "Generating combined inittab..."

    cat > "$output" << 'HEADER'
/* Auto-generated by build-extension.sh
 * Registers all compiled C extensions in CPython's inittab.
 * Include this file and call pymode_extend_inittab() before Py_Initialize().
 */
#include "Python.h"

HEADER

    # Collect all modules.map files
    local count=0
    for mapfile in "$EXT_DIR"/*/modules.map; do
        [ -f "$mapfile" ] || continue
        while IFS=' ' read -r sym modname; do
            [[ "$sym" == \#* ]] && continue
            [ -z "$sym" ] && continue
            echo "extern PyObject* $sym(void);" >> "$output"
            count=$((count + 1))
        done < "$mapfile"
    done

    cat >> "$output" << 'MID'

int pymode_extend_inittab(void) {
    static struct _inittab extensions[] = {
MID

    for mapfile in "$EXT_DIR"/*/modules.map; do
        [ -f "$mapfile" ] || continue
        while IFS=' ' read -r sym modname; do
            [[ "$sym" == \#* ]] && continue
            [ -z "$sym" ] && continue
            echo "        {\"$modname\", $sym}," >> "$output"
        done < "$mapfile"
    done

    cat >> "$output" << 'FOOTER'
        {NULL, NULL}
    };
    return PyImport_ExtendInittab(extensions);
}
FOOTER

    info "Generated $output with $count extensions"
}

# Main
case "${1:-}" in
    --list|-l)
        list_extensions
        exit 0
        ;;
    --inittab)
        generate_inittab
        exit 0
        ;;
    "")
        error "Usage: $0 <package-name> | --list | --inittab"
        ;;
    *)
        build_ext "$1"
        ;;
esac
