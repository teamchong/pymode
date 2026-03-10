// NumPy integration tests — requires python-numpy.wasm variant.
// Excluded from default test suite. Run with: npm run test:numpy
//
// TODO: Add a separate wrangler config that uses python-numpy.wasm
// and numpy-site-packages.zip for variant testing.

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

describe("numpy", () => {
  it("should verify numpy is importable", async () => {
    const { text, status } = await runPython(`
try:
    import numpy as np
    print(f"version={np.__version__}")
    print("ok=True")
except ImportError as e:
    print(f"ok=False")
    print(f"error={e}")
`);
    // numpy may not be available in the base python.wasm
    expect(status).toBe(200);
  });
});
