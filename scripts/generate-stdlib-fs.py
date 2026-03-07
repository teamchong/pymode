#!/usr/bin/env python3
"""Generate a TypeScript module containing stdlib .py files as string constants.

Reads Python stdlib files, PyMode runtime modules, and polyfills, then writes
them as a TypeScript Record<string, string> for embedding in the CF Workers MemFS.

Output: worker/src/stdlib-fs.ts
"""

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
STDLIB_SRC = os.path.join(ROOT_DIR, "cpython", "Lib")
OUTPUT = os.path.join(ROOT_DIR, "worker", "src", "stdlib-fs.ts")

# Modules Python needs to boot (from PYTHONVERBOSE trace)
# Frozen modules are already in the binary, but encodings + site helpers
# must come from the filesystem.
BOOT_FILES = [
    # encodings — required before Python can decode any text
    "encodings/__init__.py",
    "encodings/aliases.py",
    "encodings/utf_8.py",
    "encodings/ascii.py",
    "encodings/latin_1.py",
    "encodings/unicode_escape.py",
    "encodings/raw_unicode_escape.py",
    "encodings/punycode.py",
    "encodings/idna.py",
    "encodings/cp437.py",
    # boot chain: traceback support
    "linecache.py",
    "tokenize.py",
    "token.py",
    # json
    "json/__init__.py",
    "json/decoder.py",
    "json/encoder.py",
    "json/scanner.py",
    # re (regex)
    "re/__init__.py",
    "re/_casefix.py",
    "re/_compiler.py",
    "re/_constants.py",
    "re/_parser.py",
    # collections & functools
    "collections/__init__.py",
    "collections/abc.py",
    "functools.py",
    "operator.py",
    # core types
    "enum.py",
    "types.py",
    "typing.py",
    "warnings.py",
    "contextlib.py",
    "dataclasses.py",
    "copy.py",
    "copyreg.py",
    "weakref.py",
    "_weakrefset.py",
    # text
    "string.py",
    "textwrap.py",
    # data
    "base64.py",
    "hashlib.py",
    "hmac.py",
    "secrets.py",
    # numbers
    "random.py",
    "bisect.py",
    "heapq.py",
    "numbers.py",
    "fractions.py",
    "decimal.py",
    # datetime
    "datetime.py",
    "calendar.py",
    # path
    "fnmatch.py",
    "glob.py",
    # url
    "urllib/__init__.py",
    "urllib/parse.py",
    "ipaddress.py",
    # import machinery (needed for pymode._handler)
    "importlib/__init__.py",
    "importlib/_bootstrap.py",
    "importlib/_bootstrap_external.py",
    "importlib/abc.py",
    "importlib/_abc.py",
    "importlib/machinery.py",
    "importlib/util.py",
    # pickle (needed for pymode.parallel)
    "pickle.py",
    "_compat_pickle.py",
    # inspect + dependencies (needed for dataclasses)
    "inspect.py",
    "dis.py",
    "opcode.py",
    "_opcode_metadata.py",
    "ast.py",
    # logging — provided by polyfills/logging/__init__.py instead
    # (stdlib logging requires threading; polyfill is threading-free)
    # xml
    "xml/__init__.py",
    "xml/etree/__init__.py",
    "xml/etree/ElementTree.py",
    "xml/etree/ElementPath.py",
    "xml/etree/ElementInclude.py",
    "xml/etree/cElementTree.py",
    # uuid
    "uuid.py",
    # csv
    "csv.py",
    # pathlib
    "pathlib/__init__.py",
    "pathlib/_abc.py",
    "pathlib/_local.py",
    # pprint
    "pprint.py",
    # email (needed by requests, urllib3, http)
    "email/__init__.py",
    "email/_encoded_words.py",
    "email/_header_value_parser.py",
    "email/_parseaddr.py",
    "email/_policybase.py",
    "email/base64mime.py",
    "email/charset.py",
    "email/contentmanager.py",
    "email/encoders.py",
    "email/errors.py",
    "email/feedparser.py",
    "email/generator.py",
    "email/header.py",
    "email/headerregistry.py",
    "email/iterators.py",
    "email/message.py",
    "email/mime/__init__.py",
    "email/mime/base.py",
    "email/mime/multipart.py",
    "email/mime/nonmultipart.py",
    "email/mime/text.py",
    "email/parser.py",
    "email/policy.py",
    "email/quoprimime.py",
    "email/utils.py",
    # html (needed by bs4, pyparsing)
    "html/__init__.py",
    "html/parser.py",
    "html/entities.py",
    "_markupbase.py",
    # http (needed by requests, urllib3, httpx)
    "http/__init__.py",
    "http/client.py",
    "http/cookiejar.py",
    "http/cookies.py",
    "http/server.py",
    # urllib extras (needed by requests, httpx)
    "urllib/error.py",
    "urllib/request.py",
    "urllib/response.py",
    # shlex (needed by click, distro)
    "shlex.py",
    # signal
    "signal.py",
    # concurrent (needed by tenacity)
    "concurrent/__init__.py",
    "concurrent/futures/__init__.py",
    "concurrent/futures/_base.py",
    "concurrent/futures/thread.py",
    "concurrent/futures/process.py",
    # importlib extras (needed by certifi, setuptools, metadata)
    "importlib/resources/__init__.py",
    "importlib/resources/_adapters.py",
    "importlib/resources/_common.py",
    "importlib/resources/_functional.py",
    "importlib/resources/_itertools.py",
    "importlib/resources/abc.py",
    "importlib/resources/readers.py",
    "importlib/resources/simple.py",
    "importlib/readers.py",
    "importlib/metadata/__init__.py",
    "importlib/metadata/_adapters.py",
    "importlib/metadata/_collections.py",
    "importlib/metadata/_functools.py",
    "importlib/metadata/_itertools.py",
    "importlib/metadata/_meta.py",
    "importlib/metadata/_text.py",
    # quopri (needed by email)
    "quopri.py",
    # zipfile (needed by importlib.metadata)
    "zipfile/__init__.py",
    "zipfile/_path/__init__.py",
    "zipfile/_path/glob.py",
    # unittest (needed by pyparsing)
    "unittest/__init__.py",
    "unittest/case.py",
    "unittest/result.py",
    "unittest/util.py",
    "unittest/loader.py",
    "unittest/suite.py",
    "unittest/runner.py",
    "unittest/signals.py",
    "unittest/async_case.py",
    "unittest/main.py",
    # subprocess
    "subprocess.py",
    # selectors
    "selectors.py",
    # locale (needed by httpx, distro)
    "locale.py",
    # queue (needed by urllib3, logging)
    "queue.py",
    # difflib (needed by pyparsing, unittest)
    "difflib.py",
    # mimetypes (needed by requests, httpx, urllib3)
    "mimetypes.py",
    # needed by many PyPI packages
    "__future__.py",
    "tempfile.py",
    "shutil.py",
    "gettext.py",
    # needed by numpy
    "contextvars.py",
    "platform.py",
    "argparse.py",
    # needed by requests/urllib3 (IDNA)
    "stringprep.py",
    # zoneinfo (needed by pydantic)
    "zoneinfo/__init__.py",
    "zoneinfo/_common.py",
    "zoneinfo/_tzpath.py",
    "zoneinfo/_zoneinfo.py",
    # asyncio (needed by pydantic, fastapi, typing_extensions)
    "asyncio/__init__.py",
    "asyncio/base_events.py",
    "asyncio/base_futures.py",
    "asyncio/base_subprocess.py",
    "asyncio/base_tasks.py",
    "asyncio/constants.py",
    "asyncio/coroutines.py",
    "asyncio/events.py",
    "asyncio/exceptions.py",
    "asyncio/format_helpers.py",
    "asyncio/futures.py",
    "asyncio/graph.py",
    "asyncio/locks.py",
    "asyncio/log.py",
    "asyncio/mixins.py",
    "asyncio/proactor_events.py",
    "asyncio/protocols.py",
    "asyncio/queues.py",
    "asyncio/runners.py",
    "asyncio/selector_events.py",
    "asyncio/sslproto.py",
    "asyncio/staggered.py",
    "asyncio/streams.py",
    "asyncio/subprocess.py",
    "asyncio/tasks.py",
    "asyncio/taskgroups.py",
    "asyncio/threads.py",
    "asyncio/timeouts.py",
    "asyncio/transports.py",
    "asyncio/trsock.py",
    "asyncio/unix_events.py",
    "asyncio/windows_events.py",
    "asyncio/windows_utils.py",
    # misc
    "keyword.py",
    "reprlib.py",
    "traceback.py",
    "_colorize.py",
    "struct.py",
    # io (needed for stdin reading)
    "io.py",
    "_pyio.py",
    "abc.py",
    # sysconfig (needed by pydantic, setuptools)
    "sysconfig/__init__.py",
    "sysconfig/__main__.py",
    "_sysconfigdata__wasi_wasm32-wasi.py",
    # colorsys (needed by pydantic color)
    "colorsys.py",
    # configparser (needed by various packages)
    "configparser.py",
    # tomllib (needed by pydantic, project configs)
    "tomllib/__init__.py",
    "tomllib/_parser.py",
    "tomllib/_re.py",
    "tomllib/_types.py",
]

