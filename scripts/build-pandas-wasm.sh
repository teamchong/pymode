#!/bin/bash
# Build pandas's Cython/C extensions for wasm32-wasi via zig cc.
#
# Pandas has ~39 Cython modules + 2 C-only modules. Each becomes a separate
# extension; the variant build then links them as static modules.
#
# Pipeline:
#   1. Download pandas 2.2.3 source from PyPI
#   2. Expand .pxi.in tempita templates -> .pxi
#   3. Cythonize each .pyx -> .c using numpy's Cython headers
#   4. Compile every .c (or .cpp) -> .o for wasm32-wasi
#   5. Bundle pandas/, pytz/, dateutil/ Python sources into a zip
#   6. Copy objects to build/zig-wasi/Modules/pandas/ for variant linking

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="/tmp/pandas-wasm-build"
RECIPE_DIR="$ROOT_DIR/build/recipes/pandas"
VARIANT_OBJ_DIR="$ROOT_DIR/build/zig-wasi/Modules/pandas"
OUTPUT_DIR="$ROOT_DIR/worker/src/extensions/pandas"

if ! command -v zig &>/dev/null; then
    echo "Error: zig not found. Install zig >= 0.15"
    exit 1
fi

PYCONFIG_DIR="$CPYTHON/cross-build/wasm32-wasi"
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    PYCONFIG_DIR="$ROOT_DIR/build/zig-wasi"
fi
if [ ! -f "$PYCONFIG_DIR/pyconfig.h" ]; then
    echo "Error: pyconfig.h not found. Run build-phase2.ts first."
    exit 1
fi

# Numpy headers — pandas depends on numpy's C API
NUMPY_BUILD="/tmp/numpy-wasm-build"
NUMPY_SRC="$NUMPY_BUILD/numpy-2.4.2"
if [ ! -d "$NUMPY_SRC" ]; then
    echo "Error: numpy source not found at $NUMPY_SRC."
    echo "       Run scripts/build-numpy-wasm.sh first (pandas depends on numpy)."
    exit 1
fi

PANDAS_VERSION="2.2.3"
PANDAS_SRC="$BUILD_DIR/pandas-${PANDAS_VERSION}"

if [ ! -d "$PANDAS_SRC" ]; then
    echo "Downloading pandas ${PANDAS_VERSION}..."
    mkdir -p "$BUILD_DIR"
    pip3 download "pandas==${PANDAS_VERSION}" --no-binary=:all: --no-deps -d "$BUILD_DIR" 2>/dev/null
    cd "$BUILD_DIR"
    tar xzf "pandas-${PANDAS_VERSION}.tar.gz"
fi

echo "Building pandas ${PANDAS_VERSION} -> wasm32-wasi..."

