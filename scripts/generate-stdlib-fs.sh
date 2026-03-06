#!/bin/bash
# Generate a TypeScript module containing stdlib .py files as string constants
# for embedding in the CF Workers MemFS.
#
# Output: worker/src/stdlib-fs.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STDLIB_SRC="$ROOT_DIR/cpython/Lib"
OUTPUT="$ROOT_DIR/worker/src/stdlib-fs.ts"

if [ ! -d "$STDLIB_SRC" ]; then
    echo "Error: CPython stdlib not found at $STDLIB_SRC"
    echo "Run build-phase2.sh first."
    exit 1
fi

# Modules Python needs to boot (from PYTHONVERBOSE trace)
# Frozen modules are already in the binary, but encodings + site helpers
# must come from the filesystem.
BOOT_FILES=(
    # encodings — required before Python can decode any text
    "encodings/__init__.py"
    "encodings/aliases.py"
    "encodings/utf_8.py"
    "encodings/ascii.py"
    "encodings/latin_1.py"
    "encodings/unicode_escape.py"
    "encodings/raw_unicode_escape.py"
    "encodings/punycode.py"
    "encodings/idna.py"
    "encodings/cp437.py"
    # boot chain: traceback support
    "linecache.py"
    "tokenize.py"
    "token.py"
    # json
    "json/__init__.py"
    "json/decoder.py"
    "json/encoder.py"
    "json/scanner.py"
    # re (regex)
    "re/__init__.py"
    "re/_casefix.py"
    "re/_compiler.py"
    "re/_constants.py"
    "re/_parser.py"
    # collections & functools
    "collections/__init__.py"
    "collections/abc.py"
    "functools.py"
    "operator.py"
    # core types
    "enum.py"
    "types.py"
    "typing.py"
    "warnings.py"
    "contextlib.py"
    "dataclasses.py"
    "copy.py"
    "copyreg.py"
    "weakref.py"
    "_weakrefset.py"
    # text
    "string.py"
    "textwrap.py"
    # data
    "base64.py"
    "hashlib.py"
    "hmac.py"
    "secrets.py"
    # numbers
    "random.py"
    "bisect.py"
    "heapq.py"
    "numbers.py"
    "fractions.py"
    "decimal.py"
    # datetime
    "datetime.py"
    "calendar.py"
    # path
    "fnmatch.py"
    "glob.py"
    # url
    "urllib/__init__.py"
    "urllib/parse.py"
    "ipaddress.py"
    # import machinery (needed for pymode._handler)
    "importlib/__init__.py"
    "importlib/_bootstrap.py"
    "importlib/_bootstrap_external.py"
    "importlib/abc.py"
    "importlib/_abc.py"
    "importlib/machinery.py"
    "importlib/util.py"
    # pickle (needed for pymode.parallel)
    "pickle.py"
    "_compat_pickle.py"
    # inspect + dependencies (needed for dataclasses)
    "inspect.py"
    "dis.py"
    "opcode.py"
    "_opcode_metadata.py"
    "ast.py"
    # logging — provided by polyfills/logging/__init__.py instead
    # (stdlib logging requires threading; polyfill is threading-free)
    # xml
    "xml/__init__.py"
    "xml/etree/__init__.py"
    "xml/etree/ElementTree.py"
    "xml/etree/ElementPath.py"
    "xml/etree/ElementInclude.py"
    "xml/etree/cElementTree.py"
    # uuid
    "uuid.py"
    # csv
    "csv.py"
    # pathlib
    "pathlib/__init__.py"
    "pathlib/_abc.py"
    "pathlib/_local.py"
    # pprint
    "pprint.py"
    # email (needed by requests, urllib3, http)
    "email/__init__.py"
    "email/_encoded_words.py"
    "email/_header_value_parser.py"
    "email/_parseaddr.py"
    "email/_policybase.py"
    "email/base64mime.py"
    "email/charset.py"
    "email/contentmanager.py"
    "email/encoders.py"
    "email/errors.py"
    "email/feedparser.py"
    "email/generator.py"
    "email/header.py"
    "email/headerregistry.py"
    "email/iterators.py"
    "email/message.py"
    "email/mime/__init__.py"
    "email/mime/base.py"
    "email/mime/multipart.py"
    "email/mime/nonmultipart.py"
    "email/mime/text.py"
    "email/parser.py"
    "email/policy.py"
    "email/quoprimime.py"
    "email/utils.py"
    # html (needed by bs4, pyparsing)
    "html/__init__.py"
    "html/parser.py"
    "html/entities.py"
    "_markupbase.py"
    # http (needed by requests, urllib3, httpx)
    "http/__init__.py"
    "http/client.py"
    "http/cookiejar.py"
    "http/cookies.py"
    "http/server.py"
    # urllib extras (needed by requests, httpx)
    "urllib/error.py"
    "urllib/request.py"
    "urllib/response.py"
    # shlex (needed by click, distro)
    "shlex.py"
    # signal
    "signal.py"
    # concurrent (needed by tenacity)
    "concurrent/__init__.py"
    "concurrent/futures/__init__.py"
    "concurrent/futures/_base.py"
    "concurrent/futures/thread.py"
    "concurrent/futures/process.py"
    # importlib extras (needed by certifi, setuptools, metadata)
    "importlib/resources/__init__.py"
    "importlib/resources/_adapters.py"
    "importlib/resources/_common.py"
    "importlib/resources/_functional.py"
    "importlib/resources/_itertools.py"
    "importlib/resources/abc.py"
    "importlib/resources/readers.py"
    "importlib/resources/simple.py"
    "importlib/readers.py"
    "importlib/metadata/__init__.py"
    "importlib/metadata/_adapters.py"
    "importlib/metadata/_collections.py"
    "importlib/metadata/_functools.py"
    "importlib/metadata/_itertools.py"
    "importlib/metadata/_meta.py"
    "importlib/metadata/_text.py"
    # quopri (needed by email)
    "quopri.py"
    # zipfile (needed by importlib.metadata)
    "zipfile/__init__.py"
    "zipfile/_path/__init__.py"
    "zipfile/_path/glob.py"
    # unittest (needed by pyparsing)
    "unittest/__init__.py"
    "unittest/case.py"
    "unittest/result.py"
    "unittest/util.py"
    "unittest/loader.py"
    "unittest/suite.py"
    "unittest/runner.py"
    "unittest/signals.py"
    "unittest/async_case.py"
    "unittest/main.py"
    # subprocess
    "subprocess.py"
    # selectors
    "selectors.py"
    # locale (needed by httpx, distro)
    "locale.py"
    # queue (needed by urllib3, logging)
    "queue.py"
    # difflib (needed by pyparsing, unittest)
    "difflib.py"
    # mimetypes (needed by requests, httpx, urllib3)
    "mimetypes.py"
    # needed by many PyPI packages
    "__future__.py"
    "tempfile.py"
    "shutil.py"
    "gettext.py"
    # needed by numpy
    "contextvars.py"
    "platform.py"
    "argparse.py"
    # misc
    "keyword.py"
    "reprlib.py"
    "traceback.py"
    "_colorize.py"
    "struct.py"
    # io (needed for stdin reading)
    "io.py"
    "_pyio.py"
    "abc.py"
)

