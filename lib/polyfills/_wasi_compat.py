"""WASI compatibility patches for Cloudflare Workers.

Patches missing os/process functions that WASI doesn't provide but
third-party packages (requests, tempfile, multiprocessing) expect.

Imported as the first line before user code by the Worker runtime.
"""

import os
import sys

# In test mode, replace the built-in _pymode C extension with the pure-Python
# polyfill. The polyfill reads seed data from the VFS and provides in-memory
# KV/R2/D1/env stores, while the C extension calls WASM host imports that
# require Asyncify + PythonDO infrastructure not present in the test runner.
if os.path.exists("/stdlib/tmp/_pymode_seed.json"):
    import importlib.util
    _spec = importlib.util.spec_from_file_location("_pymode", "/stdlib/_pymode.py")
    if _spec and _spec.loader:
        _mod = importlib.util.module_from_spec(_spec)
        sys.modules["_pymode"] = _mod
        _spec.loader.exec_module(_mod)
        del _mod, _spec

# WASI has no process model — provide defaults for packages that check these.
if not hasattr(os, "getpid"):
    os.getpid = lambda: 1

if not hasattr(os, "getuid"):
    os.getuid = lambda: 0

if not hasattr(os, "getgid"):
    os.getgid = lambda: 0

if not hasattr(os, "getppid"):
    os.getppid = lambda: 0

if not hasattr(os, "kill"):
    def _kill(pid, sig):
        raise OSError("kill not available in WASI")
    os.kill = _kill

if not hasattr(os, "getlogin"):
    os.getlogin = lambda: "worker"

if not hasattr(os, "uname"):
    class _Uname:
        sysname = "WASI"
        nodename = "cloudflare"
        release = "0.0.0"
        version = "0.0.0"
        machine = "wasm32"
    os.uname = lambda: _Uname()

# Pre-set tempdir to /tmp (exists in MemFS) to avoid tempfile's
# directory probe which requires writing test files.
import tempfile as _tempfile
_tempfile.tempdir = "/tmp"
del _tempfile

