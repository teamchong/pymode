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
HAS_WASM_LD=false
if command -v wasm-ld &>/dev/null; then
    HAS_WASM_LD=true
fi
PYCONFIG_DIR="$CPYTHON/cross-build/wasm32-wasi"
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    # Fall back to zig-wasi build directory
    PYCONFIG_DIR="$ROOT_DIR/build/zig-wasi"
fi
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    echo "Error: pyconfig.h not found. Run build-phase2.sh first."
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
for f in $(find numpy/_core/src -name "*.c.src" -o -name "*.h.src" -o -name "*.inc.src"); do
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
#define NPY_CPU_DISPATCH_CALL_XB(CALL, ...) /* no SIMD on wasm32 */
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
#define NPY_CPU_DISPATCH_CALL_XB(CALL, ...) /* no SIMD on wasm32 */
#undef NPY_CPU_DISPATCH_CURFX
#define NPY_CPU_DISPATCH_CURFX(NAME) NAME
DISP
done

# Step 4: Compile
echo "  Compiling C/C++ files..."
CFLAGS="-target wasm32-wasi -c -fPIC -Os \
  -D_MULTIARRAYMODULE -D_UMATHMODULE -DNPY_INTERNAL_BUILD=1 -DNPY_NO_SMP=1 \
  -UHAVE_BACKTRACE -DHAVE_XLOCALE_H=0 \
  -Drestrict=__restrict__ \
  -I$BUILD_DIR \
  -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$PYCONFIG_DIR \
  -I$NUMPY_SRC/numpy/_core/include -I$NUMPY_SRC/numpy/_core/src/common \
  -I$NUMPY_SRC/numpy/_core/src/multiarray -I$NUMPY_SRC/numpy/_core/src/umath \
  -I$NUMPY_SRC/numpy/_core/src/npymath -I$NUMPY_SRC/numpy/_core/src/npysort \
  -I$BUILD_DIR/processed -I$BUILD_DIR/dispatch -I$BUILD_DIR/gen \
  -Wno-macro-redefined -Wno-implicit-function-declaration"

SUCCESS=0
FAIL=0
mkdir -p "$BUILD_DIR/obj"

FAILED_FILES=""
FIRST_FAIL_SHOWN=false
show_fail() {
    local out="$1" errfile="$2"
    FAIL=$((FAIL + 1))
    FAILED_FILES="$FAILED_FILES $out"
    echo "    FAIL: $out"
    grep "error:" "$errfile" | head -3
    # Show full error output for first failure to aid debugging
    if [ "$FIRST_FAIL_SHOWN" = false ]; then
        FIRST_FAIL_SHOWN=true
        echo "    --- Full error output for first failure ($out) ---"
        cat "$errfile" | head -30
        echo "    --- End of error output ---"
    fi
}

compile_c() {
    local src="$1" out="$2"
    local errfile="$BUILD_DIR/obj/${out}.err"
    if zig cc $CFLAGS -o "$BUILD_DIR/obj/$out" "$src" 2>"$errfile"; then
        SUCCESS=$((SUCCESS + 1))
        rm -f "$errfile"
    else
        show_fail "$out" "$errfile"
    fi
}

