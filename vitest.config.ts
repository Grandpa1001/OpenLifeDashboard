import { defineConfig } from "vitest/config";

// Unit tests cover pure rules; integration tests run built artifacts as real processes
// (DEV §8.3). None uses the owner's data; servers start isolated on ephemeral ports.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    // Removes the temporary folders of test helpers after each test file.
    setupFiles: ["tests/support/vitest-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
