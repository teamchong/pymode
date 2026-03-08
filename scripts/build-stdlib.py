#!/usr/bin/env python3
"""Build a minimal Python stdlib zip for WASI/CF Workers deployment.

Strips tests, docs, tkinter, and other modules unavailable on WASI.
Output: build/stdlib-minimal.zip (~4.3MB)
"""

import compileall
import os
import shutil
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
BUILD_DIR = os.path.join(ROOT_DIR, "build")
CPYTHON_DIR = os.path.join(ROOT_DIR, "cpython")
STDLIB_SRC = os.path.join(CPYTHON_DIR, "Lib")
WORK_DIR = os.path.join(BUILD_DIR, "stdlib-work")
OUTPUT = os.path.join(BUILD_DIR, "stdlib-minimal.zip")

REMOVE_DIRS = [
    # Test suites
    "test", "tests", "unittest/test",
    # GUI (no display on WASI)
    "tkinter", "turtle", "turtledemo", "idlelib",
    # Email/web (heavy, rarely needed on edge)
    "email", "html", "http", "xmlrpc", "urllib",
    # Multiprocessing/threading (no fork/threads on WASI)
    "multiprocessing", "concurrent",
    # Other large modules not useful on WASI
    "distutils", "ensurepip", "lib2to3", "pydoc_data",
    "sqlite3", "ctypes", "curses", "dbm",
    "xml/sax", "xml/dom", "xml/parsers",
    # Docs and configs
    "__phello__",
]

REMOVE_FILES = [
    "antigravity.py", "this.py", "webbrowser.py",
    "smtpd.py", "smtplib.py", "imaplib.py", "poplib.py",
    "nntplib.py", "ftplib.py", "telnetlib.py",
    "cgi.py", "cgitb.py",
    "aifc.py", "sunau.py", "wave.py", "audioop.py", "sndhdr.py",
    "pty.py", "tty.py", "termios.py",
    "crypt.py", "nis.py", "ossaudiodev.py", "spwd.py",
    "mailbox.py", "mailcap.py", "mimetypes.py",
    "pdb.py", "profile.py", "pstats.py", "cProfile.py",
    "doctest.py", "pydoc.py",
]

KEEP_ENCODINGS = {
    "__init__.py", "aliases.py", "utf_8.py", "utf_8_sig.py",
    "ascii.py", "latin_1.py", "raw_unicode_escape.py",
    "unicode_escape.py", "utf_16.py", "utf_16_be.py", "utf_16_le.py",
    "utf_32.py", "utf_32_be.py", "utf_32_le.py", "cp437.py", "idna.py",
}


def main():
    if not os.path.isdir(STDLIB_SRC):
        print(f"Error: CPython stdlib not found at {STDLIB_SRC}")
        print("Run build-phase2.py first to clone CPython.")
        sys.exit(1)

    print(f"Building minimal stdlib from {STDLIB_SRC}...")

    # Clean previous work
    if os.path.exists(WORK_DIR):
        shutil.rmtree(WORK_DIR)
    shutil.copytree(STDLIB_SRC, WORK_DIR)

    # Remove large/unnecessary directories
    for d in REMOVE_DIRS:
        path = os.path.join(WORK_DIR, d)
        if os.path.isdir(path):
            shutil.rmtree(path)
            print(f"  Removed {d}/")

    # Remove individual files
    for f in REMOVE_FILES:
        path = os.path.join(WORK_DIR, f)
        if os.path.isfile(path):
            os.remove(path)
            print(f"  Removed {f}")

    # Trim encodings to essential ones only
    enc_dir = os.path.join(WORK_DIR, "encodings")
    if os.path.isdir(enc_dir):
        for f in os.listdir(enc_dir):
            if f.endswith(".py") and f not in KEEP_ENCODINGS:
                os.remove(os.path.join(enc_dir, f))
        print("  Trimmed encodings/ to essential codecs")

    # Compile .py to .pyc and remove .py source (saves ~40% space)
    print("Compiling to .pyc...")
    compileall.compile_dir(WORK_DIR, quiet=2, legacy=True)
    for root, _, files in os.walk(WORK_DIR):
        for f in files:
            if f.endswith(".py"):
                os.remove(os.path.join(root, f))

    # Remove __pycache__ directories (compiled with legacy=True, .pyc is alongside)
    for root, dirs, _ in os.walk(WORK_DIR, topdown=False):
        for d in dirs:
            if d == "__pycache__":
                shutil.rmtree(os.path.join(root, d))

    # Create the zip
    print(f"Creating {OUTPUT}...")
    if os.path.exists(OUTPUT):
        os.remove(OUTPUT)
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(WORK_DIR):
            for f in sorted(files):
                filepath = os.path.join(root, f)
                arcname = os.path.relpath(filepath, WORK_DIR)
                zf.write(filepath, arcname)

    size = os.path.getsize(OUTPUT)
    print(f"Done: {OUTPUT} ({size // 1024}KB)")

    # Cleanup
    shutil.rmtree(WORK_DIR)


if __name__ == "__main__":
    main()
