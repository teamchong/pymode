#!/usr/bin/env bash
# Build system libraries as wasm32-wasi static archives using zig cc.
#
# Creates a sysroot at build/sysroot/wasm32-wasi/ with:
#   lib/   - static archives (.a)
#   include/ - header files
#
# Usage:
#   ./scripts/build-sysroot.sh          # build all libraries
#   ./scripts/build-sysroot.sh zlib     # build just zlib
#   ./scripts/build-sysroot.sh openssl  # build just OpenSSL
#
# Libraries are built in dependency order:
#   1. zlib (no deps)
#   2. libffi (no deps)
#   3. openssl (no deps)
#   4. sqlite3 (no deps)
#   5. libyaml (no deps)
#   6. libjpeg-turbo (no deps)
#   7. libpng (depends on zlib)
#   8. freetype (depends on zlib, libpng)
#   9. libxml2 (depends on zlib)
#  10. openblas (no deps, complex build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build/sysroot-build"
SYSROOT="$ROOT_DIR/build/sysroot/wasm32-wasi"
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Zig cc wrappers
ZIG_CC="zig cc -target wasm32-wasi -Os -fPIC -DNDEBUG"
ZIG_AR="zig ar"
ZIG_RANLIB="zig ranlib"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

mkdir -p "$BUILD_DIR" "$SYSROOT/lib" "$SYSROOT/include"

# Download helper
download() {
    local url="$1" dest="$2"
    if [ -f "$dest" ]; then
        info "  Already downloaded: $(basename "$dest")"
        return
    fi
    info "  Downloading $(basename "$dest")..."
    curl -sL "$url" -o "$dest"
}

# Check if library is already built
is_built() {
    local lib="$1"
    [ -f "$SYSROOT/lib/$lib" ]
}

##############################################################################
# 1. zlib
##############################################################################
build_zlib() {
    if is_built "libz.a"; then
        info "zlib: already built"
        return
    fi
    info "Building zlib..."
    local src="$BUILD_DIR/zlib"
    download "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz" \
             "$BUILD_DIR/zlib-1.3.1.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/zlib-1.3.1.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    CC="$ZIG_CC" AR="$ZIG_AR" RANLIB="$ZIG_RANLIB" \
        ./configure --static --prefix="$SYSROOT"
    make -j"$NCPU" libz.a
    make install
    info "zlib: done ($(du -h "$SYSROOT/lib/libz.a" | cut -f1))"
}

##############################################################################
# 2. libffi
##############################################################################
build_libffi() {
    if is_built "libffi.a"; then
        info "libffi: already built"
        return
    fi
    info "Building libffi..."
    local src="$BUILD_DIR/libffi"
    download "https://github.com/libffi/libffi/releases/download/v3.4.6/libffi-3.4.6.tar.gz" \
             "$BUILD_DIR/libffi-3.4.6.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/libffi-3.4.6.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    CC="zig cc" \
    CFLAGS="-target wasm32-wasi -Os -fPIC -DNDEBUG" \
    ./configure \
        --host=wasm32-wasi \
        --prefix="$SYSROOT" \
        --disable-shared \
        --enable-static \
        --disable-docs
    make -j"$NCPU"
    make install
    info "libffi: done ($(du -h "$SYSROOT/lib/libffi.a" | cut -f1))"
}

##############################################################################
# 3. OpenSSL
##############################################################################
build_openssl() {
    if is_built "libssl.a" && is_built "libcrypto.a"; then
        info "openssl: already built"
        return
    fi
    info "Building OpenSSL..."
    local src="$BUILD_DIR/openssl"
    download "https://github.com/openssl/openssl/releases/download/openssl-3.4.0/openssl-3.4.0.tar.gz" \
             "$BUILD_DIR/openssl-3.4.0.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/openssl-3.4.0.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    # linux-generic32 is the closest match — 32-bit, no asm
    CC="zig cc -target wasm32-wasi" \
    AR="$ZIG_AR" \
    RANLIB="$ZIG_RANLIB" \
    ./Configure linux-generic32 \
        --prefix="$SYSROOT" \
        --cross-compile-prefix="" \
        no-asm \
        no-threads \
        no-shared \
        no-sock \
        no-afalgeng \
        no-ui-console \
        no-tests \
        no-engine \
        no-dso \
        no-posix-io \
        -Os \
        -DOPENSSL_NO_SECURE_MEMORY \
        -DOPENSSL_SYS_WASI \
        -DNO_SYSLOG \
        -DOPENSSL_NO_DGRAM \
        -DOPENSSL_NO_SOCK
    make -j"$NCPU" build_libs
    make install_dev
    info "openssl: done (libssl: $(du -h "$SYSROOT/lib/libssl.a" | cut -f1), libcrypto: $(du -h "$SYSROOT/lib/libcrypto.a" | cut -f1))"
}

