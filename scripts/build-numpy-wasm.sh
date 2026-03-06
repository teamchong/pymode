#!/bin/bash
# Build numpy's C extensions as a .wasm side module for PyMode.
#
# Downloads numpy source from PyPI, generates headers, compiles all C/C++
# files to wasm32-wasi via zig cc, and links into _multiarray_umath.wasm.
#
# Prerequisites:
#   - zig >= 0.15 (provides zig cc targeting wasm32-wasi)
#   - wasm-ld (from LLVM, e.g. brew install llvm)
#   - python3 (for numpy's code generators)
#   - cpython/ directory with cross-build/wasm32-wasi/ headers and libpython3.13.a
#
# Output:
#   worker/src/extensions/numpy/_multiarray_umath.wasm
#   worker/src/extensions/numpy/numpy-site-packages.zip (Python layer)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="/tmp/numpy-wasm-build"
OUTPUT_DIR="$ROOT_DIR/worker/src/extensions/numpy"

# Check prerequisites
if ! command -v zig &>/dev/null; then
    echo "Error: zig not found. Install zig >= 0.15"
    exit 1
fi
if ! command -v wasm-ld &>/dev/null; then
    echo "Error: wasm-ld not found. Install LLVM (brew install llvm)"
    exit 1
fi
if [ ! -f "$CPYTHON/cross-build/wasm32-wasi/pyconfig.h" ]; then
    echo "Error: CPython cross-build not found. Run build-phase1.sh first."
    exit 1
fi

# Download numpy source
NUMPY_VERSION="2.4.2"
NUMPY_SRC="$BUILD_DIR/numpy-${NUMPY_VERSION}"

if [ ! -d "$NUMPY_SRC" ]; then
    echo "Downloading numpy ${NUMPY_VERSION}..."
    mkdir -p "$BUILD_DIR"
    pip3 download "numpy==${NUMPY_VERSION}" --no-binary=:all: --no-deps -d "$BUILD_DIR" 2>/dev/null
    cd "$BUILD_DIR"
    tar xzf "numpy-${NUMPY_VERSION}.tar.gz"
fi

echo "Building numpy ${NUMPY_VERSION} → wasm32-wasi..."

# Step 1: Generate headers via numpy's code generators
echo "  Generating headers..."
cd "$NUMPY_SRC"
mkdir -p "$BUILD_DIR/gen"
python3 numpy/_core/code_generators/generate_numpy_api.py -o "$BUILD_DIR/gen" 2>/dev/null
python3 numpy/_core/code_generators/generate_ufunc_api.py -o "$BUILD_DIR/gen" 2>/dev/null
python3 numpy/_core/code_generators/generate_umath.py -o "$BUILD_DIR/gen/__umath_generated.c" 2>/dev/null
python3 numpy/_core/code_generators/generate_umath_doc.py -o "$BUILD_DIR/gen/_umath_doc_generated.h" 2>/dev/null

# Step 2: Process .c.src templates
echo "  Processing templates..."
mkdir -p "$BUILD_DIR/processed"
for f in $(find numpy/_core/src -name "*.c.src" -o -name "*.h.src"); do
    outname=$(basename "$f" .src)
    python3 numpy/_build_utils/process_src_template.py "$f" -o "$BUILD_DIR/processed/$outname" 2>/dev/null
done

# Copy processed headers to source directories
cp "$BUILD_DIR/processed/arraytypes.h" numpy/_core/src/multiarray/arraytypes.h 2>/dev/null || true
cp "$BUILD_DIR/processed/loops.h" numpy/_core/src/umath/loops.h 2>/dev/null || true
cp "$BUILD_DIR/processed/matmul.h" numpy/_core/src/umath/matmul.h 2>/dev/null || true

# Step 3: Create wasm32-wasi config headers
echo "  Creating config headers..."

