"""PyMode on-demand package importer via the fetch trampoline.

When a package is not found locally, this importer fetches it from a
configured package index (CF R2 bucket or PyPI) via the trampoline.

Usage:
    import pymode.importer
    pymode.importer.install("https://your-r2-bucket.example.com/packages")

    # Now imports that aren't in the local VFS will be fetched on demand:
    import click  # fetched from R2 on first import, cached in VFS
"""

import importlib.abc
import importlib.util
import json
import os
import sys

import pymode.http


class RemotePackageFinder(importlib.abc.MetaPathFinder):
    """Finder that fetches packages from a remote URL via the trampoline.

    Packages are stored on the remote as:
        {base_url}/{package_name}/__init__.py
        {base_url}/{package_name}/module.py
        {base_url}/{package_name}/_manifest.json  (list of all files)

    The manifest is fetched first, then all files are fetched in one
    trampoline round (batched via the pending fetches mechanism).
    """

    def __init__(self, base_url: str, cache_dir: str = "/stdlib/tmp/_pymode_packages"):
        self.base_url = base_url.rstrip("/")
        self.cache_dir = cache_dir
        self._tried = set()  # avoid infinite loops

    def find_module(self, fullname, path=None):
        return self.find_spec(fullname, path)

    def find_spec(self, fullname, path, target=None):
        if fullname in self._tried:
            return None
        self._tried.add(fullname)

        # Check if already cached locally
        parts = fullname.split(".")
        pkg_path = os.path.join(self.cache_dir, *parts)

        # Package (directory with __init__.py)
        init_path = os.path.join(pkg_path, "__init__.py")
        if os.path.exists(init_path):
            return importlib.util.spec_from_file_location(
                fullname, init_path,
                submodule_search_locations=[pkg_path]
            )

        # Module (single .py file)
        mod_path = pkg_path + ".py"
        if os.path.exists(mod_path):
            return importlib.util.spec_from_file_location(fullname, mod_path)

        # Not cached — try to fetch the manifest
        top_level = parts[0]
        manifest_url = f"{self.base_url}/{top_level}/_manifest.json"

        try:
            resp = pymode.http.fetch(manifest_url)
            if resp.status != 200:
                return None

            manifest = json.loads(resp.read())
            files = manifest.get("files", [])

            if not files:
                return None

            # Fetch all files (they'll be batched by the trampoline)
            for file_path in files:
                url = f"{self.base_url}/{top_level}/{file_path}"
                file_resp = pymode.http.fetch(url)
                if file_resp.status == 200:
                    local_path = os.path.join(self.cache_dir, top_level, file_path)
                    local_dir = os.path.dirname(local_path)
                    if not os.path.exists(local_dir):
                        os.makedirs(local_dir, exist_ok=True)
                    with open(local_path, "wb") as f:
                        f.write(file_resp.read())

            # Now try to find the module again from cache
            self._tried.discard(fullname)
            if os.path.exists(init_path):
                return importlib.util.spec_from_file_location(
                    fullname, init_path,
                    submodule_search_locations=[pkg_path]
                )
            if os.path.exists(mod_path):
                return importlib.util.spec_from_file_location(fullname, mod_path)

        except SystemExit:
            # Trampoline exit — re-raise so the JS host catches it
            raise
        except Exception:
            pass

        return None


_installed = False


def install(base_url: str, cache_dir: str = "/stdlib/tmp/_pymode_packages"):
    """Install the remote package finder.

    Args:
        base_url: URL prefix for the package repository (R2 bucket, etc.)
        cache_dir: Local VFS directory for caching fetched packages
    """
    global _installed
    if _installed:
        return
    _installed = True

    finder = RemotePackageFinder(base_url, cache_dir)
    sys.meta_path.append(finder)
