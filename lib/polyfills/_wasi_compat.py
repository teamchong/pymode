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

    # Scan all zip paths eagerly (runs once at import time)
    for _path_entry in sys.path:
        if _path_entry.endswith(".zip"):
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
