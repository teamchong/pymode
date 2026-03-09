#!/bin/bash
# Build Pillow's C extensions as .wasm side modules for PyMode.
#
# Downloads Pillow source, compiles the imaging library (libjpeg, libpng, zlib
# vendored) to wasm32-wasi via zig cc, and bundles Python layer.
#
# Prerequisites:
#   - zig >= 0.15 (provides zig cc targeting wasm32-wasi)
#   - wasm-ld (from LLVM, e.g. brew install llvm)
#   - python3
#   - cpython/ directory with cross-build/wasm32-wasi/ headers and libpython3.13.a
#
# Output:
#   worker/src/extensions/pillow/ — .wasm side modules + pillow-site-packages.zip

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="/tmp/pillow-wasm-build"
OUTPUT_DIR="$ROOT_DIR/worker/src/extensions/pillow"

# Check prerequisites
if ! command -v zig &>/dev/null; then
    echo "Error: zig not found. Install zig >= 0.15"
    exit 1
fi

PYCONFIG_DIR="$CPYTHON/cross-build/wasm32-wasi"
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    PYCONFIG_DIR="$ROOT_DIR/build/zig-wasi"
fi
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    echo "Error: pyconfig.h not found. Run build-phase2.sh first."
    exit 1
fi

# Download Pillow source
PILLOW_VERSION="11.1.0"
PILLOW_SRC="$BUILD_DIR/pillow-${PILLOW_VERSION}"

if [ ! -d "$PILLOW_SRC" ]; then
    echo "Downloading Pillow ${PILLOW_VERSION}..."
    mkdir -p "$BUILD_DIR"
    pip3 download "Pillow==${PILLOW_VERSION}" --no-binary=:all: --no-deps -d "$BUILD_DIR" 2>/dev/null
    cd "$BUILD_DIR"
    tar xzf "pillow-${PILLOW_VERSION}.tar.gz" || tar xzf "Pillow-${PILLOW_VERSION}.tar.gz"
    # Source dir may be Pillow-VERSION or pillow-VERSION
    [ -d "Pillow-${PILLOW_VERSION}" ] && mv "Pillow-${PILLOW_VERSION}" "$PILLOW_SRC"
fi

echo "Building Pillow ${PILLOW_VERSION} → wasm32-wasi..."

SUCCESS=0
FAIL=0
mkdir -p "$BUILD_DIR/obj"

# ── Step 1: Build vendored zlib ──
echo "  Building vendored zlib..."
ZLIB_VERSION="1.3.1"
ZLIB_SRC="$BUILD_DIR/zlib-${ZLIB_VERSION}"
if [ ! -d "$ZLIB_SRC" ]; then
    cd "$BUILD_DIR"
    curl -sL "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz" | tar xz
fi

ZLIB_CFLAGS="-target wasm32-wasi -c -Os -fPIC -D__wasm_exception_handling__ -DHAVE_UNISTD_H"
for src in adler32 compress crc32 deflate gzclose gzlib gzread gzwrite \
           infback inffast inflate inftrees trees uncompr zutil; do
    if zig cc $ZLIB_CFLAGS -o "$BUILD_DIR/obj/zlib_${src}.o" "$ZLIB_SRC/${src}.c" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done

# ── Step 2: Build vendored libjpeg-turbo ──
echo "  Building vendored libjpeg..."
JPEG_VERSION="3.1.0"
JPEG_SRC="$BUILD_DIR/libjpeg-turbo-${JPEG_VERSION}"
if [ ! -d "$JPEG_SRC" ]; then
    cd "$BUILD_DIR"
    curl -sL "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/${JPEG_VERSION}/libjpeg-turbo-${JPEG_VERSION}.tar.gz" | tar xz
fi