# PyMode runtime modules bundled alongside stdlib
PYMODE_FILES = [
    "pymode/__init__.py",
    "pymode/workers.py",
    "pymode/_handler.py",
    "pymode/http.py",
    "pymode/tcp.py",
    "pymode/env.py",
    "pymode/parallel.py",
    "pymode/workflows.py",
    "pymode/importer.py",
    "pymode/compute.py",
]

# Pure-Python polyfills for C extension modules unavailable in WASM.
POLYFILL_FILES = [
    "binascii.py",
    "socket.py",
    "_socket.py",
    "select.py",
    "ssl.py",
    "threading.py",
    "logging/__init__.py",
    "_pymode.py",
    "zlib.py",
    "_wasi_compat.py",
]


def escape_for_template_literal(content: str) -> str:
    """Escape content for use inside a JS template literal."""
    return content.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def main():
    if not os.path.isdir(STDLIB_SRC):
        print(f"Error: CPython stdlib not found at {STDLIB_SRC}")
        print("Run build-phase2.sh first.")
        sys.exit(1)

    print(f"Generating {OUTPUT}...")

    pymode_lib = os.path.join(ROOT_DIR, "lib")
    polyfill_dir = os.path.join(ROOT_DIR, "lib", "polyfills")
    count = 0

    with open(OUTPUT, "w") as f:
        f.write(
            "// Auto-generated by scripts/generate-stdlib-fs.py\n"
            "// Contains Python stdlib files and PyMode runtime for the CF Workers MemFS.\n"
            '// Keys are paths relative to the stdlib root (e.g. "encodings/__init__.py").\n'
            "\n"
            "export const stdlibFS: Record<string, string> = {\n"
        )

        # Bundle stdlib boot files
        for relpath in BOOT_FILES:
            srcfile = os.path.join(STDLIB_SRC, relpath)
            if not os.path.isfile(srcfile):
                print(f"  Warning: {relpath} not found, skipping")
                continue
            with open(srcfile, "r") as src:
                content = escape_for_template_literal(src.read())
            f.write(f'  "{relpath}": `{content}`,\n')
            count += 1

        # Bundle PyMode runtime modules
        for relpath in PYMODE_FILES:
            srcfile = os.path.join(pymode_lib, relpath)
            if not os.path.isfile(srcfile):
                print(f"  Warning: pymode/{relpath} not found, skipping")
                continue
            with open(srcfile, "r") as src:
                content = escape_for_template_literal(src.read())
            f.write(f'  "{relpath}": `{content}`,\n')
            count += 1

        # Bundle polyfills
        for relpath in POLYFILL_FILES:
            srcfile = os.path.join(polyfill_dir, relpath)
            if not os.path.isfile(srcfile):
                print(f"  Warning: polyfill {relpath} not found, skipping")
                continue
            with open(srcfile, "r") as src:
                content = escape_for_template_literal(src.read())
            f.write(f'  "{relpath}": `{content}`,\n')
            count += 1

        f.write("};\n")

    size_kb = os.path.getsize(OUTPUT) // 1024
    print(f"Done: {OUTPUT} ({count} files, {size_kb}KB)")


if __name__ == "__main__":
    main()
