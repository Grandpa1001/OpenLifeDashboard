// G2 — the full F01 on one installation in a real browser (DEV §8.4, KM2): its dictionary of statuses
// with a hidden value, its registry Książki with every column type and 25 records, five of them with a
// status the dictionary does not have, its entry of ConfigTable and its table widget, all made through
// the production routes with the session of the page (no SQL). Then, as the owner sees it: 1037 is
// 10.37, the hidden status keeps its label in the table and the widget, an unknown one stays its
// symbol, the entry of ConfigTable is the text 20; Autor removed in Manage columns after its effects
// leaves the widget needing its binding; and a change that fails before its DDL keeps every record.
import type { Page } from "@playwright/test";
import { CONFIG_PATH } from "@openlife/contracts/http/config";
import { DICTIONARIES_PATH, dictionarySchema } from "@openlife/contracts/http/dictionaries";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { backupsDir } from "../support/database-fixtures.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const widgets = locale("en", "widgets");
const errors = locale("en", "errors");
test.use({ locale: "en-US", viewport: { width: 1600, height: 1000 } });

type F01 = {
  configEntries: Array<{ symbol: string; displayName: string; value: string; description: string }>;
  dictionaries: Array<{ id: string; symbol: string; displayName: string; values: Array<{ symbol: string; label: string; hidden: boolean }> }>;
  registries: Array<{ symbol: string; displayName: string; columns: Array<{ symbol: string; displayName: string; type: string; typeOptions: Record<string, unknown>; defaultValue: unknown; required: boolean }>; records: Array<{ values: Record<string, unknown> }> }>;
};
const F01 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as F01;
const only = <T>(items: readonly T[]): T => {
  if (items.length !== 1 || items[0] === undefined) throw new Error("F01 is not whole");
  return items[0];
};
const DICTIONARY = only(F01.dictionaries);
const BOOKS = only(F01.registries);
const NORMA = only(F01.configEntries);
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(registers, key));
/** What a status shows: the label of its dictionary value, hidden ones too, or the stored symbol when the dictionary has none. */
const shown = (status: unknown): string => DICTIONARY.values.find((value) => value.symbol === status)?.label ?? String(status);
const titleWith = (status: string): string => BOOKS.records.find((record) => record.values["status"] === status)!.values["tytul"] as string;
const everyRecord = (owner: BrowserOwner) => JSON.stringify(query(owner.instance, "SELECT * FROM reg_ksiazki ORDER BY id"));

/** F01 through the routes of the product with the session of the page. */
async function f01(page: Page, owner: BrowserOwner): Promise<void> {
  const headers = { Origin: owner.baseUrl };
  const dictionary = await page.request.post(`${owner.baseUrl}${DICTIONARIES_PATH}`, { data: { symbol: DICTIONARY.symbol, displayName: DICTIONARY.displayName, values: DICTIONARY.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) }, headers });
  expect(dictionary.status()).toBe(201);
  const dictionaryId = dictionarySchema.parse(await dictionary.json()).id;
  const columns = BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: "dictionaryId" in typeOptions ? { dictionaryId } : typeOptions, defaultValue, required }));
  expect((await page.request.post(`${owner.baseUrl}${REGISTRIES_PATH}`, { data: { symbol: BOOKS.symbol, displayName: BOOKS.displayName, columns }, headers })).status()).toBe(201);
  for (const [index, record] of BOOKS.records.entries()) {
    const added = await page.request.post(`${owner.baseUrl}${registryRecordsPath(BOOKS.symbol)}`, { data: { schemaRevision: 1, values: record.values }, headers: { ...headers, [IDEMPOTENCY_KEY_HEADER]: `g2-path-key-${String(index).padStart(3, "0")}` } });
    expect(added.status(), await added.text()).toBe(201);
  }
  expect((await page.request.post(`${owner.baseUrl}${CONFIG_PATH}`, { data: { symbol: NORMA.symbol, displayName: NORMA.displayName, value: NORMA.value, description: NORMA.description }, headers })).status()).toBe(201);
  await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000002a1", title: "Moje książki", columns: ["tytul", "autor", "cena", "status"], layout: LAYOUT }]);
}

