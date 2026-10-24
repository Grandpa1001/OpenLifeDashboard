// D01.1-AC3: in a test copy, the strict compiler profile rejects a control type error in core:
// an implicit any (strict) and an unchecked index access (noUncheckedIndexedAccess).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, removeCopy, runPnpm } from "../support/repository-copy.ts";

const CONTROL_ERROR = [
  "export function total(items) {",
  "  return items.length;",
  "}",
  "export const first: string = [1][0];",
  "",
].join("\n");

const check = createCheck("strict types");
const copy = copyRepository();
try {
  const install = runPnpm(["install", "--frozen-lockfile", "--prefer-offline"], copy);
  if (check.expect(install.status === 0, "install in the test copy exits 0", install.output)) {
    writeFileSync(path.join(copy, "packages/core/src/index.ts"), CONTROL_ERROR);
    const build = runPnpm(["-r", "build"], copy);
    check.expect(build.status !== 0, `build exits nonzero (got ${build.status})`, build.output);
    check.expect(build.output.includes("error TS7006"), "implicit any is reported (TS7006)", build.output);
    check.expect(build.output.includes("error TS2322"), "unchecked index access is reported (TS2322)", build.output);
    check.expect(build.output.includes("packages/core"), "the error is attributed to packages/core", build.output);
  }
} finally {
  removeCopy(copy);
}
check.finish();