# Step 1: Expand .pxi.in tempita templates
echo "  Expanding .pxi.in templates..."
cd "$PANDAS_SRC"
for f in pandas/_libs/*.pxi.in; do
    outdir=$(dirname "$f")
    python3 generate_pxi.py "$f" -o "$outdir" 2>/dev/null
done

# Step 1b: Patch pandas headers/sources for static linking.
#
#   (a) khash_python.h defines traced_malloc/calloc/realloc/free at file
#       scope. Each .pyx TU that includes it (algos, hashtable, index,
#       interval, join, parsers, ...) emits its own copy — fine for the
#       upstream meson build where each extension is its own .so, but
#       wasm-ld --allow-multiple-definition is unavailable here, so make
#       them `static` so they're TU-local.
KHASH_PY="$PANDAS_SRC/pandas/_libs/include/pandas/vendored/klib/khash_python.h"
if [ -f "$KHASH_PY" ] && ! grep -q "static void \*traced_malloc" "$KHASH_PY"; then
    sed -i.bak \
        -e 's/^void \*traced_malloc/static void *traced_malloc/' \
        -e 's/^void \*traced_calloc/static void *traced_calloc/' \
        -e 's/^void \*traced_realloc/static void *traced_realloc/' \
        -e 's/^void traced_free/static void traced_free/' \
        "$KHASH_PY"
fi

#   (b) pandas vendors numpy's np_datetime.c/.h verbatim. Its non-static
#       helpers (is_leapyear, get_datetimestruct_days,
#       add_minutes_to_datetimestruct, dayofweek, ...) collide with the
#       same symbols compiled into numpy's _multiarray_umath. Rewrite
#       them with a pandas_ prefix in both the vendored C/H and any
#       pandas TUs that reference them.
PD_NP_DT_C="$PANDAS_SRC/pandas/_libs/src/vendored/numpy/datetime/np_datetime.c"
PD_NP_DT_H="$PANDAS_SRC/pandas/_libs/include/pandas/vendored/numpy/datetime/np_datetime.h"
PD_NP_DT_STRINGS_C="$PANDAS_SRC/pandas/_libs/src/vendored/numpy/datetime/np_datetime_strings.c"
PD_DATETIME_C="$PANDAS_SRC/pandas/_libs/src/datetime/pd_datetime.c"
PD_DATE_CONV_C="$PANDAS_SRC/pandas/_libs/src/datetime/date_conversions.c"

# Symbols defined in pandas's vendored np_datetime.c that also exist in
# numpy/_core/src/multiarray/datetime.c. Each must be renamed in the
# definition site and at every call site.
COLLIDING_DT_SYMS="is_leapyear get_datetimestruct_days add_minutes_to_datetimestruct dayofweek add_seconds_to_datetimestruct"

# Apply renames idempotently: the marker file keeps us from re-patching
# on repeat builds (sed -i would otherwise rewrite already-rewritten
# symbols with double-prefix garbage).
PATCH_MARKER="$PANDAS_SRC/.pandas-wasm-patched"
if [ ! -f "$PATCH_MARKER" ]; then
    # Collect every C/H file that might reference these symbols. Perl's
    # \b is portable across macOS/Linux unlike sed's word-boundary.
    FILES_TO_PATCH=()
    for f in "$PD_NP_DT_C" "$PD_NP_DT_H" "$PD_NP_DT_STRINGS_C" \
             "$PD_DATETIME_C" "$PD_DATE_CONV_C"; do
        [ -f "$f" ] && FILES_TO_PATCH+=("$f")
    done
    # Also patch every Cython-generated .c that might call these symbols
    # (tslibs/* plus the main _libs/*.c that import np_datetime).
    for c in "$PANDAS_SRC"/pandas/_libs/*.c "$PANDAS_SRC"/pandas/_libs/tslibs/*.c; do
        [ -f "$c" ] && FILES_TO_PATCH+=("$c")
    done

    for sym in $COLLIDING_DT_SYMS; do
        new="pd_${sym}"
        for f in "${FILES_TO_PATCH[@]}"; do
            perl -i -pe "s/\b${sym}\b/${new}/g" "$f"
        done
    done
    touch "$PATCH_MARKER"
fi

# Step 2: Cythonize every .pyx
echo "  Cythonizing .pyx files (this takes a minute)..."
CYTHON_CMD=""
if command -v cython3 &>/dev/null; then
    CYTHON_CMD="cython3"
elif command -v cython &>/dev/null; then
    CYTHON_CMD="cython"
elif python3 -c "import Cython" 2>/dev/null; then
    CYTHON_CMD="python3 -m cython"
else
    echo "Error: cython not found. Install with: pip3 install cython"
    exit 1
fi

# numpy must be importable for Cython's `import numpy as cnp` directives.
NUMPY_PYTHON_DIR=$(python3 -c "import numpy, os; print(os.path.dirname(os.path.dirname(numpy.__file__)))" 2>/dev/null || true)
if [ -z "$NUMPY_PYTHON_DIR" ]; then
    echo "Error: numpy must be installed in host python3 for Cython header resolution."
    exit 1
fi

CYTHONIZED_OK=0
CYTHONIZED_FAIL=0
mkdir -p "$BUILD_DIR/cython-errors"

cythonize_pyx() {
    local pyx="$1"
    local cfile="${pyx%.pyx}.c"
    local errfile="$BUILD_DIR/cython-errors/$(basename "$pyx").err"
    if [ -f "$cfile" ]; then return 0; fi
    if $CYTHON_CMD \
        -I "$NUMPY_PYTHON_DIR" \
        -I "$PANDAS_SRC/pandas/_libs" \
        -I "$PANDAS_SRC/pandas/_libs/tslibs" \
        -X always_allow_keywords=true \
        "$pyx" -o "$cfile" 2>"$errfile"; then
        CYTHONIZED_OK=$((CYTHONIZED_OK + 1))
        rm -f "$errfile"
    else
        CYTHONIZED_FAIL=$((CYTHONIZED_FAIL + 1))
        echo "    CYTHON FAIL: $pyx"
        head -3 "$errfile"
    fi
}

for pyx in pandas/_libs/*.pyx; do
    cythonize_pyx "$pyx"
done
for pyx in pandas/_libs/tslibs/*.pyx; do
    cythonize_pyx "$pyx"
done
echo "  Cython: $CYTHONIZED_OK ok, $CYTHONIZED_FAIL failed"

# Step 3: Compile every .c to .o
echo "  Compiling C sources..."

# pandas uses python ssize_t clean and the standard numpy API; numpy's headers
# pull in npy_common.h which we patched for wasm32 in build-numpy-wasm.sh.
CFLAGS="-target wasm32-wasi -c -fPIC -Oz -DNDEBUG \
  -ffunction-sections -fdata-sections \
  -DNPY_NO_DEPRECATED_API=NPY_1_7_API_VERSION \
  -DPY_SSIZE_T_CLEAN \
  -DCYTHON_COMPRESS_STRINGS=0 \
  -Drestrict=__restrict__ \
  -I$CPYTHON/Include -I$CPYTHON/Include/cpython -I$PYCONFIG_DIR \
  -I$NUMPY_SRC/numpy/_core/include \
  -I$NUMPY_BUILD/gen \
  -I$PANDAS_SRC/pandas/_libs \
  -I$PANDAS_SRC/pandas/_libs/tslibs \
  -I$PANDAS_SRC/pandas/_libs/include \
  -Wno-macro-redefined -Wno-implicit-function-declaration \
  -Wno-incompatible-pointer-types -Wno-int-conversion -Wno-unused-function"

SUCCESS=0
FAIL=0
FAILED_FILES=""
mkdir -p "$BUILD_DIR/obj"

compile_c() {
    local src="$1" out="$2"
    local errfile="$BUILD_DIR/obj/${out}.err"
    if zig cc $CFLAGS -o "$BUILD_DIR/obj/$out" "$src" 2>"$errfile"; then
        SUCCESS=$((SUCCESS + 1))
        rm -f "$errfile"
    else
        FAIL=$((FAIL + 1))
        FAILED_FILES="$FAILED_FILES $out"
        echo "    FAIL: $out"
        grep -E "error:|fatal:" "$errfile" | head -3 || true
    fi
}

# Each .pyx becomes a stand-alone extension module .o
for pyx in pandas/_libs/*.pyx; do
    cfile="${pyx%.pyx}.c"
    [ -f "$cfile" ] || continue
    name=$(basename "${pyx%.pyx}")
    compile_c "$PANDAS_SRC/$cfile" "pd_${name}.o"
done

for pyx in pandas/_libs/tslibs/*.pyx; do
    cfile="${pyx%.pyx}.c"
    [ -f "$cfile" ] || continue
    name=$(basename "${pyx%.pyx}")
    compile_c "$PANDAS_SRC/$cfile" "tslibs_${name}.o"
done

# C-only sources: parser + datetime helpers + vendored np_datetime
for src in src/parser/tokenizer.c src/parser/io.c src/parser/pd_parser.c \
           src/datetime/date_conversions.c src/datetime/pd_datetime.c \
           src/vendored/numpy/datetime/np_datetime.c \
           src/vendored/numpy/datetime/np_datetime_strings.c; do
    f="$PANDAS_SRC/pandas/_libs/$src"
    [ -f "$f" ] || continue
    outname=$(basename "$src" .c)
    compile_c "$f" "csrc_${outname}.o"
done

# Vendored ujson C sources for pandas.io.json (the `json` extension)
for src in src/vendored/ujson/python/ujson.c \
           src/vendored/ujson/python/objToJSON.c \
           src/vendored/ujson/python/JSONtoObj.c \
           src/vendored/ujson/lib/ultrajsonenc.c \
           src/vendored/ujson/lib/ultrajsondec.c; do
    f="$PANDAS_SRC/pandas/_libs/$src"
    [ -f "$f" ] || continue
    outname=$(basename "$src" .c)
    compile_c "$f" "ujson_${outname}.o"
done

echo "  Compiled: $SUCCESS ok, $FAIL failed"
if [ $FAIL -gt 0 ]; then
    echo "  Failed:$FAILED_FILES"
fi

# Step 4: Bundle pandas + pytz + dateutil Python sources
echo "  Bundling Python files..."
mkdir -p "$RECIPE_DIR"

# Locate pytz and dateutil from host python
PYTZ_DIR=$(python3 -c "import pytz, os; print(os.path.dirname(pytz.__file__))" 2>/dev/null || true)
DATEUTIL_DIR=$(python3 -c "import dateutil, os; print(os.path.dirname(dateutil.__file__))" 2>/dev/null || true)
if [ -z "$PYTZ_DIR" ] || [ -z "$DATEUTIL_DIR" ]; then
    echo "Error: pytz / python-dateutil must be installed (pip3 install pytz python-dateutil)"
    exit 1
fi

ZIP_PATH="$BUILD_DIR/pandas-site-packages.zip"
rm -f "$ZIP_PATH"

cd "$PANDAS_SRC"
python3 - "$ZIP_PATH" "$PYTZ_DIR" "$DATEUTIL_DIR" <<'PYEOF'
import os, sys, zipfile
zip_path, pytz_dir, dateutil_dir = sys.argv[1], sys.argv[2], sys.argv[3]
SKIP_DIRS = {"tests", "testing", "test", "__pycache__", "_pyinstaller"}
# Optional pandas subtrees that depend on heavy unavailable libraries
# (SQLAlchemy, openpyxl, pyarrow, matplotlib, etc.) or aren't typically
# used in a CF Worker. Dropping them saves ~1.8 MB compressed and gets
# the bundle under CF's 10 MiB limit. CSV/JSON I/O and core DataFrame
# ops still work.
SKIP_PANDAS_SUBDIRS = {
    "pandas/io/excel",        # openpyxl/xlrd
    "pandas/io/sql",          # SQLAlchemy
    "pandas/io/parquet",      # pyarrow
    "pandas/io/feather_format",
    "pandas/io/orc",          # pyarrow
    "pandas/io/stata",
    "pandas/io/sas",          # binary SAS
    "pandas/io/spss",
    "pandas/io/html",         # bs4/lxml
    "pandas/io/clipboard",
    "pandas/io/gbq",          # google bigquery
    "pandas/io/formats/excel",
    "pandas/io/formats/html",
    "pandas/io/formats/latex",
    "pandas/io/formats/info",
    "pandas/io/formats/style",
    "pandas/io/formats/style_render",
    "pandas/plotting",        # matplotlib
    "pandas/tseries/holiday", # rarely used
}
EPOCH = (1980, 1, 1, 0, 0, 0)

def should_skip(rel_path):
    parts = rel_path.split("/")
    for i in range(2, len(parts) + 1):
        if "/".join(parts[:i]).rstrip(".py") in SKIP_PANDAS_SUBDIRS:
            return True
        # Also skip stand-alone .py files matching the skip list
        if "/".join(parts[:i])[:-3] in SKIP_PANDAS_SUBDIRS and parts[i-1].endswith(".py"):
            return True
    return False

def add_dir(zf, root):
    base = os.path.dirname(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for f in filenames:
            if not (f.endswith(".py") or f.endswith(".csv") or f.endswith(".zi")):
                continue
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, base)
            if rel.startswith("pandas/") and should_skip(rel):
                continue
            with open(full, "rb") as fp:
                data = fp.read()
            zi = zipfile.ZipInfo(rel, date_time=EPOCH)
            zi.compress_type = zipfile.ZIP_STORED
            zf.writestr(zi, data)

with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
    add_dir(zf, "pandas")
    add_dir(zf, pytz_dir)
    add_dir(zf, dateutil_dir)

count = len(zipfile.ZipFile(zip_path).namelist())
size_kb = os.path.getsize(zip_path) // 1024
print(f"  {count} files, {size_kb} KB")
PYEOF

# Step 5: Copy site-packages zip + objects
mkdir -p "$RECIPE_DIR"
cp "$ZIP_PATH" "$RECIPE_DIR/pandas-site-packages.zip"

mkdir -p "$VARIANT_OBJ_DIR"
# wipe any stale objects so a rebuild doesn't link old ones
rm -f "$VARIANT_OBJ_DIR"/*.o
cp "$BUILD_DIR"/obj/*.o "$VARIANT_OBJ_DIR/" 2>/dev/null || true
OBJ_COUNT=$(ls "$VARIANT_OBJ_DIR"/*.o 2>/dev/null | wc -l | tr -d ' ')
echo "  $OBJ_COUNT objects in $VARIANT_OBJ_DIR/"

mkdir -p "$OUTPUT_DIR"
cp "$ZIP_PATH" "$OUTPUT_DIR/pandas-site-packages.zip"

echo ""
echo "Done. pandas wasm32-wasi build:"
echo "  Objects: $VARIANT_OBJ_DIR/ ($OBJ_COUNT files)"
echo "  Python:  $RECIPE_DIR/pandas-site-packages.zip"
echo ""
echo "To build variant: npx tsx scripts/build-variant.ts pandas"