# Make importlib.metadata work with packages inside zip files.
# Packages in site-packages.zip include dist-info/METADATA but the default
# MetadataPathFinder can't look inside zips via the WASI VFS.
#
# We read the zip central directory using _io.open_code() — the same function
# that zipimport uses internally to read zip files in WASI. This avoids both
# zipfile.ZipFile (VFS re-open issues) and zipimport internal APIs.
def _install_zip_metadata_finder():
    import importlib.metadata as metadata
    import struct
    import pathlib
    import _io

    def _normalize(name):
        return name.lower().replace("-", "_").replace(".", "_")

    def _read_zip_entries(archive):
        """Read file names from a ZIP central directory using _io.open_code."""
        try:
            fp = _io.open_code(archive)
        except OSError:
            return []
        entries = []
        try:
            # Find End of Central Directory record (last 22+ bytes)
            fp.seek(0, 2)
            file_size = fp.tell()
            search_start = max(file_size - 65557, 0)  # 65535 comment + 22 EOCD
            fp.seek(search_start)
            data = fp.read()
            eocd_pos = data.rfind(b'PK\x05\x06')
            if eocd_pos < 0:
                return []
            cd_offset = struct.unpack_from('<I', data, eocd_pos + 16)[0]
            cd_count = struct.unpack_from('<H', data, eocd_pos + 8)[0]
            # Read central directory entries
            fp.seek(cd_offset)
            for _ in range(cd_count):
                header = fp.read(46)
                if len(header) < 46 or header[:4] != b'PK\x01\x02':
                    break
                name_len = struct.unpack_from('<H', header, 28)[0]
                extra_len = struct.unpack_from('<H', header, 30)[0]
                comment_len = struct.unpack_from('<H', header, 32)[0]
                compress = struct.unpack_from('<H', header, 10)[0]
                data_size = struct.unpack_from('<I', header, 20)[0]
                file_offset = struct.unpack_from('<I', header, 42)[0]
                name = fp.read(name_len).decode('utf-8', errors='replace')
                fp.read(extra_len + comment_len)  # skip extra + comment
                entries.append((name, compress, data_size, file_offset))
        finally:
            fp.close()
        return entries

    def _read_zip_file(archive, compress, data_size, file_offset):
        """Read a single file from the ZIP archive."""
        try:
            fp = _io.open_code(archive)
        except OSError:
            return None
        try:
            fp.seek(file_offset)
            local_header = fp.read(30)
            if len(local_header) < 30 or local_header[:4] != b'PK\x03\x04':
                return None
            name_len = struct.unpack_from('<H', local_header, 26)[0]
            extra_len = struct.unpack_from('<H', local_header, 28)[0]
            fp.read(name_len + extra_len)  # skip name + extra
            raw_data = fp.read(data_size)
            if compress == 0:
                return raw_data
            # Compressed — use zlib (our polyfill handles this)
            import zlib
            return zlib.decompress(raw_data, -15)
        except Exception:
            return None
        finally:
            fp.close()

    # Pre-scan zip files on sys.path and build a metadata cache
    _metadata_cache = {}  # package_name -> (archive, entries_dict)

    def _scan_zip(archive):
        """Scan a zip file and cache dist-info metadata locations."""
        entries = _read_zip_entries(archive)
        entry_map = {}
        for name, compress, data_size, file_offset in entries:
            entry_map[name] = (compress, data_size, file_offset)
        dist_dirs = set()
        for name in entry_map:
            if ".dist-info/" in name:
                dist_dir = name.split(".dist-info/")[0] + ".dist-info"
                dist_dirs.add(dist_dir)
        for dist_dir in dist_dirs:
            meta_key = dist_dir + "/METADATA"
            if meta_key not in entry_map:
                continue
            compress, data_size, file_offset = entry_map[meta_key]
            raw = _read_zip_file(archive, compress, data_size, file_offset)
            if raw is None:
                continue
            meta_text = raw.decode("utf-8", errors="replace")
            pkg_name = None
            for line in meta_text.splitlines():
                if line.startswith("Name:"):
                    pkg_name = line.split(":", 1)[1].strip()
                    break
            if pkg_name:
                _metadata_cache[_normalize(pkg_name)] = (archive, dist_dir, entry_map)

    # Eager scan at this point captures only zips on sys.path now. At wizer
    # time that's empty (sys.path is /stdlib:/wizer-sp:/wizer-ext-sp), so we
    # also scan lazily on first lookup against the runtime sys.path.
    _scanned_archives = set()

    def _ensure_runtime_scan():
        for _path_entry in sys.path:
            if _path_entry.endswith(".zip") and _path_entry not in _scanned_archives:
                _scanned_archives.add(_path_entry)
                _scan_zip(_path_entry)

    for _path_entry in sys.path:
        if _path_entry.endswith(".zip"):
            _scanned_archives.add(_path_entry)
            _scan_zip(_path_entry)

    class ZipDistribution(metadata.Distribution):
        def __init__(self, archive, dist_dir, entry_map):
            self._archive = archive
            self._dist_dir = dist_dir
            self._entry_map = entry_map

        def read_text(self, filename):
            key = self._dist_dir + "/" + filename
            info = self._entry_map.get(key)
            if info is None:
                return None
            compress, data_size, file_offset = info
            raw = _read_zip_file(self._archive, compress, data_size, file_offset)
            if raw is None:
                return None
            return raw.decode("utf-8", errors="replace")

        def locate_file(self, path):
            return pathlib.PurePosixPath(path)

    class ZipMetadataFinder(metadata.DistributionFinder):
        """Finds package metadata inside zip files on sys.path."""

        @classmethod
        def find_distributions(cls, context=metadata.DistributionFinder.Context()):
            _ensure_runtime_scan()
            name = getattr(context, "name", None)
            if name:
                key = _normalize(name)
                info = _metadata_cache.get(key)
                if info:
                    archive, dist_dir, entry_map = info
                    yield ZipDistribution(archive, dist_dir, entry_map)
            else:
                seen = set()
                for key, (archive, dist_dir, entry_map) in _metadata_cache.items():
                    if dist_dir not in seen:
                        seen.add(dist_dir)
                        yield ZipDistribution(archive, dist_dir, entry_map)

    sys.meta_path.append(ZipMetadataFinder)

_install_zip_metadata_finder()
del _install_zip_metadata_finder