# Generate jconfig.h for WASI
cat > "$JPEG_SRC/jconfig.h" << 'CONF'
#define HAVE_PROTOTYPES 1
#define HAVE_UNSIGNED_CHAR 1
#define HAVE_UNSIGNED_SHORT 1
#define HAVE_STDDEF_H 1
#define HAVE_STDLIB_H 1
#define HAVE_LOCALE_H 1
#define JPEG_LIB_VERSION 62
#define LIBJPEG_TURBO_VERSION 3.1.0
#define LIBJPEG_TURBO_VERSION_NUMBER 3001000
#ifndef BITS_IN_JSAMPLE
#define BITS_IN_JSAMPLE 8
#endif
#define C_LOSSLESS_SUPPORTED 1
#define D_LOSSLESS_SUPPORTED 1
CONF

# Generate jconfigint.h
cat > "$JPEG_SRC/jconfigint.h" << 'CONF'
#define BUILD ""
#define PACKAGE_NAME "libjpeg-turbo"
#define VERSION "3.1.0"
#define SIZEOF_SIZE_T 4
#define THREAD_LOCAL
#define INLINE __inline__
#define FALLTHROUGH
#define HIDDEN
CONF

# Generate jversion.h
cat > "$JPEG_SRC/jversion.h" << 'CONF'
#define JVERSION "6b  27-Mar-1998"
#define JCOPYRIGHT1 "Copyright (C) 2009-2024 The libjpeg-turbo Project"
#define JCOPYRIGHT2 ""
#define JCOPYRIGHT_SHORT "Copyright (C) 2024 The libjpeg-turbo Project"
CONF
cp "$JPEG_SRC/jversion.h" "$JPEG_SRC/src/jversion.h" 2>/dev/null

# Copy config headers to src/ for source files that include relative to themselves
cp "$JPEG_SRC/jconfig.h" "$JPEG_SRC/src/jconfig.h" 2>/dev/null
cp "$JPEG_SRC/jconfigint.h" "$JPEG_SRC/src/jconfigint.h" 2>/dev/null

