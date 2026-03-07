import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/pydantic.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./test/wrangler-pydantic.jsonc" },
      },
    },
  },
});