# _numpyconfig.h — type sizes for wasm32 (4-byte pointers, long double = double)
cat > "$NUMPY_SRC/numpy/_core/include/numpy/_numpyconfig.h" << 'CONF'
#define NPY_SIZEOF_SHORT 2
#define NPY_SIZEOF_INT 4
#define NPY_SIZEOF_LONG 4
#define NPY_SIZEOF_FLOAT 4
#define NPY_SIZEOF_COMPLEX_FLOAT 8
#define NPY_SIZEOF_DOUBLE 8
#define NPY_SIZEOF_COMPLEX_DOUBLE 16
#define NPY_SIZEOF_LONGDOUBLE 8
#define NPY_SIZEOF_COMPLEX_LONGDOUBLE 16
#define NPY_SIZEOF_PY_INTPTR_T 4
#define NPY_SIZEOF_INTP 4
#define NPY_SIZEOF_UINTP 4
#define NPY_SIZEOF_WCHAR_T 4
#define NPY_SIZEOF_OFF_T 8
#define NPY_SIZEOF_PY_LONG_LONG 8
#define NPY_SIZEOF_LONGLONG 8
#define NPY_NO_SMP 1
#define NPY_VISIBILITY_HIDDEN
#define NPY_ABI_VERSION 0x02000000
#define NPY_API_VERSION 0x00000015
#ifndef __STDC_FORMAT_MACROS
#define __STDC_FORMAT_MACROS 1
#endif
CONF

# config.h — platform feature detection for WASI
cat > "$BUILD_DIR/config.h" << 'CONF'
#define HAVE_LDOUBLE_IEEE_DOUBLE_LE 1
#define HAVE_ENDIAN_H 0
#define HAVE_SYS_ENDIAN_H 0
#define HAVE_XLOCALE_H 0
#define HAVE_DLFCN_H 0
#define HAVE_BACKTRACE 0
#define HAVE_PTHREAD_H 0
#define HAVE___THREAD 0
#define HAVE_SIGSETJMP 0
#define HAVE_SIGACTION 0
CONF

# CPU dispatch config — wasm32 has no SIMD, all dispatch is baseline
cat > "$NUMPY_SRC/numpy/_core/src/common/npy_cpu_dispatch_config.h" << 'CONF'
#ifndef NPY_CPU_DISPATCH_CONFIG_H_
#define NPY_CPU_DISPATCH_CONFIG_H_
#define NPY_CPU_DISPATCH_INFO() {NULL, NULL}
#define NPY_WITH_CPU_BASELINE ""
#define NPY_WITH_CPU_DISPATCH ""
#define NPY_CPU_DISPATCH_DECLARE(DECL, ARGS) DECL ARGS;
#define NPY_CPU_DISPATCH_CALL(CALL, ...) CALL
#define NPY_CPU_DISPATCH_CALL_XB(CALL, ...) CALL
#define NPY_CPU_DISPATCH_CURFX(NAME) NAME
#endif
CONF

# Empty xlocale.h and feature_detection_misc.h (not available in WASI)
echo "" > "$BUILD_DIR/xlocale.h"
echo "#ifndef FEATURE_DETECTION_MISC_H_" > "$BUILD_DIR/feature_detection_misc.h"
echo "#define FEATURE_DETECTION_MISC_H_" >> "$BUILD_DIR/feature_detection_misc.h"
echo "#define NPY_CPU_HAVE(X) 0" >> "$BUILD_DIR/feature_detection_misc.h"
echo "#endif" >> "$BUILD_DIR/feature_detection_misc.h"

# CPU dispatch headers — one per dispatch unit, all baseline-only
mkdir -p "$BUILD_DIR/dispatch"
for name in _simd _umath_tests argfunc arithmetic \
  highway_qsort_16bit highway_qsort \
  loops_arithm_fp loops_arithmetic loops_autovec loops_comparison \
  loops_exponent_log loops_half loops_hyperbolic loops_logical \
  loops_minmax loops_modulo loops_trigonometric loops_umath_fp \
  loops_unary_complex loops_unary_fp_le loops_unary_fp loops_unary \
  x86_simd_argsort x86_simd_qsort_16bit x86_simd_qsort; do
  cat > "$BUILD_DIR/dispatch/${name}.dispatch.h" << 'DISP'
/* wasm32 baseline-only dispatch */
#undef NPY_CPU_DISPATCH_DECLARE
#define NPY_CPU_DISPATCH_DECLARE(DECL, ARGS) DECL ARGS;
#undef NPY_CPU_DISPATCH_CALL
#define NPY_CPU_DISPATCH_CALL(CALL, ...) CALL
#undef NPY_CPU_DISPATCH_CALL_XB
#define NPY_CPU_DISPATCH_CALL_XB(CALL, ...) CALL
#undef NPY_CPU_DISPATCH_CURFX
#define NPY_CPU_DISPATCH_CURFX(NAME) NAME
DISP
done

