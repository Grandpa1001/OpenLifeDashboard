import { defineConfig, devices } from "@playwright/test";
import { EVIDENCE_DIR_ENV } from "./tooling/verification-tasks.ts";

// Browser tests of the built SPA (DEV §8.3 test:e2e). Each test starts the built server on its
// own fresh test installation and an ephemeral port (tests/e2e/fixtures.ts), so workers share no
// folder, port, cookie or storage state. Chromium only until the browser matrix of D40/D63.
// Under verify:task the traces and the JSON report go to the check's evidence folder.
const evidence = process.env[EVIDENCE_DIR_ENV];

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  outputDir: evidence ? `${evidence}/playwright` : ".artifacts/playwright",
  forbidOnly: true,
  retries: 0,
  reporter: evidence ? [["list"], ["json", { outputFile: `${evidence}/playwright-report.json` }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    // Traces hold the page and its responses: kept only for a failure, in local artifacts.
    trace: "retain-on-failure",
  },
});
