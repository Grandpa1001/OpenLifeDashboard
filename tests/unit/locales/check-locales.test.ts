// D08.2-AC2 — scripts/check-locales.ts on synthetic locale folders: equal keys pass; a missing,
// extra or empty key, a missing namespace, wrong plural forms or different {{variables}} fail.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkLocales } from "../../../scripts/check-locales.ts";
import { isReadyHealthBody } from "../../../packages/contracts/src/http/health-status.ts";

const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-locales-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PL = { status: { title: "Tytuł", items_one: "{{count}} rzecz", items_few: "{{count}} rzeczy", items_many: "{{count}} rzeczy", items_other: "{{count}} rzeczy" } };
const EN = { status: { title: "Title", items_one: "{{count}} item", items_other: "{{count}} items" } };

let counter = 0;
function locales(files: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string {
  counter += 1;
  const dir = path.join(scratch, `case-${counter}`);
  for (const [locale, namespaces] of Object.entries(files)) {
    mkdirSync(path.join(dir, locale), { recursive: true });
    for (const [name, content] of Object.entries(namespaces)) writeFileSync(path.join(dir, locale, `${name}.json`), JSON.stringify(content));
  }
  return dir;
}

describe("D08.2 check:locales", () => {
  it("passes when both languages have the same keys and the plural forms of their language", () => {
    expect(checkLocales(locales({ pl: { common: PL }, en: { common: EN } }))).toEqual([]);
  });

  it.each([
    ["a key missing in en", { pl: { common: PL }, en: { common: { status: { items_one: "x", items_other: "y" } } } }, "en/common.json: missing key status.title"],
    ["a key only in en", { pl: { common: PL }, en: { common: { status: { ...EN.status, extra: "x" } } } }, "en/common.json: key status.extra is not in pl"],
    ["an empty text", { pl: { common: PL }, en: { common: { status: { ...EN.status, title: " " } } } }, "en/common.json: status.title is empty"],
    ["a missing namespace", { pl: { common: PL, errors: { a: "b" } }, en: { common: EN } }, "en: missing namespace errors.json"],
    ["a Polish plural without few", { pl: { common: { status: { title: "T", items_one: "a", items_many: "b", items_other: "c" } } }, en: { common: EN } }, "pl/common.json: status.items has plural forms [many,one,other], pl needs [few,many,one,other]"],
    ["another variable", { pl: { common: PL }, en: { common: { status: { ...EN.status, items_one: "{{total}} item" } } } }, "en/common.json: status.items_one uses {{total}}, pl uses {{count}}"],
  ])("fails for %s", (_name, files, problem) => {
    expect(checkLocales(locales(files))).toContain(problem);
  });
});

describe("D08.2 health body of the start screen", () => {
  it.each([
    [{ status: "ok" }, true],
    [{ status: "unavailable" }, false],
    [{ status: "ok", extra: 1 }, false],
    ["ok", false],
    [null, false],
    [[{ status: "ok" }], false],
  ])("%j is ready: %s", (body, ready) => {
    expect(isReadyHealthBody(body)).toBe(ready);
  });
});
