// Pillow integration tests — requires python-pillow.wasm variant.
// Excluded from default test suite until variant test configs are set up.

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

describe("pillow", () => {
  it("should check PIL availability", async () => {
    const { text, status } = await runPython(`
try:
    from PIL import Image
    print("ok=True")
except ImportError as e:
    print("ok=False")
    print(f"error={e}")
`);
    expect(status).toBe(200);
  });
});
