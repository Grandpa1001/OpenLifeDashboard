// D01.2-AC2: every boundary rule — and each of ARCH-01…05 — has a negative control, including
// an indirect SQLite path into web and both kinds of deep import; the allowed graph exists.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { architectureCases } from "./cases.ts";

const require = createRequire(import.meta.url);
const cruiserConfig = require(path.join(repoRoot, "tooling/dependency-cruiser/config.cjs")) as {
  forbidden: readonly { name: string }[];
};
const lintTags = [
  ...readFileSync(path.join(repoRoot, "tooling/eslint/config.js"), "utf8").matchAll(/\[((?:ARCH-\d{2}|boundary)-[\w-]+)\]/g),
].map((match) => match[1] ?? "");

const negatives = architectureCases.flatMap((control) => (control.expect.kind === "violation" ? [control.expect] : []));
const covered = (rule: string): boolean => negatives.some((expectation) => expectation.rule === rule);

const check = createCheck("architecture control coverage");
check.expect(architectureCases.some((control) => control.expect.kind === "clean"), "an allowed graph must stay clean");
for (const rule of cruiserConfig.forbidden.map((entry) => entry.name)) {
  check.expect(covered(rule), `dependency-cruiser rule ${rule} has a negative control`);
}
for (const rule of new Set(lintTags)) {
  check.expect(covered(rule), `lint rule ${rule} has a negative control`);
}
for (let index = 1; index <= 5; index += 1) {
  const prefix = `ARCH-0${index}-`;
  check.expect(negatives.some((expectation) => expectation.rule.startsWith(prefix)), `${prefix.slice(0, -1)} has a negative control`);
}

const indirect = architectureCases.find((control) => control.id === "arch-03-web-reaches-sqlite-indirectly");
const files = indirect?.workspace.files ?? {};
check.expect(
  indirect?.expect.kind === "violation" &&
    indirect.expect.rule === "ARCH-03-web-cannot-reach-server-runtime" &&
    !(files["apps/web/src/main.ts"] ?? "").includes("@openlife/sqlite") &&
    (files["packages/ui/src/index.ts"] ?? "").includes("@openlife/sqlite"),
  "indirect control: web imports only ui, ui imports sqlite, ARCH-03 is expected at web",
);
check.expect(covered("ARCH-04-no-cross-package-relative-import"), "deep import by relative path is controlled");
check.expect(covered("ARCH-04-import-must-resolve-through-exports"), "deep import of an unexported subpath is controlled");
check.finish();
