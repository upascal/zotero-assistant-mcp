import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 60000,
    sequence: { concurrent: false },
    include: ["tests/integration/**/*.test.ts"],
  },
});
