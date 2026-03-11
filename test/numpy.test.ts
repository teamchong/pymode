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
    expect(status).toBe(200);
  });

  it("should create arrays and do basic operations", async () => {
    const { text, status } = await runPython(`
import numpy as np
a = np.array([1, 2, 3, 4, 5])
print(f"sum={int(np.sum(a))}")
print(f"mean={float(np.mean(a))}")
print(f"len={len(a)}")
`);
    expect(text + " [status=" + status + "]").toContain("sum=15");
    expect(text).toContain("mean=3.0");
    expect(text).toContain("len=5");
  });
});