test.describe("G2 the full F01 on one installation", () => {
  test("1037 is 10.37, a hidden status keeps its label and an unknown one stays its symbol in the table and the widget, ConfigTable holds the text 20; Autor removed after its effects breaks the binding; a change that fails keeps every record", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await f01(page, owner);

    // The amount and the statuses in the view of the registry, found by their titles.
    const rowOf = async (title: string) => {
      await page.goto(`${owner.baseUrl}/registers/ksiazki?search=${encodeURIComponent(title)}`);
      return page.getByRole("row").filter({ hasText: title });
    };
    const first = BOOKS.records[0]!.values;
    expect(first["cena"]).toBe(1037);
    await expect(await rowOf(first["tytul"] as string)).toContainText("10.37");
    const archived = DICTIONARY.values.find((value) => value.hidden)!;
    await expect(await rowOf(titleWith(archived.symbol))).toContainText(archived.label);
    await expect(await rowOf(titleWith("spoza_slownika"))).toContainText("spoza_slownika");
    await expectNoViolations(page);

    // The widget: the ten newest records, each status as the dictionary shows it.
    await page.goto(`${owner.baseUrl}/main`);
    const widget = page.locator("section.widget").filter({ hasText: "Moje książki" });
    await expect(widget.getByRole("row")).toHaveCount(11);
    for (const record of BOOKS.records.slice(-10)) await expect(widget.getByRole("row").filter({ hasText: record.values["tytul"] as string })).toContainText(shown(record.values["status"]));

    // ConfigTable: the entry of F01 as the text 20.
    await page.goto(`${owner.baseUrl}/config`);
    await expect(page.getByRole("row").filter({ hasText: NORMA.displayName })).toContainText("Field.Config.norma_czytania");
    expect(query<{ value: string; type: string }>(owner.instance, "SELECT value, typeof(value) AS type FROM config_entry")).toEqual([{ value: "20", type: "text" }]);

    // A change whose copy cannot be made changes nothing: every record stays as it was.
    const before = everyRecord(owner);
    await page.goto(`${owner.baseUrl}/registers/ksiazki/columns`);
    await page.getByLabel(say("structure.typeOf", { name: "Liczba stron" }), { exact: true }).selectOption("text");
    await page.getByRole("button", { name: text(registers, "structure.showEffects") }).click();
    const effects = page.getByRole("dialog", { name: text(registers, "structure.effects.heading") });
    await effects.getByRole("checkbox", { name: text(registers, "structure.effects.aware") }).check();
    chmodSync(backupsDir(owner.instance), 0o500);
    try {
      await effects.getByRole("button", { name: text(registers, "structure.effects.save") }).click();
      await expect(effects.getByRole("alert")).toContainText(text(errors, "SNAPSHOT_FAILED"));
    } finally {
      chmodSync(backupsDir(owner.instance), 0o700);
    }
    await page.keyboard.press("Escape");
    expect(everyRecord(owner)).toBe(before);
    await page.getByRole("button", { name: text(registers, "form.cancel") }).click();

    // S8: Autor removed after its effects; the widget then needs its binding.
    await page.getByRole("button", { name: say("structure.removeColumn", { name: "Autor" }) }).click();
    await page.getByRole("button", { name: text(registers, "structure.showEffects") }).click();
    await expect(effects.getByRole("definition")).toHaveText(["25", String(BOOKS.records.filter((record) => record.values["autor"] !== null).length)]);
    await expect(effects.getByRole("list", { name: text(registers, "structure.effects.widgetList") })).toContainText("Moje książki");
    await effects.getByRole("checkbox", { name: text(registers, "structure.effects.aware") }).check();
    await effects.getByRole("button", { name: text(registers, "structure.effects.save") }).click();
    await expect(effects).toBeHidden();
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widget.getByText(text(widgets, "registerTable.brokenBinding"))).toBeVisible();
    expect(query<{ n: number }>(owner.instance, "SELECT count(*) AS n FROM reg_ksiazki")).toEqual([{ n: 25 }]);
  });
});