JPEG_CFLAGS="-target wasm32-wasi -c -Os -fPIC -D__wasm_exception_handling__ -I$JPEG_SRC -I$JPEG_SRC/src"
# Compile all library source files (skip standalone tools and test files)
JPEG_SKIP="cjpeg|djpeg|jpegtran|example|tjbench|tjcomp|tjdecomp|tjtran|tjunittest|tjutil|turbojpeg|turbojpeg-mp|strtest|jcstest|rdbmp|rdcolmap|rdgif|rdjpgcom|rdppm|rdswitch|rdtarga|wrbmp|wrgif|wrjpgcom|wrppm|wrtarga|cdjpeg"
for src in "$JPEG_SRC/src"/*.c; do
    [ -f "$src" ] || continue
    name=$(basename "$src" .c)
    echo "$name" | grep -qE "^($JPEG_SKIP)$" && continue
    if zig cc $JPEG_CFLAGS -o "$BUILD_DIR/obj/jpeg_${name}.o" "$src" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done

# Compile 12-bit and 16-bit JPEG variants (required by libjpeg-turbo 3.x)
JPEG16_SRCS="jcapistd jccolor jcdiffct jclossls jcmainct jcprepct jcsample jdapistd jdcolor jddiffct jdlossls jdmainct jdpostct jdsample jutils"
JPEG12_SRCS="$JPEG16_SRCS jccoefct jcdctmgr jdcoefct jddctmgr jdmerge jfdctfst jfdctint jidctflt jidctfst jidctint jidctred jquant1 jquant2"

for src in $JPEG12_SRCS; do
    src_file="$JPEG_SRC/src/${src}.c"
    [ -f "$src_file" ] || continue
    if zig cc $JPEG_CFLAGS -DBITS_IN_JSAMPLE=12 -o "$BUILD_DIR/obj/jpeg12_${src}.o" "$src_file" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done

for src in $JPEG16_SRCS; do
    src_file="$JPEG_SRC/src/${src}.c"
    [ -f "$src_file" ] || continue
    if zig cc $JPEG_CFLAGS -DBITS_IN_JSAMPLE=16 -o "$BUILD_DIR/obj/jpeg16_${src}.o" "$src_file" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done

# ── Step 3: Build vendored libpng ──
echo "  Building vendored libpng..."
PNG_VERSION="1.6.44"
PNG_SRC="$BUILD_DIR/libpng-${PNG_VERSION}"
if [ ! -d "$PNG_SRC" ]; then
    cd "$BUILD_DIR"
    curl -sL "https://github.com/pnggroup/libpng/archive/refs/tags/v${PNG_VERSION}.tar.gz" | tar xz
fi

# Generate pnglibconf.h using libpng's own script
cd "$PNG_SRC"
if [ -f "scripts/pnglibconf.h.prebuilt" ]; then
    cp "scripts/pnglibconf.h.prebuilt" "pnglibconf.h"
else
    # Fall back to generating from the .dfa file
    python3 -c "
import re, sys
with open('scripts/pnglibconf.dfa') as f:
    content = f.read()
# Extract all option lines and generate defines
lines = []
for m in re.finditer(r'^option\s+(\w+)\s+(\w+)', content, re.M):
    name, val = m.group(1), m.group(2)
    if val == 'on' or val == 'enabled':
        lines.append(f'#define PNG_{name}_SUPPORTED')
with open('pnglibconf.h', 'w') as f:
    f.write('#ifndef PNGLIBCONF_H\n#define PNGLIBCONF_H\n')
    for l in lines:
        f.write(l + '\n')
    f.write('#define PNG_MAX_GAMMA_8 11\n')
    f.write('#define PNG_ZBUF_SIZE 8192\n')
    f.write('#define PNG_API_RULE 0\n')
    f.write('#define PNG_QUANTIZE_RED_BITS 5\n')
    f.write('#define PNG_QUANTIZE_GREEN_BITS 5\n')
    f.write('#define PNG_QUANTIZE_BLUE_BITS 5\n')
    f.write('#define PNG_Z_DEFAULT_COMPRESSION (-1)\n')
    f.write('#define PNG_Z_DEFAULT_STRATEGY 1\n')
    f.write('#endif\n')
" 2>/dev/null || echo "  WARNING: Could not generate pnglibconf.h"
fi

PNG_CFLAGS="-target wasm32-wasi -c -Os -fPIC -D__wasm_exception_handling__ -I$PNG_SRC -I$ZLIB_SRC"
for src in png pngerror pngget pngmem pngpread pngread pngrio pngrtran \
           pngrutil pngset pngtrans pngwio pngwrite pngwtran pngwutil; do
    if zig cc $PNG_CFLAGS -o "$BUILD_DIR/obj/png_${src}.o" "$PNG_SRC/${src}.c" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
done

# ── Step 4: Build Pillow's _imaging C extension ──
echo "  Compiling Pillow _imaging..."
IMAGING_DIR="$PILLOW_SRC/src/libImaging"

pillow_cc() {
    local src="$1" out="$2"
    if zig cc -target wasm32-wasi -c -Os -fPIC \
        -D__wasm_exception_handling__ \
        -I"$CPYTHON/Include" -I"$CPYTHON/Include/cpython" -I"$PYCONFIG_DIR" \
        -I"$PILLOW_SRC/src/libImaging" -I"$PILLOW_SRC/src" \
        -I"$ZLIB_SRC" -I"$JPEG_SRC" -I"$JPEG_SRC/src" -I"$PNG_SRC" \
        -DHAVE_LIBJPEG -DHAVE_LIBZ -DHAVE_LIBPNG \
        -DPILLOW_VERSION='"'"$PILLOW_VERSION"'"' \
        -Wno-macro-redefined -Wno-implicit-function-declaration \
        -o "$BUILD_DIR/obj/$out" "$src" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
}

# Compile all C files in libImaging (auto-discover instead of hardcoded list)
for src in "$IMAGING_DIR"/*.c; do
    [ -f "$src" ] || continue
    name=$(basename "$src" .c)
    pillow_cc "$src" "imaging_${name}.o"
done

# Pillow's _imaging module (Python C extension entry point)
if [ -f "$PILLOW_SRC/src/_imaging.c" ]; then
    pillow_cc "$PILLOW_SRC/src/_imaging.c" "pillow_imaging.o"
fi

# Additional src/ C files: codecs (decode/encode), path, outline, map, math, morph
for src in decode encode path outline map _imagingmath _imagingmorph; do
    if [ -f "$PILLOW_SRC/src/${src}.c" ]; then
        pillow_cc "$PILLOW_SRC/src/${src}.c" "pillow_${src}.o"
    fi
done

# setjmp/longjmp implementation for wasm32-wasi (needed by libjpeg and libpng)
SETJMP_SHIM="$ROOT_DIR/lib/wasi-shims/setjmp_shim.c"
if [ -f "$SETJMP_SHIM" ]; then
    if zig cc -target wasm32-wasi -c -Os -fPIC -D__wasm_exception_handling__ \
        -o "$BUILD_DIR/obj/setjmp_shim.o" "$SETJMP_SHIM" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
fi

echo "  Compiled: $SUCCESS files, Failed: $FAIL files"

# Link
HAS_WASM_LD=false
if command -v wasm-ld &>/dev/null; then
    HAS_WASM_LD=true
fi

if [ "$HAS_WASM_LD" = true ]; then
    echo "  Linking _imaging.wasm..."
    # Except.o symbols are already defined in _imaging.c — exclude to avoid duplicates
    rm -f "$BUILD_DIR/obj/imaging_Except.o"
    wasm-ld \
        --no-entry --shared --strip-all --gc-sections \
        --export=PyInit__imaging \
        --allow-undefined \
        -o "$BUILD_DIR/_imaging.wasm" \
        "$BUILD_DIR"/obj/*.o 2>/dev/null || echo "  WARNING: wasm-ld failed"

    if [ -f "$BUILD_DIR/_imaging.wasm" ]; then
        WASM_SIZE=$(ls -la "$BUILD_DIR/_imaging.wasm" | awk '{print $5}')
        echo "  _imaging.wasm: $(echo "scale=1; $WASM_SIZE / 1048576" | bc) MB"
    fi
fi

# Bundle Python files
echo "  Bundling Python files..."
cd "$PILLOW_SRC"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$BUILD_DIR/pillow-site-packages.zip', 'w', zipfile.ZIP_STORED) as zf:
    src_dir = 'src/PIL'
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d != 'tests']
        for f in files:
            if f.endswith('.py'):
                full = os.path.join(root, f)
                # Archive as PIL/<name>.py
                arc = full.replace('src/', '', 1)
                zf.write(full, arc)
count = len(zipfile.ZipFile('$BUILD_DIR/pillow-site-packages.zip').namelist())
size = os.path.getsize('$BUILD_DIR/pillow-site-packages.zip') // 1024
print(f'  {count} Python files, {size}KB')
"

# Install outputs
echo "  Installing outputs..."
mkdir -p "$OUTPUT_DIR"
if [ -f "$BUILD_DIR/_imaging.wasm" ]; then
    cp "$BUILD_DIR/_imaging.wasm" "$OUTPUT_DIR/"
fi
cp "$BUILD_DIR/pillow-site-packages.zip" "$OUTPUT_DIR/"

# Copy objects for variant builder
VARIANT_OBJ_DIR="$ROOT_DIR/build/zig-wasi/Modules/pillow"
mkdir -p "$VARIANT_OBJ_DIR"
cp "$BUILD_DIR"/obj/*.o "$VARIANT_OBJ_DIR/"
OBJ_COUNT=$(ls "$VARIANT_OBJ_DIR"/*.o 2>/dev/null | wc -l | tr -d ' ')
echo "  $OBJ_COUNT objects copied for variant linking"

echo ""
echo "Done! Pillow for wasm32-wasi:"
echo "  Objects: $VARIANT_OBJ_DIR/"
echo "  Python: $OUTPUT_DIR/pillow-site-packages.zip"
echo ""
echo "To build variant: ./scripts/build-variant.sh pillow"