##############################################################################
# 4. sqlite3
##############################################################################
build_sqlite3() {
    if is_built "libsqlite3.a"; then
        info "sqlite3: already built"
        return
    fi
    info "Building sqlite3..."
    local src="$BUILD_DIR/sqlite3"
    # Use the amalgamation — single .c file, no configure needed
    download "https://www.sqlite.org/2024/sqlite-amalgamation-3470200.zip" \
             "$BUILD_DIR/sqlite3-amalgamation.zip"
    rm -rf "$src"
    mkdir -p "$src"
    cd "$BUILD_DIR" && unzip -qo sqlite3-amalgamation.zip -d "$src"

    cd "$src"/sqlite-amalgamation-*
    $ZIG_CC -c -DSQLITE_OS_OTHER=1 \
        -DSQLITE_OMIT_WAL=1 \
        -DSQLITE_OMIT_LOAD_EXTENSION=1 \
        -DSQLITE_THREADSAFE=0 \
        sqlite3.c -o sqlite3.o
    $ZIG_AR rcs "$SYSROOT/lib/libsqlite3.a" sqlite3.o
    cp sqlite3.h sqlite3ext.h "$SYSROOT/include/"
    info "sqlite3: done ($(du -h "$SYSROOT/lib/libsqlite3.a" | cut -f1))"
}

##############################################################################
# 5. libyaml
##############################################################################
build_libyaml() {
    if is_built "libyaml.a"; then
        info "libyaml: already built"
        return
    fi
    info "Building libyaml..."
    local src="$BUILD_DIR/libyaml"
    download "https://github.com/yaml/libyaml/releases/download/0.2.5/yaml-0.2.5.tar.gz" \
             "$BUILD_DIR/yaml-0.2.5.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/yaml-0.2.5.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    CC="zig cc" \
    CFLAGS="-target wasm32-wasi -Os -fPIC -DNDEBUG" \
    ./configure \
        --host=wasm32-wasi \
        --prefix="$SYSROOT" \
        --disable-shared \
        --enable-static
    make -j"$NCPU"
    make install
    info "libyaml: done ($(du -h "$SYSROOT/lib/libyaml.a" | cut -f1))"
}

##############################################################################
# 6. libjpeg-turbo
##############################################################################
build_libjpeg() {
    if is_built "libjpeg.a"; then
        info "libjpeg: already built"
        return
    fi
    info "Building libjpeg-turbo..."
    local src="$BUILD_DIR/libjpeg-turbo"
    download "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.0/libjpeg-turbo-3.1.0.tar.gz" \
             "$BUILD_DIR/libjpeg-turbo-3.1.0.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/libjpeg-turbo-3.1.0.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    mkdir -p build && cd build
    # Create a wrapper script for cmake to use zig cc
    cat > "$BUILD_DIR/zig-cc-wasi" << 'ZIGCC'
#!/usr/bin/env bash
exec zig cc -target wasm32-wasi "$@"
ZIGCC
    chmod +x "$BUILD_DIR/zig-cc-wasi"

    cmake .. \
        -DCMAKE_SYSTEM_NAME=Generic \
        -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
        -DCMAKE_C_COMPILER="$BUILD_DIR/zig-cc-wasi" \
        -DCMAKE_AR="$(which zig)" \
        -DCMAKE_AR_FLAGS="ar rcs" \
        -DCMAKE_RANLIB="$ZIG_RANLIB" \
        -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
        -DCMAKE_C_FLAGS="-Os -DNDEBUG" \
        -DWITH_SIMD=OFF \
        -DWITH_TURBOJPEG=OFF \
        -DENABLE_SHARED=OFF \
        -DENABLE_STATIC=ON
    make -j"$NCPU"
    make install
    info "libjpeg: done ($(du -h "$SYSROOT/lib/libjpeg.a" | cut -f1))"
}

##############################################################################
# 7. libpng (depends on zlib)
##############################################################################
build_libpng() {
    if is_built "libpng.a" || is_built "libpng16.a"; then
        info "libpng: already built"
        return
    fi
    is_built "libz.a" || build_zlib

    info "Building libpng..."
    local src="$BUILD_DIR/libpng"
    download "https://download.sourceforge.net/libpng/libpng-1.6.44.tar.gz" \
             "$BUILD_DIR/libpng-1.6.44.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/libpng-1.6.44.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    CC="zig cc" \
    CFLAGS="-target wasm32-wasi -Os -fPIC -DNDEBUG -I$SYSROOT/include" \
    LDFLAGS="-L$SYSROOT/lib" \
    CPPFLAGS="-I$SYSROOT/include" \
    ./configure \
        --host=wasm32-wasi \
        --prefix="$SYSROOT" \
        --disable-shared \
        --enable-static \
        --with-zlib-prefix="$SYSROOT"
    make -j"$NCPU"
    make install
    info "libpng: done ($(du -h "$SYSROOT/lib/libpng"*.a | tail -1 | cut -f1))"
}

