#!/usr/bin/env npx tsx
/**
 * Test the WASI Python build.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(SCRIPT_DIR);

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

let PASS = 0;
let FAIL = 0;

// Find the python.sh runner
let PYTHON_SH = "";
const candidates = [
  join(ROOT_DIR, "build", "zig-wasi", "python.sh"),
  join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasi", "python.sh"),
  join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasip1", "python.sh"),
  join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasip2", "python.sh"),
];

for (const candidate of candidates) {
  if (existsSync(candidate)) {
    PYTHON_SH = candidate;
    break;
  }
}

function runTest(name: string, code: string, expected: string): void {
  let output = "";
  try {
    const result = execFileSync(PYTHON_SH, ["-c", code], {
      timeout: 10000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    output = result;
  } catch (err: any) {
    if (err.stdout || err.stderr) {
      output = (err.stdout ?? "") + (err.stderr ?? "");
    }
  }

  if (output.includes(expected)) {
    console.log(`  ${GREEN}PASS${NC} ${name}`);
    PASS++;
  } else {
    console.log(`  ${RED}FAIL${NC} ${name}`);
    console.log(`    Expected: ${expected}`);
    console.log(`    Got: ${output.trim()}`);
    FAIL++;
  }
}

function main(): void {
  if (!PYTHON_SH) {
    console.log(
      `${RED}No WASI Python build found. Run build-phase1.sh or npx tsx scripts/build-phase2.ts first.${NC}`
    );
    process.exit(1);
  }

  console.log(`Using: ${PYTHON_SH}\n`);

  console.log("=== Basic Tests ===");
  runTest("print", "print('hello')", "hello");
  runTest("arithmetic", "print(2 + 3)", "5");
  runTest("string ops", "print('hello' + ' ' + 'world')", "hello world");
  runTest("list", "print([1,2,3])", "[1, 2, 3]");
  runTest("dict", "print({'a': 1})", "{'a': 1}");
  runTest("f-string", "x=42; print(f'value={x}')", "value=42");
  runTest("sys.platform", "import sys; print(sys.platform)", "wasi");

  console.log("\n=== Module Import Tests ===");
  runTest(
    "json",
    `import json; print(json.loads('{"a":1}'))`,
    "{'a': 1}"
  );
  runTest("math", "import math; print(math.pi)", "3.14159");
  runTest(
    "collections",
    "from collections import Counter; print(Counter('aab'))",
    "Counter({'a': 2, 'b': 1})"
  );
  runTest(
    "itertools",
    "import itertools; print(list(itertools.chain([1],[2])))",
    "[1, 2]"
  );
  runTest(
    "functools",
    "from functools import reduce; print(reduce(lambda a,b: a+b, [1,2,3]))",
    "6"
  );
  runTest(
    "datetime",
    "from datetime import date; print(date(2024,1,1))",
    "2024-01-01"
  );
  runTest(
    "re",
    "import re; print(re.match(r'\\d+', '123').group())",
    "123"
  );
  runTest(
    "struct",
    "import struct; print(struct.pack('>I', 42).hex())",
    "0000002a"
  );
  runTest(
    "csv",
    "import csv, io; r=csv.reader(io.StringIO('a,b\\n1,2')); print(list(r))",
    "[['a', 'b'], ['1', '2']]"
  );
  runTest(
    "hashlib",
    "import hashlib; print(hashlib.md5(b'hello').hexdigest())",
    "5d41402abc4b2a76b9719d911017c592"
  );

  console.log(`\n=== Results ===`);
  const total = PASS + FAIL;
  console.log(
    `  Total: ${total}  ${GREEN}Pass: ${PASS}${NC}  ${RED}Fail: ${FAIL}${NC}`
  );

  if (FAIL > 0) {
    process.exit(1);
  }
}

main();
