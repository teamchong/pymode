// python.wasm loader.
//
// CF Workers requires wasm to be a CompiledWasm Module bundled by wrangler
// at deploy time — runtime WebAssembly.compile is disallowed by the embedder.
// So the wasm stays in the worker bundle; only the larger site-packages
// zips move to the ASSETS binding (see stdlib-bin.ts → warmExtensionPackages).

// @ts-ignore — CompiledWasm import
import pythonWasm from "./python.wasm";

interface AssetsBinding {
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
}

// Kept as an async-returning function to preserve the call-site shape we
// adopted when experimenting with off-bundle wasm; the env parameter is
// ignored now that the wasm is back in the bundle.
export function getPythonWasm(_env?: AssetsBinding): Promise<WebAssembly.Module> {
  return Promise.resolve(pythonWasm as WebAssembly.Module);
}
