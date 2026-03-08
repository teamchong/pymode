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

// Optional: extension site-packages (e.g. numpy Python layer).
// Loaded once at module scope, shared across all consumers.
export let extensionPackagesBin: Uint8Array | undefined;
try {
  // @ts-ignore — conditional import, only present for extension variants
  extensionPackagesBin = new Uint8Array(require("./extension-site-packages.zip"));
} catch {
  // No extension packages
}
