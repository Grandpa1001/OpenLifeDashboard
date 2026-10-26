// D08.1-AC2: in a test copy, the checks CI runs block a released migration edited without its
// checksum and a corrupted fixture. Each control first runs the same command on the unchanged
// copy, which must pass, so the failure afterwards comes from the change and nothing else.
// (A forbidden import is the D01.2 control tests/workspace/faulty-graph.ts.)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, removeCopy, runPnpm } from "../support/repository-copy.ts";

const MIGRATION = "packages/sqlite/src/migrations/0001-foundation.ts";
const MIGRATION_TEST = ["exec", "vitest", "run", "tests/integration/sqlite/migrations.test.ts"];
const EXPORT_FIXTURE = "tests/fixtures/books/books-v1.export.json";

const check = createCheck("CI-blocking controls: migration checksum and fixture");
const copy = copyRepository();
try {
  const edit = (file: string, change: (text: string) => string): void => {
    const target = path.join(copy, file);
    const before = readFileSync(target, "utf8");
    const after = change(before);
    if (after === before) throw new Error(`the control did not change ${file}`);
    writeFileSync(target, after);
  };
  const install = runPnpm(["install", "--frozen-lockfile", "--prefer-offline"], copy);
  const build = install.status === 0 ? runPnpm(["--filter", "@openlife/sqlite", "build"], copy) : install;
  if (check.expect(build.status === 0, "the copy installs and builds the sqlite package", build.output)) {
    // A released migration edited in place: one more statement, the declared checksum unchanged.
    const valid = runPnpm(MIGRATION_TEST, copy);
    check.expect(valid.status === 0, "unchanged copy: the migration tests pass", valid.output);
    edit(MIGRATION, (text) => text.replace(") STRICT;\n`,", ") STRICT;\nCREATE INDEX instance_created ON instance (created_at);\n`,"));
    const rebuilt = runPnpm(["--filter", "@openlife/sqlite", "build"], copy);
    const edited = runPnpm(MIGRATION_TEST, copy);
    check.expect(rebuilt.status === 0 && edited.status !== 0, `edited migration: the migration tests exit nonzero (got ${edited.status})`, edited.output);
    check.expect(edited.output.includes("0001-foundation does not match its declared checksum"), "the failure names the migration and its checksum", edited.output);

    // A corrupted fixture: one record fewer than the counts and pages expect.
    const fixturesValid = runPnpm(["fixtures:verify"], copy);
    check.expect(fixturesValid.status === 0, "unchanged copy: fixtures:verify passes", fixturesValid.output);
    edit(EXPORT_FIXTURE, (text) => {
      const data = JSON.parse(text) as { registries: { records: unknown[] }[] };
      data.registries[0]?.records.pop();
      return `${JSON.stringify(data, null, 2)}\n`;
    });
    const corrupted = runPnpm(["fixtures:verify"], copy);
    check.expect(corrupted.status === 1, `corrupted fixture: fixtures:verify exits 1 (got ${corrupted.status})`, corrupted.output);
    check.expect(corrupted.output.includes("FAIL F01: F01: 9 columns and 25 records"), "the failure names the fixture and the broken expectation", corrupted.output);
  }
} finally {
  removeCopy(copy);
}
check.finish();
