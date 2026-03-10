import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    globalSetup: "./test/setup.ts",
    include: ["test/pydantic.test.ts", "test/langchain.test.ts", "test/langgraph.test.ts", "test/ai-libs.test.ts"],
  },
});
