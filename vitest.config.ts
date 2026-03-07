import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    exclude: [
      "test/pydantic.test.ts",
      "node_modules/**",
    ],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./test/wrangler.jsonc" },
      },
    },
  },
});