# Step 4: Compile
echo "  Compiling C/C++ files..."
CFLAGS="-target wasm32-wasi -c -fPIC -Os \
  -D_MULTIARRAYMODULE -D_UMATHMODULE -DNPY_INTERNAL_BUILD=1 -DNPY_NO_SMP=1 \
  -UHAVE_BACKTRACE -DHAVE_XLOCALE_H=0 \
  -I$BUILD_DIR \
  -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$CPYTHON/cross-build/wasm32-wasi \
  -I$NUMPY_SRC/numpy/_core/include -I$NUMPY_SRC/numpy/_core/src/common \
  -I$NUMPY_SRC/numpy/_core/src/multiarray -I$NUMPY_SRC/numpy/_core/src/umath \
  -I$NUMPY_SRC/numpy/_core/src/npymath -I$NUMPY_SRC/numpy/_core/src/npysort \
  -I$BUILD_DIR/processed -I$BUILD_DIR/dispatch -I$BUILD_DIR/gen \
  -Wno-macro-redefined -Wno-implicit-function-declaration"

SUCCESS=0
FAIL=0
mkdir -p "$BUILD_DIR/obj"

compile_c() {
    local src="$1" out="$2"
    if zig cc $CFLAGS -o "$BUILD_DIR/obj/$out" "$src" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
}

