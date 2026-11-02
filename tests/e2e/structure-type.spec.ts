// D31.2 — a change of a column's type in a real browser (Scope §5.6, S9, makieta 20): the report of
// the conversion in the window of effects, the copy pre_type_change, and the three ways out of a
// required column that would be left without values.
// AC1: S9 on an optional column with "12" and "abc" text → number: the report says 1 converted and 1
//      that cannot be converted ("abc"), the change is saved after its copy and the records hold 12
//      and nothing; F01 strony number → text.
// AC2: a required column is blocked with nothing to save; "correct the data" opens the records
//      searched for "abc"; a bad replacement is told at its field without a request, a good one and
//      "make it optional" are new previews that save; an unsupported pair is told at the type; a copy
//      that cannot be made leaves the window with its message and changes nothing.
import { chmodSync, readdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { structurePreviewPath } from "@openlife/contracts/http/registries";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { backupsDir } from "../support/database-fixtures.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const errors = locale("en", "errors");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(registers, key));
const effects = (page: Page): Locator => page.getByRole("dialog", { name: text(registers, "structure.effects.heading") });
const report = (page: Page): Locator => effects(page).getByRole("region", { name: text(registers, "structure.report.heading") });
const typeOf = (page: Page, column: string): Locator => page.getByLabel(say("structure.typeOf", { name: column }), { exact: true });
const showEffects = (page: Page): Locator => page.getByRole("button", { name: text(registers, "structure.showEffects") });
const aware = (page: Page): Locator => effects(page).getByRole("checkbox", { name: text(registers, "structure.effects.aware") });
const saveChange = (page: Page): Locator => effects(page).getByRole("button", { name: text(registers, "structure.effects.save") });
const packages = (owner: BrowserOwner): string[] => readdirSync(backupsDir(owner.instance)).filter((name) => !name.startsWith("."));

/** `pomiary`: a name and the text columns `wartosc` and `druga`, both "12" in one record and "abc" in the other. */
async function measurements(page: Page, owner: BrowserOwner, required: boolean): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, {
    symbol: "pomiary",
    displayName: "Pomiary",
    columns: [
      { symbol: "nazwa", displayName: "Nazwa", type: "text", required: true },
      { symbol: "wartosc", displayName: "Wartość", type: "text", required },
      { symbol: "druga", displayName: "Druga", type: "text", required },
    ],
  });
  await addRecordByApi(page, owner, "pomiary", { nazwa: "pierwszy", wartosc: "12", druga: "12" }, "seed-key-001");
  await addRecordByApi(page, owner, "pomiary", { nazwa: "drugi", wartosc: "abc", druga: "abc" }, "seed-key-002");
  await page.goto(`${owner.baseUrl}/registers/pomiary/columns`);
  await expect(typeOf(page, "Wartość")).toBeVisible();
}

const values = (owner: BrowserOwner, column: string) => query<{ nazwa: string; value: unknown }>(owner.instance, `SELECT nazwa, ${column} AS value FROM reg_pomiary ORDER BY nazwa DESC`);

async function saveAfterAware(page: Page, description: string): Promise<void> {
  await expect(saveChange(page)).toBeDisabled();
  await aware(page).check();
  await saveChange(page).click();
  await expect(effects(page)).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: say("structure.done", { change: description }) })).toBeVisible();
}

