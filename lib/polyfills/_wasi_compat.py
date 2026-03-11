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
# MetadataPathFinder can't look inside zips via the WASI VFS (zipfile.ZipFile
# re-open fails). Use zipimport.zipimporter which already loaded these zips.
def _install_zip_metadata_finder():
    import importlib.metadata as metadata
    import zipimport
    import pathlib
    import os

    def _normalize(name):
        return name.lower().replace("-", "_").replace(".", "_")

    class ZipDistribution(metadata.Distribution):
        def __init__(self, importer, dist_dir):
            self._importer = importer
            self._dist_dir = dist_dir  # relative path, e.g. "pydantic-2.10.dist-info"

        def read_text(self, filename):
            # _get_files() keys are relative paths within the zip
            rel_path = self._dist_dir + "/" + filename
            try:
                return self._importer.get_data(rel_path).decode("utf-8", errors="replace")
            except (OSError, IOError):
                return None

        def locate_file(self, path):
            return pathlib.PurePosixPath(path)

    class ZipMetadataFinder(metadata.DistributionFinder):
        """Finds package metadata inside zip files on sys.path.

        Uses zipimport.zipimporter (already loaded by Python for module imports)
        instead of zipfile.ZipFile (which requires re-opening the file via VFS).
        """

        @classmethod
        def find_distributions(cls, context=metadata.DistributionFinder.Context()):
            name = getattr(context, "name", None)
            for path_entry in sys.path:
                if not path_entry.endswith(".zip"):
                    continue
                # Get the zipimporter from cache (Python already created one for imports)
                importer = sys.path_importer_cache.get(path_entry)
                if importer is None:
                    try:
                        importer = zipimport.zipimporter(path_entry)
                    except (OSError, zipimport.ZipImportError):
                        continue
                if not isinstance(importer, zipimport.zipimporter):
                    continue
                # _get_files() returns dict with RELATIVE path keys
                # (e.g. "pydantic/__init__.py", "pydantic-2.10.dist-info/METADATA")
                try:
                    zip_files = importer._get_files()
                except (AttributeError, Exception):
                    continue
                dist_dirs = set()
                for fpath in zip_files:
                    if ".dist-info/" in fpath:
                        dist_dir = fpath.split(".dist-info/")[0] + ".dist-info"
                        dist_dirs.add(dist_dir)
                for dist_dir in sorted(dist_dirs):
                    meta_rel = dist_dir + "/METADATA"
                    if meta_rel not in zip_files:
                        continue
                    if name:
                        try:
                            meta = importer.get_data(meta_rel).decode("utf-8", errors="replace")
                        except (OSError, IOError):
                            continue
                        pkg_name = None
                        for line in meta.splitlines():
                            if line.startswith("Name:"):
                                pkg_name = line.split(":", 1)[1].strip()
                                break
                        if pkg_name and _normalize(name) != _normalize(pkg_name):
                            continue
                    yield ZipDistribution(importer, dist_dir)

    sys.meta_path.append(ZipMetadataFinder)

_install_zip_metadata_finder()
del _install_zip_metadata_finder
