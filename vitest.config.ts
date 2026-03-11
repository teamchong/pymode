import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    globalSetup: "./test/setup.ts",
    fileParallelism: false,
    exclude: [
      "**/node_modules/**",
    ],
  },
});