compile_cpp() {
    local src="$1" out="$2"
    local errfile="$BUILD_DIR/obj/${out}.err"
    if zig c++ $CFLAGS -std=c++17 -Wno-missing-template-arg-list-after-template-kw -o "$BUILD_DIR/obj/$out" "$src" 2>"$errfile"; then
        SUCCESS=$((SUCCESS + 1))
        rm -f "$errfile"
    else
        show_fail "$out" "$errfile"
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
compile_c "$NUMPY_SRC/numpy/_core/src/npymath/npy_math.c" "nm_npy_math.o"
# halffloat is C++ in numpy 2.4+
compile_cpp "$NUMPY_SRC/numpy/_core/src/npymath/halffloat.cpp" "nm_halffloat.o"
# ieee754 may exist as .c (processed template) or .cpp (numpy 2.4+)
if [ -f "$BUILD_DIR/processed/ieee754.c" ]; then
  compile_c "$BUILD_DIR/processed/ieee754.c" "nm_ieee754.o"
fi
if [ -f "$NUMPY_SRC/numpy/_core/src/npymath/ieee754.cpp" ] && [ ! -f "$BUILD_DIR/obj/nm_ieee754.o" ]; then
  compile_cpp "$NUMPY_SRC/numpy/_core/src/npymath/ieee754.cpp" "nm_ieee754.o"
fi
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

# C++ dispatch files — skipped for wasm32-wasi:
# loops_trigonometric.dispatch.cpp requires unprocessed loops.h.src templates
# loops_logical.dispatch.cpp requires Google Highway SIMD (hwy/highway.h)
# These are SIMD-optimized paths; the baseline scalar loops (loops.c) cover all ops.

# C++ files (multiarray)
compile_cpp "$NUMPY_SRC/numpy/_core/src/multiarray/einsum.cpp" "ma_einsum.o"
compile_cpp "$NUMPY_SRC/numpy/_core/src/multiarray/unique.cpp" "ma_unique.o"
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

# numpy.random — C source files (bit generators, distributions)
echo "  Compiling numpy.random..."
RANDOM_CFLAGS="-target wasm32-wasi -c -fPIC -Os -DNDEBUG \
  -Drestrict=__restrict__ \
  -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$PYCONFIG_DIR \
  -I$NUMPY_SRC/numpy/_core/include -I$NUMPY_SRC/numpy/_core/src/common \
  -I$NUMPY_SRC/numpy/random/src -I$NUMPY_SRC/numpy/random \
  -I$BUILD_DIR -I$BUILD_DIR/gen -Wno-macro-redefined"

# Use compile_c for random sources too (with error visibility)
SAVE_CFLAGS="$CFLAGS"
CFLAGS="$RANDOM_CFLAGS"

for src in mt19937 pcg64 philox sfc64 randomkit; do
  [ -f "$NUMPY_SRC/numpy/random/src/${src}/${src}.c" ] && \
    compile_c "$NUMPY_SRC/numpy/random/src/${src}/${src}.c" "random_${src}.o"
done

[ -f "$NUMPY_SRC/numpy/random/src/mt19937/mt19937-jump.c" ] && \
  compile_c "$NUMPY_SRC/numpy/random/src/mt19937/mt19937-jump.c" "random_mt19937_jump.o"

for src in distributions logfactorial random_hypergeometric random_mvhg_count random_mvhg_marginals; do
  [ -f "$NUMPY_SRC/numpy/random/src/distributions/${src}.c" ] && \
    compile_c "$NUMPY_SRC/numpy/random/src/distributions/${src}.c" "random_dist_${src}.o"
done

if [ -f "$NUMPY_SRC/numpy/random/src/legacy/legacy-distributions.c" ]; then
  CFLAGS="$RANDOM_CFLAGS -I$NUMPY_SRC/numpy/random/src/legacy"
  compile_c "$NUMPY_SRC/numpy/random/src/legacy/legacy-distributions.c" "random_legacy_distributions.o"
fi

CFLAGS="$SAVE_CFLAGS"

# Cython random modules — need cython to generate .c from .pyx
CYTHON_RANDOM_CFLAGS="-target wasm32-wasi -c -fPIC -Os -DNDEBUG -DCYTHON_COMPRESS_STRINGS=0 \
  -Drestrict=__restrict__ \
  -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$PYCONFIG_DIR \
  -I$NUMPY_SRC/numpy/_core/include -I$NUMPY_SRC/numpy/_core/src/common \
  -I$NUMPY_SRC/numpy/random/src -I$NUMPY_SRC/numpy/random \
  -I$BUILD_DIR -I$BUILD_DIR/gen -Wno-macro-redefined -Wno-implicit-function-declaration"

CYTHON_CMD=""
if command -v cython3 &>/dev/null; then
  CYTHON_CMD="cython3"
elif command -v cython &>/dev/null; then
  CYTHON_CMD="cython"
elif python3 -c "import Cython" 2>/dev/null; then
  CYTHON_CMD="python3 -m cython"
fi

if [ -n "$CYTHON_CMD" ]; then
  echo "  Cythonizing random modules (using $CYTHON_CMD)..."
  SAVE_CFLAGS="$CFLAGS"
  CFLAGS="$CYTHON_RANDOM_CFLAGS"
  for pyx in bit_generator _common _bounded_integers _generator _mt19937 _pcg64 _sfc64 _philox mtrand; do
    PYX_FILE="$NUMPY_SRC/numpy/random/${pyx}.pyx"
    C_FILE="$NUMPY_SRC/numpy/random/${pyx}.c"
    if [ -f "$PYX_FILE" ] && [ ! -f "$C_FILE" ]; then
      $CYTHON_CMD "$PYX_FILE" -o "$C_FILE" 2>/dev/null || true
    fi
    [ -f "$C_FILE" ] && compile_c "$C_FILE" "random_cython_${pyx}.o"
  done
  CFLAGS="$SAVE_CFLAGS"
else
  echo "  WARNING: Cython not found, skipping random Cython modules"
fi

# numpy.fft — pocketfft (C++)
echo "  Compiling numpy.fft..."
FFT_SRC="$NUMPY_SRC/numpy/fft/_pocketfft_umath.cpp"
if [ -f "$FFT_SRC" ]; then
  FFT_CFLAGS="-target wasm32-wasi -c -fPIC -Os -DNDEBUG -std=c++17 \
    -Drestrict=__restrict__ \
    -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$PYCONFIG_DIR \
    -I$NUMPY_SRC/numpy/_core/include -I$NUMPY_SRC/numpy/_core/src/common \
    -I$NUMPY_SRC/numpy/fft -I$BUILD_DIR -I$BUILD_DIR/gen \
    -Wno-macro-redefined -Wno-missing-template-arg-list-after-template-kw"
  FFT_ERR="$BUILD_DIR/obj/fft_pocketfft_umath.o.err"
  if zig c++ $FFT_CFLAGS -o "$BUILD_DIR/obj/fft_pocketfft_umath.o" "$FFT_SRC" 2>"$FFT_ERR"; then
    SUCCESS=$((SUCCESS + 1))
    echo "    pocketfft compiled ok"
    rm -f "$FFT_ERR"
  else
    echo "    FAIL: pocketfft"
    grep "error:" "$FFT_ERR" | head -5
    FAIL=$((FAIL + 1))
  fi
fi

# Scalar implementations for ufunc loops that numpy's C++ SIMD dispatch files
# (loops_trigonometric.dispatch.cpp, loops_logical.dispatch.cpp) would normally
# provide. On wasm32-wasi there is no SIMD hardware, so we compile the baseline
# scalar versions directly. These are the same algorithms as numpy's #else paths.
cat > "$BUILD_DIR/obj/_wasm_scalar_loops.c" << 'SCALAR'
#include "Python.h"
#include "numpy/ndarraytypes.h"
#include "numpy/npy_common.h"
#include "numpy/npy_math.h"

/* Boolean ufunc loops (from loops_logical.dispatch.cpp scalar path) */
void BOOL_logical_and(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    char *ip1=args[0], *ip2=args[1], *op=args[2];
    npy_intp is1=steps[0], is2=steps[1], os=steps[2], n=dimensions[0];
    for (npy_intp i=0; i<n; i++, ip1+=is1, ip2+=is2, op+=os)
        *(npy_bool*)op = (*(npy_bool*)ip1 && *(npy_bool*)ip2);
}
void BOOL_logical_or(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    char *ip1=args[0], *ip2=args[1], *op=args[2];
    npy_intp is1=steps[0], is2=steps[1], os=steps[2], n=dimensions[0];
    for (npy_intp i=0; i<n; i++, ip1+=is1, ip2+=is2, op+=os)
        *(npy_bool*)op = (*(npy_bool*)ip1 || *(npy_bool*)ip2);
}
void BOOL_logical_not(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    char *ip1=args[0], *op=args[1];
    npy_intp is1=steps[0], os=steps[1], n=dimensions[0];
    for (npy_intp i=0; i<n; i++, ip1+=is1, op+=os)
        *(npy_bool*)op = !*(npy_bool*)ip1;
}
void BOOL_absolute(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    char *ip1=args[0], *op=args[1];
    npy_intp is1=steps[0], os=steps[1], n=dimensions[0];
    for (npy_intp i=0; i<n; i++, ip1+=is1, op+=os)
        *(npy_bool*)op = (*(npy_bool*)ip1 != 0);
}

/* Trigonometric ufunc loops (from loops_trigonometric.dispatch.cpp scalar path) */
void FLOAT_sin(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(float*)op = npy_sinf(*(const float*)ip);
}
void FLOAT_cos(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(float*)op = npy_cosf(*(const float*)ip);
}
void DOUBLE_sin(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(double*)op = npy_sin(*(const double*)ip);
}
void DOUBLE_cos(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(double*)op = npy_cos(*(const double*)ip);
}
void FLOAT_tanh(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(float*)op = npy_tanhf(*(const float*)ip);
}
void DOUBLE_tanh(char **args, npy_intp const *dimensions, npy_intp const *steps, void *data) {
    npy_intp n=dimensions[0], is=steps[0], os=steps[1];
    char *ip=args[0], *op=args[1];
    for (npy_intp i=0; i<n; i++, ip+=is, op+=os)
        *(double*)op = npy_tanh(*(const double*)ip);
}

/*
 * temp_elide: On platforms with shared libraries, numpy uses dladdr() to check
 * if temporary arrays can be elided. On wasm32-wasi (no shared libraries),
 * elision never applies. Return 0 = "don't elide".
 */
int try_binary_elide(PyArrayObject *m1, PyArrayObject *m2,
                     PyArrayObject *(*op)(PyArrayObject *, PyArrayObject *, PyArrayObject *),
                     PyArrayObject **res, int commutative) {
    return 0;
}
int can_elide_temp_unary(PyArrayObject *m1) {
    return 0;
}

/*
 * blas_utils: BLAS floating-point exception support detection.
 * Not relevant on wasm32-wasi (no BLAS library linked).
 */
static int _blas_supports_fpe = 0;
int npy_blas_supports_fpe(void) { return _blas_supports_fpe; }
int npy_set_blas_supports_fpe(int val) { _blas_supports_fpe = val; return 0; }

/*
 * C++ exception ABI for wasm32-wasi.
 *
 * WASI has no native C++ exception support (no stack unwinding, no personality
 * routines). zig cc provides libc++ but NOT libc++abi for the wasm32-wasi target.
 * These functions implement the Itanium C++ ABI exception interface — since
 * wasm32-wasi cannot propagate exceptions, throw terminates the program.
 *
 * Referenced by: pocketfft_umath.cpp (FFT error handling), unique.cpp (sort errors)
 */
#include <stdlib.h>

void *__cxa_allocate_exception(unsigned long thrown_size) {
    (void)thrown_size;
    abort();
    return (void*)0;
}

void __cxa_throw(void *thrown_exception, void *tinfo, void (*dest)(void *)) {
    (void)thrown_exception;
    (void)tinfo;
    (void)dest;
    abort();
}

void *__cxa_begin_catch(void *exn) {
    (void)exn;
    abort();
    return (void*)0;
}

void __cxa_end_catch(void) {
    abort();
}

SCALAR
compile_c "$BUILD_DIR/obj/_wasm_scalar_loops.c" "_wasm_scalar_loops.o"

echo "  Compiled: $SUCCESS files, Failed: $FAIL files"
if [ $FAIL -gt 0 ]; then
  echo "  Failed files:$FAILED_FILES"
fi

# Step 5: Link into _multiarray_umath.wasm (optional — variant builder can link instead)
if [ "$HAS_WASM_LD" = true ]; then
  echo "  Linking _multiarray_umath.wasm..."
  wasm-ld \
    --no-entry --shared --strip-all --gc-sections \
    --export=PyInit__multiarray_umath \
    --allow-undefined \
    -o "$BUILD_DIR/_multiarray_umath.wasm" \
    "$BUILD_DIR"/obj/*.o

  WASM_SIZE=$(ls -la "$BUILD_DIR/_multiarray_umath.wasm" | awk '{print $5}')
  GZIP_SIZE=$(gzip -c "$BUILD_DIR/_multiarray_umath.wasm" | wc -c | tr -d ' ')
  echo "  _multiarray_umath.wasm: $(echo "scale=1; $WASM_SIZE / 1048576" | bc) MB raw, $(echo "scale=1; $GZIP_SIZE / 1048576" | bc) MB gzipped"
else
  echo "  Skipping wasm-ld link (not installed). Use build-variant.sh to link."
fi

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

# Step 7: Copy objects to variant build directory (for build-variant.sh)
VARIANT_OBJ_DIR="$ROOT_DIR/build/zig-wasi/Modules/numpy"
echo "  Copying objects to $VARIANT_OBJ_DIR..."
mkdir -p "$VARIANT_OBJ_DIR"
cp "$BUILD_DIR"/obj/*.o "$VARIANT_OBJ_DIR/"
OBJ_COUNT=$(ls "$VARIANT_OBJ_DIR"/*.o | wc -l | tr -d ' ')
echo "  $OBJ_COUNT objects copied for variant linking"

# Step 8: Copy to output directory
echo "  Installing outputs..."
mkdir -p "$OUTPUT_DIR"
if [ -f "$BUILD_DIR/_multiarray_umath.wasm" ]; then
  cp "$BUILD_DIR/_multiarray_umath.wasm" "$OUTPUT_DIR/"
fi
cp "$BUILD_DIR/numpy-site-packages.zip" "$OUTPUT_DIR/"

# Also copy numpy-site-packages.zip to worker/src for tests
cp "$BUILD_DIR/numpy-site-packages.zip" "$ROOT_DIR/worker/src/numpy-site-packages.zip"

echo ""
echo "Done! numpy for wasm32-wasi:"
echo "  Objects: $VARIANT_OBJ_DIR/ ($OBJ_COUNT files)"
echo "  Python: $OUTPUT_DIR/numpy-site-packages.zip"
echo ""
echo "To build variant: ./scripts/build-variant.sh numpy"