test.describe("D31.2-AC1 a change of type with its report", () => {
  test("S9: an optional text column with 12 and abc becomes a number after its report and its copy; F01 strony becomes text", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await measurements(page, owner, false);
    await typeOf(page, "Wartość").selectOption("number");
    await showEffects(page).click();
    await expect(report(page).getByRole("definition")).toHaveText(["1", "0", "0", "1"]);
    await expect(report(page).getByRole("list", { name: text(registers, "structure.report.samples") })).toHaveText(say("structure.report.sample_one", { value: "abc", count: 1 }));
    await expect(report(page).getByText(say("structure.report.emptied_one", { count: 1 }))).toBeVisible();
    await expect(effects(page).getByText(text(registers, "structure.effects.copy"))).toBeVisible();
    await expectNoViolations(page);
    await saveAfterAware(page, say("structure.change.changeType", { name: "Wartość", type: text(registers, "types.number") }));
    expect(values(owner, "wartosc").map((row) => [row.nazwa, row.value])).toEqual([
      ["pierwszy", 12],
      ["drugi", null],
    ]);
    expect(packages(owner)).toHaveLength(1);
    expect(packages(owner)[0]).toContain("pre_type_change");

    await page.goto(`${owner.baseUrl}/registers`);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    for (let index = 1; index <= 3; index += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${index}`, strony: 100 * index }, `seed-key-10${index}`);
    await page.goto(`${owner.baseUrl}/registers/ksiazki/columns`);
    await typeOf(page, "Liczba stron").selectOption("text");
    await showEffects(page).click();
    await expect(report(page).getByRole("definition")).toHaveText(["3", "0", "0", "0"]);
    await saveAfterAware(page, say("structure.change.changeType", { name: "Liczba stron", type: text(registers, "types.text") }));
    expect(query<{ strony: unknown }>(owner.instance, "SELECT strony FROM reg_ksiazki ORDER BY strony")).toEqual([{ strony: "100" }, { strony: "200" }, { strony: "300" }]);
  });
});

test.describe("D31.2-AC2 a required column and the ways out", () => {
  test("blocked with nothing to save; correct the data, a replacement and making it optional; a bad replacement at its field without a request", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await measurements(page, owner, true);
    let previews = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith(structurePreviewPath("pomiary"))) previews += 1;
    });

    await typeOf(page, "Wartość").selectOption("number");
    await showEffects(page).click();
    await expect(effects(page).getByText(text(registers, "structure.blocked.REQUIRED_VALUES_LOST"))).toBeVisible();
    await expect(saveChange(page)).toHaveCount(0);
    await expect(aware(page)).toHaveCount(0);
    await expectNoViolations(page);

    // Correct the data: the records of the registry, searched for the value that does not convert.
    await report(page).getByRole("link", { name: say("structure.report.fixLink", { value: "abc" }) }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers/pomiary?search=abc`);
    await expect(page.getByRole("cell", { name: "drugi", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "pierwszy", exact: true })).toHaveCount(0);

    // A replacement: a bad one at its field without a request, a good one a new preview that saves.
    await page.goto(`${owner.baseUrl}/registers/pomiary/columns`);
    await typeOf(page, "Wartość").selectOption("number");
    await showEffects(page).click();
    await expect(effects(page).getByText(text(registers, "structure.blocked.REQUIRED_VALUES_LOST"))).toBeVisible();
    const before = previews;
    await report(page).getByLabel(text(registers, "structure.report.replacement"), { exact: true }).fill("dużo");
    await report(page).getByRole("button", { name: text(registers, "structure.report.useReplacement") }).click();
    await expect(report(page).getByText(text(registers, "issues.REPLACEMENT_INVALID"))).toBeVisible();
    expect(previews).toBe(before);
    await report(page).getByLabel(text(registers, "structure.report.replacement"), { exact: true }).fill("0");
    await report(page).getByRole("button", { name: text(registers, "structure.report.useReplacement") }).click();
    await expect(effects(page).getByText(text(registers, "structure.blocked.REQUIRED_VALUES_LOST"))).toHaveCount(0);
    await saveAfterAware(page, say("structure.change.changeType", { name: "Wartość", type: text(registers, "types.number") }));
    expect(values(owner, "wartosc").map((row) => row.value)).toEqual([12, 0]);

    // Optional in the same change: the value that does not convert is left empty, the column no longer required.
    await typeOf(page, "Druga").selectOption("number");
    await showEffects(page).click();
    await report(page).getByRole("button", { name: text(registers, "structure.report.makeOptional") }).click();
    await expect(effects(page).getByText(text(registers, "structure.blocked.REQUIRED_VALUES_LOST"))).toHaveCount(0);
    await saveAfterAware(page, say("structure.change.changeType", { name: "Druga", type: text(registers, "types.number") }));
    expect(values(owner, "druga").map((row) => row.value)).toEqual([12, null]);
    expect(query<{ required: number }>(owner.instance, "SELECT required FROM registry_column WHERE symbol = 'druga'")).toEqual([{ required: 0 }]);
  });

  test("an unsupported pair is told at the type; a copy that cannot be made leaves the window with its message and changes nothing", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Książka 1", strony: 100 }, "seed-key-001");
    await page.goto(`${owner.baseUrl}/registers/ksiazki/columns`);

    await typeOf(page, "Ponowne czytanie").selectOption("date");
    await showEffects(page).click();
    await expect(page.getByText(text(registers, "issues.TYPE_CHANGE_UNSUPPORTED"))).toBeVisible();
    await expect(effects(page)).toHaveCount(0);
    await expect(typeOf(page, "Ponowne czytanie")).toHaveValue("date");
    await page.getByRole("button", { name: text(registers, "form.cancel") }).click();

    await typeOf(page, "Liczba stron").selectOption("text");
    await showEffects(page).click();
    await aware(page).check();
    chmodSync(backupsDir(owner.instance), 0o500);
    try {
      await saveChange(page).click();
      await expect(effects(page).getByRole("alert")).toContainText(text(errors, "SNAPSHOT_FAILED"));
    } finally {
      chmodSync(backupsDir(owner.instance), 0o700);
    }
    await expect(effects(page)).toBeVisible();
    expect(query<{ type: string }>(owner.instance, "SELECT type FROM registry_column WHERE symbol = 'strony'")).toEqual([{ type: "number" }]);
    expect(packages(owner)).toEqual([]);
  });
});
