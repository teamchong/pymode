#!/usr/bin/env python3
"""pymode install — package manager for PyMode Workers.

Resolves Python packages from PyPI, classifies them (pure Python vs
C extension), and bundles them for deployment on Cloudflare Workers.

Pure Python packages are bundled into site-packages.zip.
C extensions are compiled to .wasm side modules via zig cc.
Packages too large for a single worker are flagged for Service Bindings.

Usage:
    python3 scripts/pymode-install.py jinja2 click pyyaml
    python3 scripts/pymode-install.py -r requirements.txt
    python3 scripts/pymode-install.py --from-pyproject ./my-project

Output:
    worker/src/site-packages.zip     — pure Python packages
    .pymode/extensions/<pkg>/*.wasm  — C extension side modules
    .pymode/install.json             — install manifest
"""

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Max compressed size for a single worker (10MB). We reserve ~3MB for
# python.wasm + stdlib + pymode runtime, leaving ~7MB for user code + packages.
WORKER_BUDGET_BYTES = 7 * 1024 * 1024

# C extension file suffixes found in wheels
NATIVE_SUFFIXES = (".so", ".pyd", ".dll", ".dylib")

# Known pure-Python packages that ship with C speedups but have Python fallbacks
PURE_PYTHON_FALLBACKS = {
    "markupsafe",      # _speedups.c → has pure Python fallback
    "pyyaml",          # _yaml.c → yaml.loader works without it
    "simplejson",      # _speedups.c → falls back to pure Python
    "msgpack",         # _cmsgpack.c → has fallback
    "charset-normalizer",
    "multidict",
    "yarl",
    "frozenlist",
    "aiohttp",
}