PYMODE_LIB="$ROOT_DIR/lib"

# PyMode runtime modules bundled alongside stdlib
PYMODE_FILES=(
    "pymode/__init__.py"
    "pymode/workers.py"
    "pymode/_handler.py"
    "pymode/http.py"
    "pymode/tcp.py"
    "pymode/env.py"
    "pymode/parallel.py"
    "pymode/workflows.py"
    "pymode/importer.py"
    "pymode/compute.py"
)

echo "Generating $OUTPUT..."

cat > "$OUTPUT" << 'HEADER'
// Auto-generated by scripts/generate-stdlib-fs.sh
// Contains Python stdlib files and PyMode runtime for the CF Workers MemFS.
// Keys are paths relative to the stdlib root (e.g. "encodings/__init__.py").

export const stdlibFS: Record<string, string> = {
HEADER

COUNT=0
for relpath in "${BOOT_FILES[@]}"; do
    srcfile="$STDLIB_SRC/$relpath"
    if [ ! -f "$srcfile" ]; then
        echo "  Warning: $relpath not found, skipping"
        continue
    fi

    # Escape backticks and backslashes for template literal
    echo -n "  \"$relpath\": \`" >> "$OUTPUT"
    sed 's/\\/\\\\/g; s/`/\\`/g; s/\${/\\${/g' "$srcfile" >> "$OUTPUT"
    echo "\`," >> "$OUTPUT"

    COUNT=$((COUNT + 1))
done

# Bundle PyMode runtime modules
for relpath in "${PYMODE_FILES[@]}"; do
    srcfile="$PYMODE_LIB/$relpath"
    if [ ! -f "$srcfile" ]; then
        echo "  Warning: pymode/$relpath not found, skipping"
        continue
    fi

    echo -n "  \"$relpath\": \`" >> "$OUTPUT"
    sed 's/\\/\\\\/g; s/`/\\`/g; s/\${/\\${/g' "$srcfile" >> "$OUTPUT"
    echo "\`," >> "$OUTPUT"

    COUNT=$((COUNT + 1))
done

# Bundle pure-Python polyfills for C extension modules unavailable in WASM.
# These replace missing C modules (binascii) so that stdlib modules
# depending on them (base64, hashlib, hmac) work correctly.
# Note: _weakref is a built-in C module already linked into python.wasm.
# Reference implementations: metal0/packages/runtime/src/Lib/ (Zig equivalents).
POLYFILL_DIR="$ROOT_DIR/lib/polyfills"
POLYFILL_FILES=(
    "binascii.py"
    "socket.py"
    "_socket.py"
    "select.py"
    "ssl.py"
    "threading.py"
    "logging/__init__.py"
    "_pymode.py"
)

for relpath in "${POLYFILL_FILES[@]}"; do
    srcfile="$POLYFILL_DIR/$relpath"
    if [ ! -f "$srcfile" ]; then
        echo "  Warning: polyfill $relpath not found, skipping"
        continue
    fi

    echo -n "  \"$relpath\": \`" >> "$OUTPUT"
    sed 's/\\/\\\\/g; s/`/\\`/g; s/\${/\\${/g' "$srcfile" >> "$OUTPUT"
    echo "\`," >> "$OUTPUT"

    COUNT=$((COUNT + 1))
done

echo "};" >> "$OUTPUT"

# Report size
SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
SIZE_KB=$((SIZE / 1024))
echo "Done: $OUTPUT ($COUNT files, ${SIZE_KB}KB)"
