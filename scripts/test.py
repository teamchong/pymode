#!/usr/bin/env python3
"""Test the WASI Python build."""

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)

GREEN = "\033[0;32m"
RED = "\033[0;31m"
YELLOW = "\033[1;33m"
NC = "\033[0m"

PASS = 0
FAIL = 0

# Find the python.sh runner
PYTHON_SH = ""
for candidate in [
    os.path.join(ROOT_DIR, "build", "zig-wasi", "python.sh"),
    os.path.join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasi", "python.sh"),
    os.path.join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasip1", "python.sh"),
    os.path.join(ROOT_DIR, "cpython", "cross-build", "wasm32-wasip2", "python.sh"),
]:
    if os.path.isfile(candidate):
        PYTHON_SH = candidate
        break


def run_test(name: str, code: str, expected: str):
    global PASS, FAIL
    try:
        result = subprocess.run(
            [PYTHON_SH, "-c", code],
            capture_output=True, text=True, timeout=10,
        )
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        output = ""

    if expected in output:
        print(f"  {GREEN}PASS{NC} {name}")
        PASS += 1
    else:
        print(f"  {RED}FAIL{NC} {name}")
        print(f"    Expected: {expected}")
        print(f"    Got: {output.strip()}")
        FAIL += 1


def main():
    if not PYTHON_SH:
        print(f"{RED}No WASI Python build found. Run build-phase1.sh or build-phase2.sh first.{NC}")
        sys.exit(1)

    print(f"Using: {PYTHON_SH}\n")

    print("=== Basic Tests ===")
    run_test("print", "print('hello')", "hello")
    run_test("arithmetic", "print(2 + 3)", "5")
    run_test("string ops", "print('hello' + ' ' + 'world')", "hello world")
    run_test("list", "print([1,2,3])", "[1, 2, 3]")
    run_test("dict", "print({'a': 1})", "{'a': 1}")
    run_test("f-string", "x=42; print(f'value={x}')", "value=42")
    run_test("sys.platform", "import sys; print(sys.platform)", "wasi")

    print("\n=== Module Import Tests ===")
    run_test("json", "import json; print(json.loads('{\"a\":1}'))", "{'a': 1}")
    run_test("math", "import math; print(math.pi)", "3.14159")
    run_test("collections", "from collections import Counter; print(Counter('aab'))", "Counter({'a': 2, 'b': 1})")
    run_test("itertools", "import itertools; print(list(itertools.chain([1],[2])))", "[1, 2]")
    run_test("functools", "from functools import reduce; print(reduce(lambda a,b: a+b, [1,2,3]))", "6")
    run_test("datetime", "from datetime import date; print(date(2024,1,1))", "2024-01-01")
    run_test("re", "import re; print(re.match(r'\\d+', '123').group())", "123")
    run_test("struct", "import struct; print(struct.pack('>I', 42).hex())", "0000002a")
    run_test("csv", "import csv, io; r=csv.reader(io.StringIO('a,b\\n1,2')); print(list(r))", "[['a', 'b'], ['1', '2']]")
    run_test("hashlib", "import hashlib; print(hashlib.md5(b'hello').hexdigest())", "5d41402abc4b2a76b9719d911017c592")

    print(f"\n=== Results ===")
    total = PASS + FAIL
    print(f"  Total: {total}  {GREEN}Pass: {PASS}{NC}  {RED}Fail: {FAIL}{NC}")

    if FAIL > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
