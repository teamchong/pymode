// Shared pre-encoded stdlib — imported by worker.ts, python-do.ts, and thread-do.ts.
// JS module cache ensures this runs once per isolate, not per-importer.

import { getStdlibFS } from "./stdlib-fs";
import { buildDirIndex } from "./wasi";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

interface AssetsBinding {
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// stdlibBin is filled lazily from the gzip-decompressed stdlib-data.dat.
// CF Workers disallows async I/O in global scope (decompression triggers
// it), so callers must await getStdlibBin() before reading stdlibBin /
// stdlibDirIndex. Once warmed, subsequent calls return synchronously.
export const stdlibBin: Record<string, Uint8Array> = {};
export let stdlibDirIndex: ReturnType<typeof buildDirIndex>;

let _warmPromise: Promise<void> | null = null;

export function getStdlibBin(env?: AssetsBinding): Promise<void> {
  if (!_warmPromise) {
    _warmPromise = (async () => {
      const fs = await getStdlibFS(env);
      for (const [p, content] of Object.entries(fs)) {
        stdlibBin[p] = encoder.encode(content);
      }
      stdlibDirIndex = buildDirIndex(stdlibBin);
    })();
  }
  return _warmPromise;
}

// ── Shared zip-asset fetcher ────────────────────────────────────────
//
// User PyPI deps (site-packages.zip), variant-extension Python layers
// (extension-site-packages.zip), and any future zip-shaped asset all
// follow the same pattern: stage to docs/dist/_pymode/<name>.gz at
// deploy time, fetch + gunzip lazily on first request, cache at module
// scope. The in-bundle copy is a 22-byte empty-zip stub so wrangler's
// Data import resolves without contributing meaningful bytes.

async function _fetchGzippedZip(
  env: AssetsBinding,
  assetPath: string,
): Promise<Uint8Array | undefined> {
  if (!env.ASSETS) return undefined;
  const resp = await env.ASSETS.fetch(
    new Request(`https://pymode.internal${assetPath}`),
  );
  if (!resp.ok) return undefined;
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("text/html")) return undefined; // SPA fallback
  try {
    const stream = resp.body!.pipeThrough(new DecompressionStream("gzip"));
    const bytes = await new Response(stream).arrayBuffer();
    if (bytes.byteLength <= 22) return undefined;
    // Sniff: real zip ends in EOCD (50 4b 05 06).
    const view = new Uint8Array(bytes);
    for (let i = view.length - 22; i >= Math.max(0, view.length - 65558); i--) {
      if (view[i] === 0x50 && view[i + 1] === 0x4b && view[i + 2] === 0x05 && view[i + 3] === 0x06) {
        return view;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Extension site-packages (numpy / pandas / pillow Python layer) ──
// @ts-ignore — Data module import (ArrayBuffer)
import extensionZip from "./extension-site-packages.zip";
const _inBundleExt: Uint8Array | undefined =
  extensionZip.byteLength > 22 ? new Uint8Array(extensionZip) : undefined;

const _extHolder: { value: Uint8Array | undefined } = { value: _inBundleExt };

export function getExtensionPackagesBin(): Uint8Array | undefined {
  return _extHolder.value;
}

// Back-compat: existing call sites read the live binding directly.
export let extensionPackagesBin: Uint8Array | undefined = _inBundleExt;

let _extPromise: Promise<void> | null = null;
export function warmExtensionPackages(env?: AssetsBinding): Promise<void> {
  if (!_extPromise) {
    _extPromise = (async () => {
      if (_inBundleExt || !env) return;
      const view = await _fetchGzippedZip(env, "/_pymode/extension-site-packages.zip.gz");
      if (view) {
        _extHolder.value = view;
        extensionPackagesBin = view;
      }
    })();
  }
  return _extPromise;
}

// ── User site-packages (their PyPI deps from `pymode install`) ──────
// @ts-ignore — Data module import (ArrayBuffer)
import sitePackagesZip from "./site-packages.zip";
const _inBundleSp: Uint8Array | undefined =
  sitePackagesZip.byteLength > 22 ? new Uint8Array(sitePackagesZip) : undefined;

const _spHolder: { value: Uint8Array | undefined } = { value: _inBundleSp };

export function getSitePackagesBin(): Uint8Array | undefined {
  return _spHolder.value;
}

let _spPromise: Promise<void> | null = null;
export function warmSitePackages(env?: AssetsBinding): Promise<void> {
  if (!_spPromise) {
    _spPromise = (async () => {
      if (_inBundleSp || !env) return;
      const view = await _fetchGzippedZip(env, "/_pymode/site-packages.zip.gz");
      if (view) _spHolder.value = view;
    })();
  }
  return _spPromise;
}
