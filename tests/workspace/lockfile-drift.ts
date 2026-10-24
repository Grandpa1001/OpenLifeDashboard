// D01.1-AC2: in a test copy, a manifest that no longer matches pnpm-lock.yaml must make the
// frozen install fail with the lockfile error (not with an unrelated failure).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, removeCopy, runPnpm } from "../support/repository-copy.ts";

const check = createCheck("lockfile drift");
const copy = copyRepository();
try {
  const manifestFile = path.join(copy, "packages/core/package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, dependencies: { zod: "4.6.7" } }, null, 2));

  const install = runPnpm(["install", "--frozen-lockfile"], copy);
  check.expect(install.status !== 0, `frozen install exits nonzero (got ${install.status})`, install.output);
  check.expect(
    install.output.includes("ERR_PNPM_OUTDATED_LOCKFILE"),
    "failure is ERR_PNPM_OUTDATED_LOCKFILE",
    install.output,
  );
} finally {
  removeCopy(copy);
}
check.finish();
