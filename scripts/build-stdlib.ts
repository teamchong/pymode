#!/usr/bin/env npx tsx
/**
 * Build a minimal Python stdlib zip for WASI/CF Workers deployment.
 *
 * Strips tests, docs, tkinter, and other modules unavailable on WASI.
 * Output: build/stdlib-minimal.zip (~4.3MB)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const BUILD_DIR = path.join(ROOT_DIR, "build");
const CPYTHON_DIR = path.join(ROOT_DIR, "cpython");
const STDLIB_SRC = path.join(CPYTHON_DIR, "Lib");
const WORK_DIR = path.join(BUILD_DIR, "stdlib-work");
const OUTPUT = path.join(BUILD_DIR, "stdlib-minimal.zip");

const REMOVE_DIRS = [
  // Test suites
  "test",
  "tests",
  "unittest/test",
  // GUI (no display on WASI)
  "tkinter",
  "turtle",
  "turtledemo",
  "idlelib",
  // Email/web (heavy, rarely needed on edge)
  "email",
  "html",
  "http",
  "xmlrpc",
  "urllib",
  // Multiprocessing/threading (no fork/threads on WASI)
  "multiprocessing",
  "concurrent",
  // Other large modules not useful on WASI
  "distutils",
  "ensurepip",
  "lib2to3",
  "pydoc_data",
  "sqlite3",
  "ctypes",
  "curses",
  "dbm",
  "xml/sax",
  "xml/dom",
  "xml/parsers",
  // Docs and configs
  "__phello__",
];

const REMOVE_FILES = [
  "antigravity.py",
  "this.py",
  "webbrowser.py",
  "smtpd.py",
  "smtplib.py",
  "imaplib.py",
  "poplib.py",
  "nntplib.py",
  "ftplib.py",
  "telnetlib.py",
  "cgi.py",
  "cgitb.py",
  "aifc.py",
  "sunau.py",
  "wave.py",
  "audioop.py",
  "sndhdr.py",
  "pty.py",
  "tty.py",
  "termios.py",
  "crypt.py",
  "nis.py",
  "ossaudiodev.py",
  "spwd.py",
  "mailbox.py",
  "mailcap.py",
  "mimetypes.py",
  "pdb.py",
  "profile.py",
  "pstats.py",
  "cProfile.py",
  "doctest.py",
  "pydoc.py",
];

const KEEP_ENCODINGS = new Set([
  "__init__.py",
  "aliases.py",
  "utf_8.py",
  "utf_8_sig.py",
  "ascii.py",
  "latin_1.py",
  "raw_unicode_escape.py",
  "unicode_escape.py",
  "utf_16.py",
  "utf_16_be.py",
  "utf_16_le.py",
  "utf_32.py",
  "utf_32_be.py",
  "utf_32_le.py",
  "cp437.py",
  "idna.py",
]);

function rmrf(p: string): void {
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function walkDirs(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(d, entry.name);
        walk(full);
        results.push(full); // bottom-up
      }
    }
  }
  walk(dir);
  return results;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main(): void {
  if (!fs.existsSync(STDLIB_SRC) || !fs.statSync(STDLIB_SRC).isDirectory()) {
    console.log(`Error: CPython stdlib not found at ${STDLIB_SRC}`);
    console.log("Run build-phase2.ts first to clone CPython.");
    process.exit(1);
  }

  console.log(`Building minimal stdlib from ${STDLIB_SRC}...`);

  // Clean previous work
  rmrf(WORK_DIR);
  copyDirRecursive(STDLIB_SRC, WORK_DIR);

  // Remove large/unnecessary directories
  for (const d of REMOVE_DIRS) {
    const p = path.join(WORK_DIR, d);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      rmrf(p);
      console.log(`  Removed ${d}/`);
    }
  }

  // Remove individual files
  for (const f of REMOVE_FILES) {
    const p = path.join(WORK_DIR, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      fs.unlinkSync(p);
      console.log(`  Removed ${f}`);
    }
  }

  // Trim encodings to essential ones only
  const encDir = path.join(WORK_DIR, "encodings");
  if (fs.existsSync(encDir) && fs.statSync(encDir).isDirectory()) {
    for (const f of fs.readdirSync(encDir)) {
      if (f.endsWith(".py") && !KEEP_ENCODINGS.has(f)) {
        fs.unlinkSync(path.join(encDir, f));
      }
    }
    console.log("  Trimmed encodings/ to essential codecs");
  }

  // Compile .py to .pyc and remove .py source (saves ~40% space)
  // Shell out to python3 -m compileall since this requires CPython
  console.log("Compiling to .pyc...");
  try {
    execFileSync("python3", ["-m", "compileall", "-q", "-b", WORK_DIR], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    // compileall may return non-zero for some files that can't compile; continue
    console.log("  Warning: some files could not be compiled to .pyc");
  }

  // Remove .py source files (compiled with -b so .pyc is alongside)
  for (const f of walkFiles(WORK_DIR)) {
    if (f.endsWith(".py")) {
      fs.unlinkSync(f);
    }
  }

  // Remove __pycache__ directories
  for (const d of walkDirs(WORK_DIR)) {
    if (path.basename(d) === "__pycache__") {
      rmrf(d);
    }
  }

  // Create the zip using the system zip command with deflate compression
  console.log(`Creating ${OUTPUT}...`);
  if (fs.existsSync(OUTPUT)) {
    fs.unlinkSync(OUTPUT);
  }

  // Use system zip for ZIP_DEFLATED
  execFileSync("zip", ["-r", "-q", OUTPUT, "."], {
    cwd: WORK_DIR,
  });

  const size = fs.statSync(OUTPUT).size;
  console.log(`Done: ${OUTPUT} (${Math.floor(size / 1024)}KB)`);

  // Cleanup
  rmrf(WORK_DIR);
}

main();