def _install_side_module_finder():
    """Bridge PyPI-style extension imports (e.g. numpy._core._multiarray_umath)
    to dlopen-loaded .wasm side modules.

    PyPI packages do `from .submod import X`, but native extensions in pymode
    ship as separate .wasm side modules (bundled in worker/src/extensions/).
    They can't be discovered by FileFinder because they live inside a zip
    (or alongside the worker bundle, not on a filesystem path the finder
    walks). This MetaPathFinder returns a spec backed by ExtensionFileLoader
    for known names; loading the spec invokes CPython's _imp.create_dynamic,
    which calls _PyImport_FindSharedFuncptr (dynload_pymode.c) → pymode.dl_open
    → JS instantiates the side module from extensionModules.
    """
    import sys
    from importlib.abc import MetaPathFinder
    from importlib.machinery import ExtensionFileLoader
    from importlib.util import spec_from_loader

    # Map fully-qualified module names to the .wasm filename we ask dl_open for.
    # JS-side python-do.ts seeds extensionModules with these names plus
    # path-suffix matches, so either basename or full path works.
    _BRIDGES = {
        "numpy._core._multiarray_umath": "_multiarray_umath.wasm",
    }

    class SideModuleFinder(MetaPathFinder):
        @classmethod
        def find_spec(cls, fullname, path, target=None):
            wasm_name = _BRIDGES.get(fullname)
            if wasm_name is None:
                return None
            loader = ExtensionFileLoader(fullname, wasm_name)
            return spec_from_loader(fullname, loader, origin=wasm_name)

        @classmethod
        def invalidate_caches(cls):
            pass

    # Insert at the front so it runs before PathFinder (which would fail with
    # FileNotFoundError on the zip-internal _multiarray_umath path).
    sys.meta_path.insert(0, SideModuleFinder)


_install_side_module_finder()
del _install_side_module_finder


# Path-rewrite is in pymode._path_fixup so it can be preimported AFTER all the
# third-party packages whose __path__ it needs to rewrite. Keep the function
# below for documentation / standalone use, but don't call it from _wasi_compat
# (we'd run before the packages exist in sys.modules).
def _rewrite_wizer_package_paths():
    """Re-point preimported packages' __path__ from wizer paths to the
    runtime zip paths so new submodules become loadable.

    At wizer time, site-packages content lives at /wizer-sp (directory).
    Packages preimported during wizer (jinja2, click, pydantic, starlette,
    fastmcp, …) keep `__path__ = ['/wizer-sp/<pkg>']`. At runtime, the same
    content is mounted as a zip file at /stdlib/site-packages.zip, with
    extension packages at /stdlib/extension-site-packages.zip. Python's
    zipimport can resolve subpaths inside zip files (e.g. opening a
    zipimporter at `/stdlib/site-packages.zip/click` works), so rewriting
    the path makes `import click.testing` succeed.

    Without this, every preimported package looks fully loaded but any
    submodule that wasn't itself preimported fails with
    `ModuleNotFoundError`.
    """
    import sys
    SP = "/stdlib/site-packages.zip"
    EXT = "/stdlib/extension-site-packages.zip"
    for mod in list(sys.modules.values()):
        path_attr = getattr(mod, "__path__", None)
        if not path_attr:
            continue
        try:
            entries = list(path_attr)
        except TypeError:
            continue
        new_entries = []
        changed = False
        for entry in entries:
            if isinstance(entry, str):
                if entry.startswith("/wizer-ext-sp/"):
                    new_entries.append(EXT + "/" + entry[len("/wizer-ext-sp/"):])
                    changed = True
                    continue
                if entry == "/wizer-ext-sp":
                    new_entries.append(EXT)
                    changed = True
                    continue
                if entry.startswith("/wizer-sp/"):
                    new_entries.append(SP + "/" + entry[len("/wizer-sp/"):])
                    changed = True
                    continue
                if entry == "/wizer-sp":
                    new_entries.append(SP)
                    changed = True
                    continue
            new_entries.append(entry)
        if changed:
            try:
                mod.__path__ = new_entries
            except (AttributeError, TypeError):
                pass


# intentionally not called: see pymode._path_fixup preimport in pymode_wizer.c
del _rewrite_wizer_package_paths
