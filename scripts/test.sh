#!/usr/bin/env bash
# Test the WASI Python build
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

# Find the python.sh runner (check multiple possible locations)
PYTHON_SH=""
for candidate in \
    "$ROOT_DIR/build/zig-wasi/python.sh" \
    "$ROOT_DIR/cpython/cross-build/wasm32-wasi/python.sh" \
    "$ROOT_DIR/cpython/cross-build/wasm32-wasip1/python.sh" \
    "$ROOT_DIR/cpython/cross-build/wasm32-wasip2/python.sh"; do
    if [ -f "$candidate" ]; then
        PYTHON_SH="$candidate"
        break
    fi
done

if [ -z "$PYTHON_SH" ]; then
    echo -e "${RED}No WASI Python build found. Run build-phase1.sh or build-phase2.sh first.${NC}"
    exit 1
fi

echo "Using: $PYTHON_SH"
echo ""

run_test() {
    local name="$1"
    local code="$2"
    local expected="$3"

    RESULT=$(timeout 10 "$PYTHON_SH" -c "$code" 2>&1) || true
    if echo "$RESULT" | grep -qF "$expected"; then
        echo -e "  ${GREEN}PASS${NC} $name"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} $name"
        echo "    Expected: $expected"
        echo "    Got: $RESULT"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Basic Tests ==="
run_test "print" "print('hello')" "hello"
run_test "arithmetic" "print(2 + 3)" "5"
run_test "string ops" "print('hello' + ' ' + 'world')" "hello world"
run_test "list" "print([1,2,3])" "[1, 2, 3]"
run_test "dict" "print({'a': 1})" "{'a': 1}"
run_test "f-string" "x=42; print(f'value={x}')" "value=42"
run_test "sys.platform" "import sys; print(sys.platform)" "wasi"

echo ""
echo "=== Module Import Tests ==="
run_test "json" "import json; print(json.loads('{\"a\":1}'))" "{'a': 1}"
run_test "math" "import math; print(math.pi)" "3.14159"
run_test "collections" "from collections import Counter; print(Counter('aab'))" "Counter({'a': 2, 'b': 1})"
run_test "itertools" "import itertools; print(list(itertools.chain([1],[2])))" "[1, 2]"
run_test "functools" "from functools import reduce; print(reduce(lambda a,b: a+b, [1,2,3]))" "6"
run_test "datetime" "from datetime import date; print(date(2024,1,1))" "2024-01-01"
run_test "re" "import re; print(re.match(r'\d+', '123').group())" "123"
run_test "struct" "import struct; print(struct.pack('>I', 42).hex())" "0000002a"
run_test "csv" "import csv, io; r=csv.reader(io.StringIO('a,b\n1,2')); print(list(r))" "[['a', 'b'], ['1', '2']]"
run_test "hashlib" "import hashlib; print(hashlib.md5(b'hello').hexdigest())" "5d41402abc4b2a76b9719d911017c592"

echo ""
echo "=== Results ==="
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  Total: $TOTAL  ${GREEN}Pass: $PASS${NC}  ${RED}Fail: $FAIL${NC}  ${YELLOW}Skip: $SKIP${NC}"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
