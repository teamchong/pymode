/**
 * Vitest global setup — bundles test project and starts wrangler dev.
 *
 * Flow:
 *   1. npx tsx scripts/bundle-project.ts test/test-project → generates worker/src/user-files.ts
 *   2. wrangler dev --config test/wrangler.toml --port 8787 → starts the real worker + DOs
 *   3. Wait for ready (GET / returns 200)
 *   4. Tests run against http://localhost:8787
 *   5. Teardown kills wrangler
 */

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PYMODE_PORT || "8787";

let wranglerProcess: ReturnType<typeof spawn> | null = null;

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      lastStatus = resp.status;
      lastBody = await resp.text();
      if (resp.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `wrangler dev did not become ready within ${timeoutMs}ms` +
    ` (last status=${lastStatus}, body=${lastBody.substring(0, 200)})`
  );
}

export async function setup(): Promise<void> {
  // 1. Bundle test project → worker/src/user-files.ts
  console.log("[test:setup] Bundling test project...");
  const bundle = spawnSync(
    "npx",
    ["tsx", "scripts/bundle-project.ts", "test/test-project"],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (bundle.status !== 0) {
    throw new Error("Failed to bundle test project");
  }

  // 2. Start wrangler dev
  console.log("[test:setup] Starting wrangler dev...");
  wranglerProcess = spawn(
    "npx",
    ["wrangler", "dev", "--config", "test/wrangler.toml", "--port", PORT, "--local"],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_ENV: "test" },
    }
  );

  // Forward stderr so we can debug issues
  wranglerProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[wrangler] ${line}`);
  });

  wranglerProcess.on("error", (err) => {
    console.error("[wrangler] process error:", err);
  });

  // 3. Wait for ready
  console.log(`[test:setup] Waiting for http://localhost:${PORT}...`);
  await waitForReady(`http://localhost:${PORT}`, 60_000);
  console.log("[test:setup] Worker ready.");
}

export async function teardown(): Promise<void> {
  if (wranglerProcess) {
    console.log("[test:teardown] Stopping wrangler dev...");
    wranglerProcess.kill("SIGTERM");
    wranglerProcess = null;
  }
}
