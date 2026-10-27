// pnpm test:e2e under verify:task: browser tests of the built app. Arguments name the spec files
// to run (e.g. `status-screen`); without them every spec runs. A missing browser or a
// missing build is a precondition, reported as blocked (exit 78), never as a passed or failed run.
// Install the browser with `pnpm exec playwright install chromium` (CI adds --with-deps).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { pnpmInvocation } from "../../scripts/support/toolchain.ts";
import { blockCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { SERVER_ENTRY, WEB_INDEX } from "../support/server-process.ts";

if (!existsSync(chromium.executablePath())) {
  blockCheck("the Playwright Chromium browser is not installed (pnpm exec playwright install chromium)");
}
for (const built of [SERVER_ENTRY, WEB_INDEX]) {
  if (!existsSync(built)) blockCheck(`${built} is missing; run pnpm build first`);
}
const invocation = pnpmInvocation(["test:e2e", ...process.argv.slice(2)]);
const run = spawnSync(invocation.command, invocation.args, { cwd: repoRoot, stdio: "inherit" });
process.exitCode = run.status ?? 1;
