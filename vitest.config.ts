import { defineConfig } from "vitest/config";

// Integration tests run against built artifacts as real processes (DEV §8.3); they never use
// the owner's data and start isolated servers on ephemeral ports.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
