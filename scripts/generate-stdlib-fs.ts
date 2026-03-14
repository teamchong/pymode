#!/usr/bin/env npx tsx
/**
 * Generate stdlib data for the CF Workers MemFS.
 *
 * Reads Python stdlib files, PyMode runtime modules, and polyfills, then writes:
 *   - worker/src/stdlib-data.dat  — JSON blob loaded as Data module (ArrayBuffer)
 *   - worker/src/stdlib-fs.ts     — thin loader that decodes and exports the data
 *
 * This keeps the JS script small (~30 lines) while the stdlib content (~4MB)
 * is loaded as a separate Data module.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(SCRIPT_DIR);
const STDLIB_SRC = path.join(ROOT_DIR, "cpython", "Lib");
const OUTPUT_DAT = path.join(ROOT_DIR, "worker", "src", "stdlib-data.dat");
const OUTPUT_TS = path.join(ROOT_DIR, "worker", "src", "stdlib-fs.ts");

// Modules Python needs to boot (from PYTHONVERBOSE trace)
// Frozen modules are already in the binary, but encodings + site helpers
// must come from the filesystem.
const BOOT_FILES = [
    // encodings — required before Python can decode any text
    "encodings/__init__.py",
    "encodings/aliases.py",
    "encodings/utf_8.py",
    "encodings/utf_8_sig.py",
    "encodings/utf_16.py",
    "encodings/utf_16_be.py",
    "encodings/utf_16_le.py",
    "encodings/utf_32.py",
    "encodings/utf_32_be.py",
    "encodings/utf_32_le.py",
    "encodings/ascii.py",
    "encodings/latin_1.py",
    "encodings/unicode_escape.py",
    "encodings/raw_unicode_escape.py",
    "encodings/punycode.py",
    "encodings/idna.py",
    "encodings/charmap.py",
    // Western European / Windows
    "encodings/cp437.py",
    "encodings/cp1252.py",
    "encodings/iso8859_1.py",
    "encodings/iso8859_15.py",
    // CJK
    "encodings/gb2312.py",
    "encodings/gbk.py",
    "encodings/gb18030.py",
    "encodings/big5.py",
    "encodings/euc_jp.py",
    "encodings/euc_kr.py",
    "encodings/shift_jis.py",
    "encodings/cp949.py",
    "encodings/cp932.py",
    "encodings/cp950.py",
    // Cyrillic / Eastern European
    "encodings/cp1251.py",
    "encodings/koi8_r.py",
    "encodings/iso8859_2.py",
    // Codec helpers
    "encodings/base64_codec.py",
    // boot chain: traceback support
    "linecache.py",
    "tokenize.py",
    "token.py",
    // json
    "json/__init__.py",
    "json/decoder.py",
    "json/encoder.py",
    "json/scanner.py",
    // re (regex)
    "re/__init__.py",
    "re/_casefix.py",
    "re/_compiler.py",
    "re/_constants.py",
    "re/_parser.py",
    // collections & functools
    "collections/__init__.py",
    "collections/abc.py",
    "functools.py",
    "operator.py",
    // core types
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
    // text
    "string.py",
    "textwrap.py",
    // data
    "base64.py",
    "hashlib.py",
    "hmac.py",
    "secrets.py",
    // numbers
    "random.py",
    "bisect.py",
    "heapq.py",
    "numbers.py",
    "fractions.py",
    "decimal.py",
    "statistics.py",
    // datetime
    "datetime.py",
    "calendar.py",
    // path
    "fnmatch.py",
    "glob.py",
    // url
    "urllib/__init__.py",
    "urllib/parse.py",
    "ipaddress.py",
    // import machinery (needed for pymode._handler)
    "importlib/__init__.py",
    "importlib/_bootstrap.py",
    "importlib/_bootstrap_external.py",
    "importlib/abc.py",
    "importlib/_abc.py",
    "importlib/machinery.py",
    "importlib/util.py",
    // pickle (needed for pymode.parallel)
    "pickle.py",
    "_compat_pickle.py",
    // inspect + dependencies (needed for dataclasses)
    "inspect.py",
    "dis.py",
    "opcode.py",
    "_opcode_metadata.py",
    "ast.py",
    // logging — provided by polyfills/logging/__init__.py instead
    // (stdlib logging requires threading; polyfill is threading-free)
    // xml (main block is below with sax modules; these extras are here)
    "xml/etree/ElementInclude.py",
    "xml/etree/cElementTree.py",
    // uuid
    "uuid.py",
    // csv
    "csv.py",
    // pathlib
    "pathlib/__init__.py",
    "pathlib/_abc.py",
    "pathlib/_local.py",
    // pprint
    "pprint.py",
    // email (needed by requests, urllib3, http)
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
    // html (needed by bs4, pyparsing)
    "html/__init__.py",
    "html/parser.py",
    "html/entities.py",
    "_markupbase.py",
    // http (needed by requests, urllib3, httpx)
    "http/__init__.py",
    "http/client.py",
    "http/cookiejar.py",
    "http/cookies.py",
    "http/server.py",
    // urllib extras (needed by requests, httpx)
    "urllib/error.py",
    "urllib/request.py",
    "urllib/response.py",
    // shlex (needed by click, distro)
    "shlex.py",
    // signal
    "signal.py",
    // concurrent (needed by tenacity)
    "concurrent/__init__.py",
    "concurrent/futures/__init__.py",
    "concurrent/futures/_base.py",
    "concurrent/futures/thread.py",
    "concurrent/futures/process.py",
    // importlib extras (needed by certifi, setuptools, metadata)
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
    // quopri (needed by email)
    "quopri.py",
    // zipfile (needed by importlib.metadata)
    "zipfile/__init__.py",
    "zipfile/_path/__init__.py",
    "zipfile/_path/glob.py",
    // unittest (needed by pyparsing)
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
    // subprocess
    "subprocess.py",
    // selectors
    "selectors.py",
    // locale (needed by httpx, distro)
    "locale.py",
    // queue (needed by urllib3, logging)
    "queue.py",
    // difflib (needed by pyparsing, unittest)
    "difflib.py",
    // mimetypes (needed by requests, httpx, urllib3)
    "mimetypes.py",
    // needed by many PyPI packages
    "__future__.py",
    "tempfile.py",
    "shutil.py",
    "gettext.py",
    // needed by numpy
    "contextvars.py",
    "platform.py",
    "argparse.py",
    // needed by requests/urllib3 (IDNA)
    "stringprep.py",
    // zoneinfo (needed by pydantic)
    "zoneinfo/__init__.py",
    "zoneinfo/_common.py",
    "zoneinfo/_tzpath.py",
    "zoneinfo/_zoneinfo.py",
    // asyncio (needed by pydantic, fastapi, typing_extensions)
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
    // xml (needed by langchain, defusedxml, etc.)
    "xml/__init__.py",
    "xml/sax/__init__.py",
    "xml/sax/_exceptions.py",
    "xml/sax/expatreader.py",
    "xml/sax/handler.py",
    "xml/sax/saxutils.py",
    "xml/sax/xmlreader.py",
    "xml/parsers/__init__.py",
    "xml/parsers/expat.py",
    "xml/etree/__init__.py",
    "xml/etree/ElementTree.py",
    "xml/etree/ElementPath.py",
    // misc
    "keyword.py",
    "reprlib.py",
    "traceback.py",
    "_colorize.py",
    "struct.py",
    // io (needed for stdin reading)
    "io.py",
    "_pyio.py",
    "abc.py",
    // sysconfig (needed by pydantic, setuptools)
    "sysconfig/__init__.py",
    "sysconfig/__main__.py",
    "_sysconfigdata__wasi_wasm32-wasi.py",
    // colorsys (needed by pydantic color)
    "colorsys.py",
    // configparser (needed by various packages)
    "configparser.py",
    // tomllib (needed by pydantic, project configs)
    "tomllib/__init__.py",
    "tomllib/_parser.py",
    "tomllib/_re.py",
    "tomllib/_types.py",
];

// PyMode runtime modules bundled alongside stdlib
const PYMODE_FILES = [
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
    "pymode/simd.py",
    "pymode/zerobuf.py",
];

// Pure-Python polyfills for C extension modules unavailable in WASM.
const POLYFILL_FILES = [
    // binascii is a Zig native built-in module (zig-modules/binascii)
    "zlib.py",
    "socket.py",
    "_socket.py",
    "select.py",
    "ssl.py",
    "threading.py",
    "logging/__init__.py",
    "_pymode.py",
    "_wasi_compat.py",
    "multiprocessing/__init__.py",
    "ormsgpack.py",
    "faulthandler.py",
    "resource.py",
    "grp.py",
    "pwd.py",
    "fcntl.py",
    "mmap.py",
    "termios.py",
    "syslog.py",
    "_bz2.py",
    "_lzma.py",
    "_ctypes.py",
    "curses/__init__.py",
    "dbm/__init__.py",
    "tkinter/__init__.py",
];

function collectFiles(): Record<string, string> {
    const pymodeLib = path.join(ROOT_DIR, "lib");
    const polyfillDir = path.join(ROOT_DIR, "lib", "polyfills");
    const result: Record<string, string> = {};

    for (const relpath of BOOT_FILES) {
        const srcfile = path.join(STDLIB_SRC, relpath);
        if (!fs.existsSync(srcfile) || !fs.statSync(srcfile).isFile()) {
            console.log(`  Warning: ${relpath} not found, skipping`);
            continue;
        }
        result[relpath] = fs.readFileSync(srcfile, "utf-8");
    }

    for (const relpath of PYMODE_FILES) {
        const srcfile = path.join(pymodeLib, relpath);
        if (!fs.existsSync(srcfile) || !fs.statSync(srcfile).isFile()) {
            console.log(`  Warning: pymode/${relpath} not found, skipping`);
            continue;
        }
        result[relpath] = fs.readFileSync(srcfile, "utf-8");
    }

    for (const relpath of POLYFILL_FILES) {
        const srcfile = path.join(polyfillDir, relpath);
        if (!fs.existsSync(srcfile) || !fs.statSync(srcfile).isFile()) {
            console.log(`  Warning: polyfill ${relpath} not found, skipping`);
            continue;
        }
        result[relpath] = fs.readFileSync(srcfile, "utf-8");
    }

    return result;
}

function main(): void {
    if (!fs.existsSync(STDLIB_SRC) || !fs.statSync(STDLIB_SRC).isDirectory()) {
        console.error(`Error: CPython stdlib not found at ${STDLIB_SRC}`);
        console.error("Run build-phase2.ts first.");
        process.exit(1);
    }

    console.log("Generating stdlib data...");

    const files = collectFiles();

    // Patch types.py: CapsuleType uses _socket.CAPI which isn't available in WASI.
    // Use _datetime's C_API capsule instead (always available as a built-in).
    if ("types.py" in files) {
        files["types.py"] = files["types.py"].replace(
            "import _socket\n        return type(_socket.CAPI)",
            "import _datetime\n        return type(_datetime.datetime_CAPI)",
        );
    }

    // Write binary data file (JSON encoded as UTF-8)
    const jsonStr = JSON.stringify(files);
    const jsonBytes = Buffer.from(jsonStr, "utf-8");
    fs.writeFileSync(OUTPUT_DAT, jsonBytes);

    const datKb = Math.floor(fs.statSync(OUTPUT_DAT).size / 1024);

    // Write thin TypeScript loader
    const loaderContent = `\
// Auto-generated by scripts/generate-stdlib-fs.ts
// Loads stdlib data from a binary Data module (stdlib-data.dat).
// This keeps the JS script small while stdlib content is a separate asset.

// @ts-ignore — Data module import (ArrayBuffer), matched by wrangler rules
import stdlibData from "./stdlib-data.dat";

const _decoder = new TextDecoder();
export const stdlibFS: Record<string, string> = JSON.parse(
  _decoder.decode(stdlibData)
);
`;
    fs.writeFileSync(OUTPUT_TS, loaderContent, "utf-8");

    const tsBytes = fs.statSync(OUTPUT_TS).size;
    const fileCount = Object.keys(files).length;
    console.log("Done:");
    console.log(`  ${OUTPUT_DAT} (${fileCount} files, ${datKb}KB)`);
    console.log(`  ${OUTPUT_TS} (${tsBytes} bytes — loader only)`);

    // Ensure zip Data modules exist so static ESM imports in worker.ts
    // and stdlib-bin.ts resolve at bundle time. Real content is written
    // by scripts/bundle-packages.ts before tests or deploy.
    for (const zipName of ["site-packages.zip", "extension-site-packages.zip"]) {
        const zipPath = path.join(ROOT_DIR, "worker", "src", zipName);
        if (!fs.existsSync(zipPath)) {
            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(0x06054b50, 0); // End of Central Directory
            fs.writeFileSync(zipPath, eocd);
            console.log(`  ${zipPath} (empty zip — no packages bundled yet)`);
        }
    }
}

main();
