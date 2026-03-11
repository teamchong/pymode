// Shared pre-encoded stdlib — imported by worker.ts, python-do.ts, and thread-do.ts.
// JS module cache ensures this runs once per isolate, not per-importer.

import { stdlibFS } from "./stdlib-fs";
import { buildDirIndex } from "./wasi";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export const stdlibBin: Record<string, Uint8Array> = {};
for (const [path, content] of Object.entries(stdlibFS)) {
  stdlibBin[path] = encoder.encode(content);
}

export const stdlibDirIndex = buildDirIndex(stdlibBin);

// Extension site-packages (e.g. numpy Python layer).
// Loaded as Data module; generate-stdlib-fs.ts creates an empty zip if absent.
// @ts-ignore — Data module import (ArrayBuffer)
import extensionZip from "./extension-site-packages.zip";
export const extensionPackagesBin: Uint8Array | undefined =
  extensionZip.byteLength > 22 ? new Uint8Array(extensionZip) : undefined;
