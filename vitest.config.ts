import { defineConfig } from "vitest/config";
import { EVIDENCE_DIR_ENV } from "./tooling/verification-tasks.ts";

// Unit tests cover pure rules; integration tests run built artifacts as real processes
// (DEV §8.3). None uses the owner's data; servers start isolated on ephemeral ports.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    // Removes the temporary folders of test helpers after each test file.
    setupFiles: ["tests/support/vitest-setup.ts"],
    // Under verify:task every test is listed with its result, so a gate can read single cases
    // (G0, DEV §9.6) from the check log instead of a file-level summary.
    reporters: process.env[EVIDENCE_DIR_ENV] ? ["verbose"] : ["default"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