##############################################################################
# 8. freetype (depends on zlib, libpng)
##############################################################################
build_freetype() {
    if is_built "libfreetype.a"; then
        info "freetype: already built"
        return
    fi
    is_built "libz.a" || build_zlib
    is_built "libpng16.a" || is_built "libpng.a" || build_libpng

    info "Building freetype..."
    local src="$BUILD_DIR/freetype"
    download "https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.gz" \
             "$BUILD_DIR/freetype-2.13.3.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/freetype-2.13.3.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    CC="zig cc" \
    CFLAGS="-target wasm32-wasi -Os -fPIC -DNDEBUG -I$SYSROOT/include" \
    LDFLAGS="-L$SYSROOT/lib" \
    PKG_CONFIG_PATH="$SYSROOT/lib/pkgconfig" \
    ./configure \
        --host=wasm32-wasi \
        --prefix="$SYSROOT" \
        --disable-shared \
        --enable-static \
        --with-zlib=yes \
        --with-png=yes \
        --without-harfbuzz \
        --without-bzip2 \
        --without-brotli
    make -j"$NCPU"
    make install
    info "freetype: done ($(du -h "$SYSROOT/lib/libfreetype.a" | cut -f1))"
}

##############################################################################
# 9. libxml2 (depends on zlib)
##############################################################################
build_libxml2() {
    if is_built "libxml2.a"; then
        info "libxml2: already built"
        return
    fi
    is_built "libz.a" || build_zlib

    info "Building libxml2..."
    local src="$BUILD_DIR/libxml2"
    download "https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.5.tar.xz" \
             "$BUILD_DIR/libxml2-2.13.5.tar.xz"
    rm -rf "$src"
    mkdir -p "$src" && tar xJf "$BUILD_DIR/libxml2-2.13.5.tar.xz" -C "$src" --strip-components=1

    cd "$src"
    CC="zig cc" \
    CFLAGS="-target wasm32-wasi -Os -fPIC -DNDEBUG -I$SYSROOT/include" \
    LDFLAGS="-L$SYSROOT/lib" \
    ./configure \
        --host=wasm32-wasi \
        --prefix="$SYSROOT" \
        --disable-shared \
        --enable-static \
        --with-zlib="$SYSROOT" \
        --without-python \
        --without-threads \
        --without-lzma \
        --without-iconv \
        --without-http \
        --without-ftp
    make -j"$NCPU"
    make install
    info "libxml2: done ($(du -h "$SYSROOT/lib/libxml2.a" | cut -f1))"
}

##############################################################################
# 10. OpenBLAS
##############################################################################
build_openblas() {
    if is_built "libopenblas.a"; then
        info "openblas: already built"
        return
    fi
    info "Building OpenBLAS (this may take a while)..."
    local src="$BUILD_DIR/openblas"
    download "https://github.com/OpenMathLib/OpenBLAS/releases/download/v0.3.28/OpenBLAS-0.3.28.tar.gz" \
             "$BUILD_DIR/OpenBLAS-0.3.28.tar.gz"
    rm -rf "$src"
    mkdir -p "$src" && tar xzf "$BUILD_DIR/OpenBLAS-0.3.28.tar.gz" -C "$src" --strip-components=1

    cd "$src"
    # RISCV64_GENERIC target has no asm — pure C BLAS/LAPACK
    # C_LAPACK=1 uses reference LAPACK in C (no Fortran)
    make \
        CC="zig cc -target wasm32-wasi" \
        AR="$ZIG_AR" \
        RANLIB="$ZIG_RANLIB" \
        HOSTCC=cc \
        TARGET=RISCV64_GENERIC \
        NOFORTRAN=1 \
        USE_THREAD=0 \
        NO_SHARED=1 \
        C_LAPACK=1 \
        NO_LAPACKE=1 \
        CFLAGS="-Os -DNDEBUG" \
        PREFIX="$SYSROOT" \
        -j"$NCPU" libs
    make \
        PREFIX="$SYSROOT" \
        NO_SHARED=1 \
        install
    info "openblas: done ($(du -h "$SYSROOT/lib/libopenblas.a" | cut -f1))"
}

##############################################################################
# Main
##############################################################################
LIBS_ALL="zlib libffi openssl sqlite3 libyaml libjpeg libpng freetype libxml2 openblas"

if [ $# -eq 0 ]; then
    LIBS="$LIBS_ALL"
else
    LIBS="$*"
fi

for lib in $LIBS; do
    case "$lib" in
        zlib)       build_zlib ;;
        libffi)     build_libffi ;;
        openssl)    build_openssl ;;
        sqlite3)    build_sqlite3 ;;
        libyaml)    build_libyaml ;;
        libjpeg)    build_libjpeg ;;
        libpng)     build_libpng ;;
        freetype)   build_freetype ;;
        libxml2)    build_libxml2 ;;
        openblas)   build_openblas ;;
        all)
            for l in $LIBS_ALL; do
                "$0" "$l"
            done
            ;;
        *)
            error "Unknown library: $lib"
            echo "Available: $LIBS_ALL"
            exit 1
            ;;
    esac
done

info ""
info "Sysroot ready at: $SYSROOT"
info "  Include: $SYSROOT/include"
info "  Lib:     $SYSROOT/lib"
ls -la "$SYSROOT/lib/"*.a 2>/dev/null || true
