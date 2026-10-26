// D08.2-AC2: in a test copy, a removed translation key and a text written into a component make
// the checks CI runs exit nonzero. The unchanged copy passes the same commands first.
// - key removed from English: check:locales names it (the build alone would not notice);
// - key removed from Polish, the source the keys are typed from: the web build fails on the t()
//   call that uses it, and check:locales names it too;
// - a literal text in JSX: lint fails with i18next/no-literal-string.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, removeCopy, runPnpm, type RunResult } from "../support/repository-copy.ts";

const KEY = "status.recheck";
const LOCALE_FILE = (language: string): string => `apps/web/src/locales/${language}/common.json`;
const PAGE = "apps/web/src/app/pages/status-page.tsx";
const BUILD_WEB = ["--filter", "@openlife/web...", "build"];

const check = createCheck("translation key and literal text controls");
const copy = copyRepository();
try {
  const file = (relative: string): string => path.join(copy, relative);
  const original = new Map<string, string>();
  const edit = (relative: string, change: (text: string) => string): void => {
    const before = original.get(relative) ?? readFileSync(file(relative), "utf8");
    original.set(relative, before);
    const after = change(before);
    if (after === before) throw new Error(`the control did not change ${relative}`);
    writeFileSync(file(relative), after);
  };
  const restore = (relative: string): void => writeFileSync(file(relative), original.get(relative) ?? "");
  const withoutKey = (text: string): string => {
    const data = JSON.parse(text) as { status: Record<string, unknown> };
    delete data.status[KEY.split(".")[1] ?? ""];
    return `${JSON.stringify(data, null, 2)}\n`;
  };
  const failsNaming = (result: RunResult, name: string, needle: string): void => {
    check.expect(result.status !== 0, `${name}: exits nonzero (got ${result.status})`, result.output);
    check.expect(result.output.includes(needle), `${name}: names ${needle}`, result.output);
  };

  const install = runPnpm(["install", "--frozen-lockfile", "--prefer-offline"], copy);
  const baseline = install.status === 0 ? runPnpm(BUILD_WEB, copy) : install;
  if (check.expect(baseline.status === 0, "unchanged copy: install and web build pass", baseline.output)) {
    check.expect(runPnpm(["check:locales"], copy).status === 0, "unchanged copy: check:locales passes");
    check.expect(runPnpm(["exec", "eslint", PAGE], copy).status === 0, "unchanged copy: lint of the status page passes");

    edit(LOCALE_FILE("en"), withoutKey);
    failsNaming(runPnpm(["check:locales"], copy), "key removed from en: check:locales", `en/common.json: missing key ${KEY}`);
    restore(LOCALE_FILE("en"));

    edit(LOCALE_FILE("pl"), withoutKey);
    failsNaming(runPnpm(BUILD_WEB, copy), "key removed from pl: web build", "status-page.tsx");
    failsNaming(runPnpm(["check:locales"], copy), "key removed from pl: check:locales", `en/common.json: key ${KEY} is not in pl`);
    restore(LOCALE_FILE("pl"));

    edit(PAGE, (text) => text.replace("<h1>{t(\"status.title\")}</h1>", "<h1>{t(\"status.title\")}</h1>\n      <p>Tekst wpisany na stałe</p>"));
    failsNaming(runPnpm(["exec", "eslint", PAGE], copy), "literal text in JSX: lint", "i18next/no-literal-string");
  }
} finally {
  removeCopy(copy);
}
check.finish();
