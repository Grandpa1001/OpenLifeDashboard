import { defineConfig } from "vitest/config";

// Unit tests cover pure rules; integration tests run built artifacts as real processes
// (DEV §8.3). None uses the owner's data; servers start isolated on ephemeral ports.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
