#!/usr/bin/env python3
"""Bundle pure Python packages from PyPI into a site-packages.zip.

Downloads wheel files from PyPI, extracts .py files, and creates a zip
archive that Python's built-in zipimport can load directly.

Usage:
    python3 scripts/bundle-packages.py requirements.txt
    python3 scripts/bundle-packages.py click==8.1.7 jinja2 requests

The output zip is placed at worker/src/site-packages.zip and can be
loaded by adding it to PYTHONPATH.
"""

import argparse
import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile


def get_pypi_wheel_url(package_spec: str) -> tuple[str, str]:
    """Fetch the best wheel URL from PyPI for a package.

    Returns (url, filename).
    """
    # Parse name and optional version
    if "==" in package_spec:
        name, version = package_spec.split("==", 1)
    else:
        name = package_spec
        version = None

    # Query PyPI JSON API
    if version:
        api_url = f"https://pypi.org/pypi/{name}/{version}/json"
    else:
        api_url = f"https://pypi.org/pypi/{name}/json"

    with urllib.request.urlopen(api_url) as resp:
        data = json.loads(resp.read())

    # Find a pure Python wheel (py3-none-any or py2.py3-none-any)
    urls = data["urls"]
    for entry in urls:
        if entry["packagetype"] == "bdist_wheel":
            fname = entry["filename"]
            if "none-any" in fname:
                return entry["url"], fname

    # Fall back to any wheel
    for entry in urls:
        if entry["packagetype"] == "bdist_wheel":
            return entry["url"], entry["filename"]

    # Fall back to sdist (can't use these directly, but report it)
    raise ValueError(
        f"No wheel found for {package_spec}. "
        f"Available: {[u['packagetype'] for u in urls]}"
    )


def extract_py_from_wheel(wheel_data: bytes) -> list[tuple[str, bytes]]:
    """Extract .py files from a wheel archive.

    Returns list of (path, content) tuples.
    """
    files = []
    with zipfile.ZipFile(io.BytesIO(wheel_data)) as whl:
        for name in whl.namelist():
            # Skip .dist-info metadata
            if ".dist-info/" in name:
                continue
            # Skip compiled extensions
            if name.endswith((".so", ".pyd", ".dll", ".dylib")):
                continue
            # Skip __pycache__
            if "__pycache__/" in name:
                continue
            # Include .py files and data files packages need
            if name.endswith((".py", ".pyi", ".typed", ".txt", ".cfg", ".ini", ".json", ".toml")):
                files.append((name, whl.read(name)))
            # Include __init__.py marker directories (package data)
            elif name.endswith("/"):
                continue
    return files


def parse_requirements(path: str) -> list[str]:
    """Parse a requirements.txt file into package specs."""
    packages = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            # Strip extras, environment markers
            spec = line.split(";")[0].strip()
            if spec:
                packages.append(spec)
    return packages


def main():
    parser = argparse.ArgumentParser(description="Bundle Python packages for PyMode")
    parser.add_argument("packages", nargs="+",
                        help="Package specs (click==8.1.7) or requirements.txt files")
    parser.add_argument("-o", "--output", default=None,
                        help="Output zip path (default: worker/src/site-packages.zip)")
    args = parser.parse_args()

    # Resolve output path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(script_dir)
    output = args.output or os.path.join(root_dir, "worker", "src", "site-packages.zip")

    # Collect all package specs
    all_packages = []
    for pkg in args.packages:
        if os.path.isfile(pkg) and pkg.endswith(".txt"):
            all_packages.extend(parse_requirements(pkg))
        else:
            all_packages.append(pkg)

    print(f"Bundling {len(all_packages)} packages...")

    # Download and extract each package
    all_files: dict[str, bytes] = {}
    for spec in all_packages:
        try:
            url, fname = get_pypi_wheel_url(spec)
            print(f"  {spec} -> {fname}")
            with urllib.request.urlopen(url) as resp:
                wheel_data = resp.read()
            files = extract_py_from_wheel(wheel_data)
            for path, content in files:
                all_files[path] = content
            print(f"    {len(files)} files extracted")
        except Exception as e:
            print(f"  ERROR: {spec}: {e}", file=sys.stderr)
            sys.exit(1)

    # Create the zip
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path, content in sorted(all_files.items()):
            zf.writestr(path, content)

    size_kb = os.path.getsize(output) // 1024
    print(f"\nCreated {output}")
    print(f"  {len(all_files)} files, {size_kb}KB compressed")
    print(f"\nTo use: add site-packages.zip to PYTHONPATH in worker.ts")


if __name__ == "__main__":
    main()
