#!/usr/bin/env bash
# Build a python.wasm variant by linking base CPython + recipe objects.
#
# Usage:
#   ./scripts/build-variant.sh <recipe-name> [<recipe-name>...]
#
# Example:
#   ./scripts/build-variant.sh numpy                    # python-numpy.wasm
#   ./scripts/build-variant.sh markupsafe frozenlist     # python-markupsafe-frozenlist.wasm
#
# Produces: worker/src/python-<variant>.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
CPYTHON="$ROOT_DIR/cpython"
BUILD_DIR="$ROOT_DIR/build/zig-wasi"
RECIPES_DIR="$ROOT_DIR/recipes"
ZIG_CC="$ROOT_DIR/build/zig-wrappers/zig-cc"

if [ $# -eq 0 ]; then
    echo "Usage: build-variant.sh <recipe-name> [<recipe-name>...]"
    echo ""
    echo "Available recipes:"
    for r in "$RECIPES_DIR"/*.json; do
        name=$(basename "$r" .json)
        version=$(python3 -c "import json; print(json.load(open('$r'))['version'])")
        echo "  $name ($version)"
    done
    exit 0
fi

# Check prerequisites
[ -f "$BUILD_DIR/python.wasm" ] || { echo "Error: python.wasm not found. Run build-phase2.sh first."; exit 1; }
[ -x "$ZIG_CC" ] || { echo "Error: zig-cc wrapper not found. Run build-phase2.sh first."; exit 1; }

RECIPE_NAMES=("$@")
VARIANT_NAME=$(IFS=-; echo "${RECIPE_NAMES[*]}")
OUTPUT="$ROOT_DIR/worker/src/python-${VARIANT_NAME}.wasm"

echo "Building variant: python-${VARIANT_NAME}.wasm"
echo "  Recipes: ${RECIPE_NAMES[*]}"
echo ""

# Step 1: Build each recipe (compile objects)
ALL_OBJS=()
ALL_MODULES=""
EXTRA_LINK_FLAGS=()
SITE_PACKAGES=()

for recipe_name in "${RECIPE_NAMES[@]}"; do
    RECIPE="$RECIPES_DIR/${recipe_name}.json"
    [ -f "$RECIPE" ] || { echo "Recipe not found: $recipe_name"; exit 1; }

    TYPE=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['type'])")

    # Custom recipes (numpy) handle their own build
    if [ "$TYPE" = "custom" ]; then
        echo "  [$recipe_name] Custom build — checking for pre-built objects..."
        OBJ_DIR="$BUILD_DIR/Modules/$recipe_name"
        if [ -d "$OBJ_DIR" ] && [ "$(ls "$OBJ_DIR"/*.o 2>/dev/null | wc -l)" -gt 0 ]; then
            for obj in "$OBJ_DIR"/*.o; do
                ALL_OBJS+=("$obj")
            done
            echo "    Found $(ls "$OBJ_DIR"/*.o | wc -l | tr -d ' ') objects"
        else
            echo "    No pre-built objects. Run build-recipe.sh $recipe_name first."
            exit 1
        fi
    elif [ "$TYPE" = "rust" ]; then
        # Rust recipe — produces .a archive
        OBJ_DIR="$ROOT_DIR/build/recipes/$recipe_name/obj"
        if [ ! -d "$OBJ_DIR" ]; then
            echo "  [$recipe_name] Building Rust extension..."
            BUILD_SCRIPT=$(python3 -c "import json; r=json.load(open('$RECIPE')); print(r['build_script'])")
            bash "$ROOT_DIR/$BUILD_SCRIPT"
        fi
        # .a archives link directly (wasm-ld handles them)
        for archive in "$OBJ_DIR"/*.a; do
            ALL_OBJS+=("$archive")
        done
        for obj in "$OBJ_DIR"/*.o; do
            [ -f "$obj" ] && ALL_OBJS+=("$obj")
        done
        echo "  [$recipe_name] Rust archive: $(ls -lh "$OBJ_DIR"/*.a 2>/dev/null | awk '{print $5}')"
    else
        # Standard recipe — build objects
        OBJ_DIR="$ROOT_DIR/build/recipes/$recipe_name/obj"
        if [ ! -d "$OBJ_DIR" ] || [ "$(ls "$OBJ_DIR"/*.o 2>/dev/null | wc -l)" -eq 0 ]; then
            echo "  [$recipe_name] Compiling..."
            bash "$SCRIPT_DIR/build-recipe.sh" "$recipe_name" --objects-only
        fi

        for obj in "$OBJ_DIR"/*.o; do
            ALL_OBJS+=("$obj")
        done
        echo "  [$recipe_name] $(ls "$OBJ_DIR"/*.o | wc -l | tr -d ' ') objects"
    fi

    # Collect module registrations
    MODULES=$(python3 -c "
import json
r = json.load(open('$RECIPE'))
for mod_path, init_func in r.get('modules', {}).items():
    print(f'{mod_path}:{init_func}')
")
    ALL_MODULES="$ALL_MODULES $MODULES"

    # Collect extra link flags
    FLAGS=$(python3 -c "import json; r=json.load(open('$RECIPE')); [print(f) for f in r.get('extra_link_flags', [])]" 2>/dev/null)
    for flag in $FLAGS; do
        EXTRA_LINK_FLAGS+=("$flag")
    done

    # Collect site-packages zips
    SITE_ZIP="$ROOT_DIR/build/recipes/$recipe_name/${recipe_name}-site-packages.zip"
    if [ -f "$SITE_ZIP" ]; then
        SITE_PACKAGES+=("$SITE_ZIP")
    fi
done

# Step 2: Generate config.c with module registrations
echo ""
echo "  Generating config.c..."

CONFIG_C="$BUILD_DIR/Modules/config_variant.c"
# Use clean base config.c (without any variant entries)
if [ -f "$BUILD_DIR/Modules/config.c.base" ]; then
    cp "$BUILD_DIR/Modules/config.c.base" "$CONFIG_C"
else
    cp "$BUILD_DIR/Modules/config.c" "$CONFIG_C"
fi

# Remove existing variant entries (between ADDMODULE markers)
# Add extern declarations before MARKER 1
EXTERN_DECLS=""
INITTAB_ENTRIES=""
for entry in $ALL_MODULES; do
    mod_path="${entry%%:*}"
    init_func="${entry##*:}"
    EXTERN_DECLS="${EXTERN_DECLS}extern PyObject* ${init_func}(void);\n"
    INITTAB_ENTRIES="${INITTAB_ENTRIES}    {\"${mod_path}\", ${init_func}},\n"
done

# Also add _pymode if not already there
if ! grep -q "PyInit__pymode" "$CONFIG_C"; then
    EXTERN_DECLS="extern PyObject* PyInit__pymode(void);\n${EXTERN_DECLS}"
    INITTAB_ENTRIES="    {\"_pymode\", PyInit__pymode},\n${INITTAB_ENTRIES}"
fi

# Insert before markers
if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "s|/\* -- ADDMODULE MARKER 1 -- \*/|${EXTERN_DECLS}/\* -- ADDMODULE MARKER 1 -- \*/|" "$CONFIG_C"
    sed -i '' "s|/\* -- ADDMODULE MARKER 2 -- \*/|${INITTAB_ENTRIES}/\* -- ADDMODULE MARKER 2 -- \*/|" "$CONFIG_C"
else
    sed -i "s|/\* -- ADDMODULE MARKER 1 -- \*/|${EXTERN_DECLS}/\* -- ADDMODULE MARKER 1 -- \*/|" "$CONFIG_C"
    sed -i "s|/\* -- ADDMODULE MARKER 2 -- \*/|${INITTAB_ENTRIES}/\* -- ADDMODULE MARKER 2 -- \*/|" "$CONFIG_C"
fi

# Compile config_variant.c
echo "  Compiling config_variant.c..."
bash "$ZIG_CC" -c -Os -DPy_BUILD_CORE \
    -I"$CPYTHON/Include" -I"$CPYTHON/Include/internal" -I"$BUILD_DIR" \
    -o "$BUILD_DIR/Modules/config_variant.o" "$CONFIG_C"

# Step 3: Collect all base .o files (excluding config.o and dynload_shlib.o)
echo "  Collecting link objects..."
LINK_OBJS=()
while IFS= read -r obj; do
    base=$(basename "$obj")
    # Skip files we're replacing
    [[ "$base" == "config.o" ]] && continue
    [[ "$base" == "config_wizer.o" ]] && continue
    [[ "$base" == "dynload_shlib.o" ]] && continue
    [[ "$base" == "pymode_wizer.o" ]] && continue
    LINK_OBJS+=("$obj")
done < <(find "$BUILD_DIR" -name "*.o" -not -path "*/recipes/*" -not -path "*/Modules/numpy/*" -not -path "*/Modules/pillow/*" -not -path "*/Modules/scipy/*" -not -path "*/Modules/sklearn/*" -not -name "config_variant.o")

# Add our variant config
LINK_OBJS+=("$BUILD_DIR/Modules/config_variant.o")

# Add recipe objects
LINK_OBJS+=("${ALL_OBJS[@]}")

TOTAL_OBJS=${#LINK_OBJS[@]}
echo "  Total objects: $TOTAL_OBJS"

# Step 4: Link
echo "  Linking python-${VARIANT_NAME}.wasm..."
LINK_CMD=(bash "$ZIG_CC" -s)
LINK_CMD+=(-o "$OUTPUT")
LINK_CMD+=("${LINK_OBJS[@]}")
LINK_CMD+=(-ldl -lwasi-emulated-signal -lwasi-emulated-getpid -lwasi-emulated-process-clocks -lm)
LINK_CMD+=("${EXTRA_LINK_FLAGS[@]}")

if ! "${LINK_CMD[@]}" 2>&1; then
    echo ""
    echo "  ERROR: Link failed!"
    exit 1
fi

PRE_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
echo "  Raw size: $(echo "scale=1; $PRE_SIZE / 1048576" | bc)MB"

# Step 5: Asyncify with wasm-opt
if command -v wasm-opt &>/dev/null; then
    echo "  Running wasm-opt --asyncify..."
    ASYNC_IMPORTS="pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec,pymode.thread_spawn,pymode.thread_join,pymode.dl_open"
    wasm-opt -O2 --asyncify \
        --enable-simd \
        --enable-nontrapping-float-to-int \
        --enable-bulk-memory \
        --enable-sign-ext \
        --enable-mutable-globals \
        --pass-arg="asyncify-imports@${ASYNC_IMPORTS}" \
        --pass-arg=asyncify-ignore-indirect \
        "$OUTPUT" -o "${OUTPUT}.opt"
    mv "${OUTPUT}.opt" "$OUTPUT"
    POST_SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
    echo "  Asyncified: $(echo "scale=1; $POST_SIZE / 1048576" | bc)MB"
else
    echo "  WARNING: wasm-opt not found, skipping asyncify"
fi

# Step 6: Merge site-packages
if [ ${#SITE_PACKAGES[@]} -gt 0 ]; then
    echo "  Merging site-packages..."
    MERGED_ZIP="$ROOT_DIR/worker/src/extension-site-packages.zip"
    python3 -c "
import zipfile, os, sys
merged = zipfile.ZipFile('$MERGED_ZIP', 'w', zipfile.ZIP_STORED)
seen = set()
for zip_path in sys.argv[1:]:
    if not os.path.exists(zip_path):
        continue
    with zipfile.ZipFile(zip_path) as zf:
        for name in zf.namelist():
            if name not in seen:
                seen.add(name)
                merged.writestr(name, zf.read(name))
merged.close()
print(f'  {len(seen)} files in extension-site-packages.zip')
" "${SITE_PACKAGES[@]}"
fi

echo ""
echo "Done! python-${VARIANT_NAME}.wasm -> worker/src/"
echo "  Size: $(wc -c < "$OUTPUT" | tr -d ' ' | awk '{printf "%.1fMB", $1/1048576}')"