compile_cpp() {
    local src="$1" out="$2"
    if zig c++ $CFLAGS -std=c++17 -Wno-missing-template-arg-list-after-template-kw -o "$BUILD_DIR/obj/$out" "$src" 2>/dev/null; then
        SUCCESS=$((SUCCESS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
}

# Multiarray C files
for src in alloc arrayobject array_coercion array_converter array_method \
  array_api_standard array_assign_scalar array_assign_array arrayfunction_override \
  arraywrap buffer calculation compiled_base common common_dtype convert \
  convert_datatype conversion_utils ctors descriptor dtypemeta dragon4 \
  dtype_transfer dtype_traversal flagsobject getset hashdescr item_selection \
  iterators mapping methods multiarraymodule nditer_api nditer_constr \
  nditer_pywrap number refcount sequence scalarapi shape strfuncs \
  usertypes vdot npy_static_data fnv abstractdtypes dlpack \
  public_dtype_api legacy_dtype_implementation datetime datetime_strings \
  datetime_busday datetime_busdaycal; do
  [ -f "$NUMPY_SRC/numpy/_core/src/multiarray/${src}.c" ] && \
    compile_c "$NUMPY_SRC/numpy/_core/src/multiarray/${src}.c" "ma_${src}.o"
done

# Processed C templates
for src in arraytypes scalartypes lowlevel_strided_loops nditer_templ einsum_sumprod; do
  compile_c "$BUILD_DIR/processed/${src}.c" "tp_${src}.o"
done

# Common utilities
for src in array_assign mem_overlap npy_argparse npy_import npy_longdouble \
  ufunc_override numpyos npy_cpu_features npy_cpu_dispatch gil_utils; do
  [ -f "$NUMPY_SRC/numpy/_core/src/common/${src}.c" ] && \
    compile_c "$NUMPY_SRC/numpy/_core/src/common/${src}.c" "cm_${src}.o"
done

# umath (universal functions: add, multiply, sin, cos, etc.)
for src in ufunc_type_resolution extobj legacy_array_method override \
  reduction ufunc_object umathmodule wrapping_array_method _scaled_float_dtype; do
  compile_c "$NUMPY_SRC/numpy/_core/src/umath/${src}.c" "um_${src}.o"
done

# npymath (numpy's internal math library)
for src in npy_math halffloat; do
  compile_c "$NUMPY_SRC/numpy/_core/src/npymath/${src}.c" "nm_${src}.o"
done
compile_c "$BUILD_DIR/processed/ieee754.c" "nm_ieee754.o"
compile_c "$BUILD_DIR/processed/npy_math_complex.c" "nm_npy_math_complex.o"
compile_c "$NUMPY_SRC/numpy/_core/src/npymath/arm64_exports.c" "nm_arm64.o"

# Dispatch implementations (baseline scalar loops)
compile_c "$BUILD_DIR/processed/argfunc.dispatch.c" "dp_argfunc.o"
compile_c "$BUILD_DIR/processed/loops.c" "dp_loops.o"
compile_c "$BUILD_DIR/processed/matmul.c" "dp_matmul.o"
compile_c "$BUILD_DIR/processed/scalarmath.c" "dp_scalarmath.o"
for src in "$BUILD_DIR"/processed/loops_*.dispatch.c; do
  name=$(basename "$src" .c)
  compile_c "$src" "dp_${name}.o"
done

# C++ files (multiarray)
compile_cpp "$NUMPY_SRC/numpy/_core/src/multiarray/einsum.cpp" "ma_einsum.o"
compile_cpp "$NUMPY_SRC/numpy/_core/src/multiarray/stringdtype/casts.cpp" "sd_casts.o"

# C++ files (umath)
for src in clip dispatching special_integer_comparisons string_ufuncs stringdtype_ufuncs; do
  compile_cpp "$NUMPY_SRC/numpy/_core/src/umath/${src}.cpp" "um_${src}.o"
done

# C++ files (common)
compile_cpp "$NUMPY_SRC/numpy/_core/src/common/npy_hashtable.cpp" "cm_npy_hashtable.o"

# C++ files (npysort)
for src in quicksort mergesort timsort heapsort radixsort selection binsearch; do
  compile_cpp "$NUMPY_SRC/numpy/_core/src/npysort/${src}.cpp" "st_${src}.o"
done

# textreading
for src in conversions field_types growth readtext rows stream_pyobject str_to_int; do
  compile_c "$NUMPY_SRC/numpy/_core/src/multiarray/textreading/${src}.c" "tr_${src}.o"
done
compile_cpp "$NUMPY_SRC/numpy/_core/src/multiarray/textreading/tokenize.cpp" "tr_tokenize.o"

# stringdtype
for src in dtype utf8_utils static_string; do
  compile_c "$NUMPY_SRC/numpy/_core/src/multiarray/stringdtype/${src}.c" "sd_${src}.o"
done

echo "  Compiled: $SUCCESS files, Failed: $FAIL files"

# Step 5: Link into _multiarray_umath.wasm
echo "  Linking _multiarray_umath.wasm..."

# Link as shared WASM module. CPython symbols are left undefined —
# they resolve at runtime when python.wasm loads this side module via dl_open.
wasm-ld \
  --no-entry --shared --strip-all --gc-sections \
  --export=PyInit__multiarray_umath \
  --allow-undefined \
  -o "$BUILD_DIR/_multiarray_umath.wasm" \
  "$BUILD_DIR"/obj/*.o

WASM_SIZE=$(ls -la "$BUILD_DIR/_multiarray_umath.wasm" | awk '{print $5}')
GZIP_SIZE=$(gzip -c "$BUILD_DIR/_multiarray_umath.wasm" | wc -c | tr -d ' ')

echo "  _multiarray_umath.wasm: $(echo "scale=1; $WASM_SIZE / 1048576" | bc) MB raw, $(echo "scale=1; $GZIP_SIZE / 1048576" | bc) MB gzipped"

# Step 6: Bundle numpy's Python files into a zip
echo "  Bundling Python files..."
cd "$NUMPY_SRC"
python3 -c "
import zipfile, os
with zipfile.ZipFile('$BUILD_DIR/numpy-site-packages.zip', 'w', zipfile.ZIP_STORED) as zf:
    for root, dirs, files in os.walk('numpy'):
        dirs[:] = [d for d in dirs if d not in ('tests', 'testing', 'distutils', 'f2py', '_pyinstaller', 'doc', 'typing')]
        for f in files:
            if f.endswith('.py'):
                path = os.path.join(root, f)
                zf.write(path)
count = len(zipfile.ZipFile('$BUILD_DIR/numpy-site-packages.zip').namelist())
size = os.path.getsize('$BUILD_DIR/numpy-site-packages.zip') // 1024
print(f'  {count} Python files, {size}KB')
"

# Step 7: Copy to output directory
echo "  Installing to $OUTPUT_DIR..."
mkdir -p "$OUTPUT_DIR"
cp "$BUILD_DIR/_multiarray_umath.wasm" "$OUTPUT_DIR/"
cp "$BUILD_DIR/numpy-site-packages.zip" "$OUTPUT_DIR/"

echo ""
echo "Done! numpy for wasm32-wasi:"
echo "  WASM:   $OUTPUT_DIR/_multiarray_umath.wasm ($(echo "scale=1; $WASM_SIZE / 1048576" | bc) MB)"
echo "  Python: $OUTPUT_DIR/numpy-site-packages.zip"
echo ""
echo "To use in a worker:"
echo "  1. Add to wrangler.toml: [wasm_modules] numpy = \"extensions/numpy/_multiarray_umath.wasm\""
echo "  2. Mount numpy-site-packages.zip in PYTHONPATH"
echo "  3. import numpy as np  # works via dl_open"