# Packages too large for inline bundling — need C extensions compiled to .wasm
NEEDS_SEPARATE_WORKER = {
    "numpy", "pandas", "scipy", "scikit-learn", "sklearn",
    "matplotlib", "pillow", "opencv-python", "tensorflow",
    "torch", "pytorch", "transformers",
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class PackageInfo:
    name: str
    version: str
    wheel_url: str
    wheel_filename: str
    is_pure_python: bool
    has_native_ext: bool
    native_files: list[str] = field(default_factory=list)
    python_files: list[str] = field(default_factory=list)
    data_files: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    size_bytes: int = 0


@dataclass
class InstallResult:
    pure_python: list[PackageInfo] = field(default_factory=list)
    c_extensions: list[PackageInfo] = field(default_factory=list)
    needs_separate_worker: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    site_packages_size: int = 0
    extensions_size: int = 0


# ---------------------------------------------------------------------------
# PyPI client
# ---------------------------------------------------------------------------

def fetch_pypi_metadata(package_spec: str) -> dict:
    """Fetch package metadata from PyPI JSON API."""
    if "==" in package_spec:
        name, version = package_spec.split("==", 1)
        api_url = f"https://pypi.org/pypi/{name}/{version}/json"
    else:
        name = re.split(r"[<>=!~]", package_spec)[0].strip()
        api_url = f"https://pypi.org/pypi/{name}/json"

    try:
        with urllib.request.urlopen(api_url, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise ValueError(f"Package '{name}' not found on PyPI")
        raise


def select_wheel(pypi_data: dict) -> tuple[str, str, str]:
    """Select the best wheel for PyMode (prefer pure Python).

    Returns (url, filename, version).
    """
    version = pypi_data["info"]["version"]
    urls = pypi_data["urls"]

    # Priority 1: Pure Python wheel (py3-none-any)
    for entry in urls:
        if entry["packagetype"] == "bdist_wheel":
            fname = entry["filename"]
            if "none-any" in fname:
                return entry["url"], fname, version

    # Priority 2: Any wheel
    for entry in urls:
        if entry["packagetype"] == "bdist_wheel":
            return entry["url"], entry["filename"], version

    # Priority 3: sdist (for C extension compilation)
    for entry in urls:
        if entry["packagetype"] == "sdist":
            return entry["url"], entry["filename"], version

    raise ValueError(f"No downloadable distribution found for {pypi_data['info']['name']}")


def get_dependencies(pypi_data: dict) -> list[str]:
    """Extract non-optional dependencies from PyPI metadata."""
    deps = []
    requires_dist = pypi_data["info"].get("requires_dist") or []
    for dep in requires_dist:
        # Skip optional/extra dependencies
        if "extra ==" in dep:
            continue
        # Skip platform-specific deps with complex markers
        if "; " in dep:
            marker = dep.split(";", 1)[1].strip()
            # Keep only universal deps and common platform markers
            if "extra" in marker:
                continue
        # Extract just the package name
        name = re.split(r"[<>=!~;\s\[]", dep)[0].strip()
        if name:
            deps.append(name.lower())
    return deps


# ---------------------------------------------------------------------------
# Wheel analysis
# ---------------------------------------------------------------------------

def analyze_wheel(wheel_data: bytes, filename: str) -> tuple[list[str], list[str], list[str]]:
    """Analyze a wheel's contents.

    Returns (python_files, native_files, data_files).
    """
    python_files = []
    native_files = []
    data_files = []

    with zipfile.ZipFile(io.BytesIO(wheel_data)) as whl:
        for name in whl.namelist():
            if ".dist-info/" in name:
                continue
            if "__pycache__/" in name:
                continue
            if name.endswith("/"):
                continue

            if any(name.endswith(s) for s in NATIVE_SUFFIXES):
                native_files.append(name)
            elif name.endswith((".py", ".pyi")):
                python_files.append(name)
            elif name.endswith((".typed", ".txt", ".cfg", ".ini", ".json", ".toml", ".yaml", ".yml")):
                data_files.append(name)

    return python_files, native_files, data_files


def extract_python_files(wheel_data: bytes) -> list[tuple[str, bytes]]:
    """Extract .py and data files from a wheel (skip native extensions)."""
    files = []
    with zipfile.ZipFile(io.BytesIO(wheel_data)) as whl:
        for name in whl.namelist():
            if ".dist-info/" in name:
                continue
            if "__pycache__/" in name:
                continue
            if name.endswith("/"):
                continue
            if any(name.endswith(s) for s in NATIVE_SUFFIXES):
                continue
            if name.endswith((".py", ".pyi", ".typed", ".txt", ".cfg",
                              ".ini", ".json", ".toml", ".yaml", ".yml")):
                files.append((name, whl.read(name)))
    return files


# ---------------------------------------------------------------------------
# Dependency resolution (breadth-first with cycle detection)
# ---------------------------------------------------------------------------

def resolve_dependencies(initial_specs: list[str], max_depth: int = 5) -> list[str]:
    """Resolve package dependencies breadth-first.

    Returns a list of all package specs to install (including transitive deps).
    """
    resolved = {}  # name -> spec
    queue = list(initial_specs)
    seen = set()
    depth = 0

    while queue and depth < max_depth:
        next_queue = []
        for spec in queue:
            name = re.split(r"[<>=!~\[]", spec)[0].strip().lower()
            if name in seen:
                continue
            seen.add(name)

            try:
                pypi_data = fetch_pypi_metadata(spec)
                resolved[name] = spec
                deps = get_dependencies(pypi_data)
                for dep in deps:
                    if dep not in seen:
                        next_queue.append(dep)
            except Exception as e:
                print(f"  Warning: Could not resolve {spec}: {e}", file=sys.stderr)

        queue = next_queue
        depth += 1

    return list(resolved.values())


# ---------------------------------------------------------------------------
# C extension compilation
# ---------------------------------------------------------------------------

def compile_c_extension(pkg_name: str, wheel_data: bytes, root_dir: Path) -> Path | None:
    """Attempt to compile C extensions from a wheel to .wasm side modules.

    Returns the extensions directory path, or None if compilation failed.
    """
    ext_dir = root_dir / ".pymode" / "extensions" / pkg_name
    ext_dir.mkdir(parents=True, exist_ok=True)

    cpython_dir = root_dir / "cpython"
    build_dir = root_dir / "build" / "zig-wasi"

    if not (cpython_dir / "Include").exists():
        print(f"    Skipping C compilation: cpython/Include not found")
        return None

    if not (build_dir / "pyconfig.h").exists():
        print(f"    Skipping C compilation: build/zig-wasi/pyconfig.h not found")
        return None

    if not shutil.which("zig"):
        print(f"    Skipping C compilation: zig not found")
        return None

    # Extract wheel to temp dir
    with tempfile.TemporaryDirectory() as tmpdir:
        with zipfile.ZipFile(io.BytesIO(wheel_data)) as whl:
            whl.extractall(tmpdir)

        # Find .c files
        c_files = list(Path(tmpdir).rglob("*.c"))
        if not c_files:
            print(f"    No .c files found in wheel")
            return None

        # Compile each .c file
        for c_file in c_files:
            obj_file = ext_dir / (c_file.stem + ".o")
            print(f"    Compiling {c_file.name}...")

            result = subprocess.run(
                [
                    "zig", "cc",
                    "-target", "wasm32-wasi",
                    "-Os", "-DNDEBUG",
                    f"-I{cpython_dir / 'Include'}",
                    f"-I{cpython_dir / 'Include' / 'internal'}",
                    f"-I{build_dir}",
                    "-Wno-error=int-conversion",
                    "-Wno-error=incompatible-pointer-types",
                    "-c", str(c_file),
                    "-o", str(obj_file),
                ],
                capture_output=True, text=True,
            )

            if result.returncode != 0:
                print(f"    Compile failed: {result.stderr[:200]}")
                return None

        # Link all objects into a single .wasm
        obj_files = list(ext_dir.glob("*.o"))
        if not obj_files:
            return None

        wasm_name = f"{pkg_name}.wasm"
        wasm_path = ext_dir / wasm_name
        print(f"    Linking -> {wasm_name}...")

        result = subprocess.run(
            [
                "zig", "cc",
                "-target", "wasm32-wasi",
                "-nostdlib", "-Os", "-s",
                "-Wl,--import-memory",
                "-Wl,--allow-undefined",
                "-Wl,--no-entry",
                "-Wl,--export-dynamic",
                *[str(o) for o in obj_files],
                "-o", str(wasm_path),
            ],
            capture_output=True, text=True,
        )

        # Clean up .o files
        for o in obj_files:
            o.unlink()

        if result.returncode != 0:
            print(f"    Link failed: {result.stderr[:200]}")
            return None

        size_kb = wasm_path.stat().st_size // 1024
        print(f"    Built: {wasm_path} ({size_kb}KB)")

    return ext_dir


# ---------------------------------------------------------------------------
# Input parsing
# ---------------------------------------------------------------------------

def parse_requirements_txt(path: str) -> list[str]:
    """Parse requirements.txt into package specs."""
    packages = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("-"):
                continue
            spec = line.split(";")[0].strip()
            if spec:
                packages.append(spec)
    return packages


def parse_pyproject_toml(project_dir: str) -> list[str]:
    """Extract dependencies from pyproject.toml."""
    try:
        import tomllib
    except ImportError:
        import tomli as tomllib  # type: ignore[no-redef]

    toml_path = os.path.join(project_dir, "pyproject.toml")
    if not os.path.exists(toml_path):
        raise FileNotFoundError(f"No pyproject.toml in {project_dir}")

    with open(toml_path, "rb") as f:
        data = tomllib.load(f)

    deps = data.get("project", {}).get("dependencies", [])
    # Also check [tool.pymode] dependencies
    pymode_deps = data.get("tool", {}).get("pymode", {}).get("dependencies", [])

    return list(deps) + list(pymode_deps)


# ---------------------------------------------------------------------------
# Main install logic
# ---------------------------------------------------------------------------

def install_packages(specs: list[str], root_dir: Path, resolve_deps: bool = True) -> InstallResult:
    """Install packages for PyMode deployment."""
    result = InstallResult()

    # Step 1: Resolve dependencies
    if resolve_deps and specs:
        print(f"\nResolving dependencies for {len(specs)} packages...")
        all_specs = resolve_dependencies(specs)
        print(f"  Resolved {len(all_specs)} packages (including dependencies)")
    else:
        all_specs = specs

    # Step 2: Download and classify each package
    all_py_files: dict[str, bytes] = {}
    total_uncompressed = 0

    for spec in all_specs:
        name = re.split(r"[<>=!~\[]", spec)[0].strip().lower()

        # Check if package needs a separate worker
        if name in NEEDS_SEPARATE_WORKER:
            print(f"  {name}: heavy C extension — needs .wasm compilation (zig cc) or child DO")
            result.needs_separate_worker.append(name)
            continue

        try:
            print(f"  {spec}...", end=" ", flush=True)
            pypi_data = fetch_pypi_metadata(spec)
            url, filename, version = select_wheel(pypi_data)
            print(f"-> {filename}")

            # Download wheel
            with urllib.request.urlopen(url, timeout=60) as resp:
                wheel_data = resp.read()

            # Analyze contents
            py_files, native_files, data_files = analyze_wheel(wheel_data, filename)
            deps = get_dependencies(pypi_data)

            pkg_info = PackageInfo(
                name=name,
                version=version,
                wheel_url=url,
                wheel_filename=filename,
                is_pure_python=len(native_files) == 0,
                has_native_ext=len(native_files) > 0,
                native_files=native_files,
                python_files=py_files,
                data_files=data_files,
                dependencies=deps,
                size_bytes=len(wheel_data),
            )

            if native_files:
                # Has C extensions
                print(f"    C extensions: {', '.join(native_files[:3])}")

                if name in PURE_PYTHON_FALLBACKS:
                    # Extract only Python files, skip native
                    print(f"    Using pure Python fallback (skipping C speedups)")
                    extracted = extract_python_files(wheel_data)
                    for path, content in extracted:
                        all_py_files[path] = content
                        total_uncompressed += len(content)
                    result.pure_python.append(pkg_info)
                else:
                    # Try to compile C extension to WASM
                    print(f"    Attempting C -> WASM compilation...")
                    ext_dir = compile_c_extension(name, wheel_data, root_dir)
                    if ext_dir:
                        result.c_extensions.append(pkg_info)
                    else:
                        # Fall back to Python files only
                        print(f"    C compilation failed, extracting Python files only")
                        result.pure_python.append(pkg_info)

                    # Always extract Python files alongside extensions
                    extracted = extract_python_files(wheel_data)
                    for path, content in extracted:
                        all_py_files[path] = content
                        total_uncompressed += len(content)
            else:
                # Pure Python — extract everything
                extracted = extract_python_files(wheel_data)
                for path, content in extracted:
                    all_py_files[path] = content
                    total_uncompressed += len(content)
                result.pure_python.append(pkg_info)

        except Exception as e:
            print(f"FAILED: {e}")
            result.failed.append((spec, str(e)))

    # Step 3: Create site-packages.zip
    if all_py_files:
        output = root_dir / "worker" / "src" / "site-packages.zip"
        output.parent.mkdir(parents=True, exist_ok=True)

        # Use ZIP_STORED (no compression) because CPython's zipimport
        # needs zlib to decompress, and zlib is disabled in our WASM build.
        # The worker's gzip transport compression handles size reduction.
        with zipfile.ZipFile(str(output), "w", zipfile.ZIP_STORED) as zf:
            for path, content in sorted(all_py_files.items()):
                zf.writestr(path, content)

        result.site_packages_size = output.stat().st_size
        print(f"\nCreated {output}")
        print(f"  {len(all_py_files)} files, {result.site_packages_size // 1024}KB compressed")
        print(f"  {total_uncompressed // 1024}KB uncompressed")

    # Step 4: Check size budget
    if result.site_packages_size > WORKER_BUDGET_BYTES:
        print(f"\n  WARNING: site-packages.zip ({result.site_packages_size // 1024}KB) "
              f"exceeds budget ({WORKER_BUDGET_BYTES // 1024}KB)")
        print(f"  Consider splitting large packages into separate workers via Service Bindings")

    # Step 5: Write install manifest
    manifest = {
        "packages": {
            "pure_python": [
                {"name": p.name, "version": p.version, "files": len(p.python_files)}
                for p in result.pure_python
            ],
            "c_extensions": [
                {"name": p.name, "version": p.version, "native_files": p.native_files}
                for p in result.c_extensions
            ],
            "needs_separate_worker": result.needs_separate_worker,
            "failed": [{"spec": s, "error": e} for s, e in result.failed],
        },
        "site_packages_size_kb": result.site_packages_size // 1024,
    }

    manifest_dir = root_dir / ".pymode"
    manifest_dir.mkdir(exist_ok=True)
    manifest_path = manifest_dir / "install.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest: {manifest_path}")

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        prog="pymode install",
        description="Install Python packages for PyMode Workers deployment",
    )
    parser.add_argument(
        "packages", nargs="*",
        help="Package specs: jinja2, click==8.1.7, etc.",
    )
    parser.add_argument(
        "-r", "--requirements",
        help="Path to requirements.txt",
    )
    parser.add_argument(
        "--from-pyproject",
        help="Path to project directory with pyproject.toml",
    )
    parser.add_argument(
        "--no-deps", action="store_true",
        help="Don't resolve transitive dependencies",
    )
    parser.add_argument(
        "--root", default=None,
        help="PyMode root directory (default: auto-detect)",
    )
    args = parser.parse_args()

    # Detect root dir
    if args.root:
        root_dir = Path(args.root)
    else:
        # Walk up from script location to find wrangler.toml
        script_dir = Path(__file__).resolve().parent
        root_dir = script_dir.parent
        if not (root_dir / "worker" / "wrangler.toml").exists():
            root_dir = Path.cwd()

    # Collect package specs
    all_specs = list(args.packages or [])

    if args.requirements:
        all_specs.extend(parse_requirements_txt(args.requirements))

    if args.from_pyproject:
        try:
            all_specs.extend(parse_pyproject_toml(args.from_pyproject))
        except Exception as e:
            print(f"Error reading pyproject.toml: {e}", file=sys.stderr)
            sys.exit(1)

    if not all_specs:
        parser.print_help()
        sys.exit(1)

    print(f"PyMode Install")
    print(f"  Root: {root_dir}")
    print(f"  Packages: {', '.join(all_specs)}")

    result = install_packages(all_specs, root_dir, resolve_deps=not args.no_deps)

    # Summary
    print(f"\n{'='*60}")
    print(f"Install Summary")
    print(f"{'='*60}")
    print(f"  Pure Python:  {len(result.pure_python)} packages -> site-packages.zip")
    if result.c_extensions:
        print(f"  C Extensions: {len(result.c_extensions)} packages -> .pymode/extensions/")
    if result.needs_separate_worker:
        print(f"  Heavy (need separate worker): {', '.join(result.needs_separate_worker)}")
    if result.failed:
        print(f"  Failed: {len(result.failed)}")
        for spec, err in result.failed:
            print(f"    {spec}: {err}")

    if result.needs_separate_worker:
        print(f"\n  Heavy packages need C extensions compiled to .wasm via zig cc.")
        print(f"  Or run them in a child DO via pymode.parallel.spawn():")
        print(f"  [[services]]")
        print(f"  binding = \"COMPUTE\"")
        print(f"  service = \"compute-worker\"")

    print(f"\n  Next: cd worker && npx wrangler deploy")

    sys.exit(1 if result.failed else 0)


if __name__ == "__main__":
    main()
