#!/bin/bash
# Build a minimal Python stdlib zip for WASI/CF Workers deployment.
# Strips tests, docs, tkinter, and other modules unavailable on WASI.
# Output: build/stdlib-minimal.zip (~4.3MB)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/build"
CPYTHON_DIR="$BUILD_DIR/cpython"
STDLIB_SRC="$CPYTHON_DIR/Lib"
WORK_DIR="$BUILD_DIR/stdlib-work"
OUTPUT="$BUILD_DIR/stdlib-minimal.zip"

if [ ! -d "$STDLIB_SRC" ]; then
    echo "Error: CPython stdlib not found at $STDLIB_SRC"
    echo "Run build-phase2.sh first to clone CPython."
    exit 1
fi

echo "Building minimal stdlib from $STDLIB_SRC..."

# Clean previous work
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

# Copy stdlib
cp -r "$STDLIB_SRC"/* "$WORK_DIR/"

# Remove large/unnecessary directories
REMOVE_DIRS=(
    # Test suites
    "test" "tests" "unittest/test"
    # GUI (no display on WASI)
    "tkinter" "turtle" "turtledemo" "idlelib"
    # Email/web (heavy, rarely needed on edge)
    "email" "html" "http" "xmlrpc" "urllib"
    # Multiprocessing/threading (no fork/threads on WASI)
    "multiprocessing" "concurrent"
    # Other large modules not useful on WASI
    "distutils" "ensurepip" "lib2to3" "pydoc_data"
    "sqlite3" "ctypes" "curses" "dbm"
    "xml/sax" "xml/dom" "xml/parsers"
    # Docs and configs
    "__phello__"
)

for dir in "${REMOVE_DIRS[@]}"; do
    if [ -d "$WORK_DIR/$dir" ]; then
        rm -rf "$WORK_DIR/$dir"
        echo "  Removed $dir/"
    fi
done

# Remove individual files not needed on WASI
REMOVE_FILES=(
    "antigravity.py" "this.py" "webbrowser.py"
    "smtpd.py" "smtplib.py" "imaplib.py" "poplib.py"
    "nntplib.py" "ftplib.py" "telnetlib.py"
    "cgi.py" "cgitb.py"
    "aifc.py" "sunau.py" "wave.py" "audioop.py" "sndhdr.py"
    "pty.py" "tty.py" "termios.py"
    "crypt.py" "nis.py" "ossaudiodev.py" "spwd.py"
    "mailbox.py" "mailcap.py" "mimetypes.py"
    "pdb.py" "profile.py" "pstats.py" "cProfile.py"
    "doctest.py" "pydoc.py"
)

for f in "${REMOVE_FILES[@]}"; do
    if [ -f "$WORK_DIR/$f" ]; then
        rm "$WORK_DIR/$f"
        echo "  Removed $f"
    fi
done

# Trim encodings to essential ones only
if [ -d "$WORK_DIR/encodings" ]; then
    KEEP_ENCODINGS="__init__.py aliases.py utf_8.py utf_8_sig.py ascii.py latin_1.py raw_unicode_escape.py unicode_escape.py utf_16.py utf_16_be.py utf_16_le.py utf_32.py utf_32_be.py utf_32_le.py cp437.py idna.py"
    for f in "$WORK_DIR/encodings"/*.py; do
        base=$(basename "$f")
        if ! echo "$KEEP_ENCODINGS" | grep -qw "$base"; then
            rm "$f"
        fi
    done
    echo "  Trimmed encodings/ to essential codecs"
fi

# Compile .py to .pyc and remove .py source (saves ~40% space)
echo "Compiling to .pyc..."
python3 -m compileall -q -b "$WORK_DIR" 2>/dev/null || true
find "$WORK_DIR" -name "*.py" -delete

# Remove any __pycache__ directories (we compiled with -b, so .pyc is alongside)
find "$WORK_DIR" -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# Create the zip
echo "Creating $OUTPUT..."
rm -f "$OUTPUT"
(cd "$WORK_DIR" && zip -q -r "$OUTPUT" .)

# Report
SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "Done: $OUTPUT ($SIZE)"

# Cleanup
rm -rf "$WORK_DIR"
