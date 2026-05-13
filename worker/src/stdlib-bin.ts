// Shared pre-encoded stdlib — imported by worker.ts, python-do.ts, and thread-do.ts.
// JS module cache ensures this runs once per isolate, not per-importer.

import { getStdlibFS } from "./stdlib-fs";
import { buildDirIndex } from "./wasi";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

interface AssetsBinding {
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// stdlibBin is filled lazily from the brotli-decompressed stdlib-data.dat.
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

// Extension site-packages (e.g. numpy / pandas Python layer).
// At deploy time deploy.js copies the real zip into docs/dist/_pymode/
// extension-site-packages.zip.gz and stubs the in-bundle one with an empty
// EOCD-only zip so we don't bundle ~10 MB into the worker script.
// @ts-ignore — Data module import (ArrayBuffer)
import extensionZip from "./extension-site-packages.zip";
const _inBundleExt: Uint8Array | undefined =
  extensionZip.byteLength > 22 ? new Uint8Array(extensionZip) : undefined;

// Holder — mutated by warmExtensionPackages. We return the holder from a
// getter so callers see updates even if they imported the binding before
// the warm step finished. (ES module `let` exports are live bindings, but
// TypeScript bundlers / esbuild can sometimes capture the initial value
// when re-exporting; a function is the unambiguous path.)
const _holder: { value: Uint8Array | undefined } = { value: _inBundleExt };

export function getExtensionPackagesBin(): Uint8Array | undefined {
  return _holder.value;
}

// Back-compat: the existing call sites consult the export directly. Keep
// it as a live `let` for them.
export let extensionPackagesBin: Uint8Array | undefined = _inBundleExt;

let _extWarmed = false;
let _extPromise: Promise<void> | null = null;

export function warmExtensionPackages(env?: AssetsBinding): Promise<void> {
  if (_extWarmed) return Promise.resolve();
  if (!_extPromise) {
    _extPromise = (async () => {
      _extWarmed = true;
      // If wrangler-time bundling already gave us the real zip (legacy /
      // local dev), keep it.
      if (_inBundleExt) return;
      // Otherwise fetch from the ASSETS binding. The asset is gzipped to
      // stay under wrangler's 25-MiB-per-asset cap. For variants without
      // python packages (e.g. ujson) the asset doesn't exist — the SPA
      // fallback returns index.html, which is not gzip and would throw
      // "Decompression failed". Sniff the content type / response first.
      if (!env?.ASSETS) return;
      const resp = await env.ASSETS.fetch(
        new Request("https://pymode.internal/_pymode/extension-site-packages.zip.gz"),
      );
      if (!resp.ok) return;
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html")) return; // SPA fallback
      try {
        const stream = resp.body!.pipeThrough(new DecompressionStream("gzip"));
        const bytes = await new Response(stream).arrayBuffer();
        if (bytes.byteLength <= 22) return;
        // Sniff: real zip ends in EOCD (50 4b 05 06).
        const view = new Uint8Array(bytes);
        let hasEOCD = false;
        for (let i = view.length - 22; i >= Math.max(0, view.length - 65558); i--) {
          if (view[i] === 0x50 && view[i + 1] === 0x4b && view[i + 2] === 0x05 && view[i + 3] === 0x06) {
            hasEOCD = true;
            break;
          }
        }
        if (!hasEOCD) return;
        _holder.value = view;
        extensionPackagesBin = view;
      } catch {
        // Decompression failed — likely the SPA fallback HTML. Leave
        // extensionPackagesBin undefined; pure-Python variants don't need it.
      }
    })();
  }
  return _extPromise;
}
