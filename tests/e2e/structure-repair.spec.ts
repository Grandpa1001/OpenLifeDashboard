// D31.3 — a dictionary made from the row of a choice column and the repair of a broken binding in a
// real browser (Scope §5.4, §5.8, S8, S10; makieta 11, 19, 22).
// AC1: a dictionary made from the row of a new choice column is chosen at once, the column is saved
//      with it and /dictionaries lists it; one made for the existing choice column Status is saved as
//      a change of its options; after S8 the panel of bindings shows the missing column, choosing the
//      columns again saves and the widget is back to ok; after S10 the panel shows the missing
//      registry and choosing another one brings the widget back.
// AC2: a bad and a taken symbol of the dictionary are told at the field and the window of columns
//      keeps what was typed; Escape gives the focus back to the button; axe.
import type { Locator, Page } from "@playwright/test";
import { structurePath, structurePreviewPath } from "@openlife/contracts/http/registries";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
test.use({ locale: "en-US" });

const say = (texts: Record<string, unknown>, key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(texts, key));
const WIDGET = "019a0000-0000-7000-8000-0000000031c1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };
const newDictionary = (page: Page): Locator => page.getByRole("dialog", { name: text(registers, "dictionaries.new.heading") });
const effects = (page: Page): Locator => page.getByRole("dialog", { name: text(registers, "structure.effects.heading") });
const widgetOnMain = (page: Page): Locator => page.locator("section.widget").filter({ hasText: "Moje książki" });

async function saveShownChange(page: Page): Promise<void> {
  await page.getByRole("button", { name: text(registers, "structure.showEffects") }).click();
  await effects(page).getByRole("checkbox", { name: text(registers, "structure.effects.aware") }).check();
  await effects(page).getByRole("button", { name: text(registers, "structure.effects.save") }).click();
  await expect(effects(page)).toBeHidden();
}

/** A change of the structure through the API, as another tab would make it: its preview, then the change on its plan. */
async function changeByApi(page: Page, owner: BrowserOwner, symbol: string, change: unknown): Promise<void> {
  const headers = { Origin: owner.baseUrl };
  const preview = await page.request.post(`${owner.baseUrl}${structurePreviewPath(symbol)}`, { data: { change }, headers });
  expect(preview.status()).toBe(200);
  const { planToken } = (await preview.json()) as { planToken: string };
  expect((await page.request.post(`${owner.baseUrl}${structurePath(symbol)}`, { data: { change, planToken }, headers })).status()).toBe(200);
}

const columnIdOf = (owner: BrowserOwner, symbol: string): string => query<{ id: string }>(owner.instance, `SELECT c.id FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.symbol = 'ksiazki' AND c.symbol = '${symbol}' AND c.deleted_at IS NULL`)[0]!.id;

/** F01 with one record and its register table of Tytuł and Autor on the screen. */
async function booksOnScreen(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris", autor: "Lem", strony: 204 }, "seed-key-001");
  await createScreenWith(page, owner, [{ id: WIDGET, title: "Moje książki", layout: LAYOUT }]);
}

async function openPanel(page: Page, owner: BrowserOwner): Promise<Locator> {
  await page.goto(`${owner.baseUrl}/designer`);
  await page.getByRole("button", { name: /Moje książki/ }).first().click();
  return page.getByRole("region", { name: text(designer, "panel.heading") });
}

async function saveDesign(page: Page): Promise<void> {
  await page.getByRole("button", { name: text(designer, "toolbar.save"), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: text(designer, "toolbar.saved") })).toBeVisible();
}

test.describe("D31.3-AC1 a dictionary from the window of columns", () => {
  test("made from the row of a new choice column and from the existing Status, chosen at once, saved and listed; a bad and a taken symbol at the field", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await page.goto(`${owner.baseUrl}/registers/ksiazki/columns`);

    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Gatunek");
    await page.getByLabel(text(registers, "form.type"), { exact: true }).selectOption("choice");
    const make = page.getByRole("button", { name: say(registers, "structure.newDictionaryOf", { name: say(registers, "form.column", { position: 10 }) }) });
    await make.click();
    await expect(newDictionary(page)).toBeVisible();
    await expectNoViolations(page);
    // Escape leaves nothing made, the row as it was and the focus on the button.
    await page.keyboard.press("Escape");
    await expect(newDictionary(page)).toBeHidden();
    await expect(make).toBeFocused();
    await expect(page.getByLabel(text(registers, "form.columnName"), { exact: true })).toHaveValue("Gatunek");

    await make.click();
    await newDictionary(page).getByLabel(text(registers, "dictionaries.new.name"), { exact: true }).fill("Gatunki");
    await newDictionary(page).getByLabel(text(registers, "form.symbol"), { exact: true }).fill("Złe!");
    await expect(newDictionary(page).getByText(text(registers, "issues.SYMBOL_PATTERN"))).toBeVisible();
    await newDictionary(page).getByLabel(text(registers, "form.symbol"), { exact: true }).fill("gatunki");
    await newDictionary(page).getByRole("button", { name: text(registers, "dictionaries.new.create") }).click();
    await expect(newDictionary(page)).toBeHidden();
    await expect(page.getByLabel(say(registers, "form.dictionaryOf", { position: 10 }), { exact: true }).locator("option:checked")).toHaveText("Gatunki");
    await saveShownChange(page);
    const gatunki = query<{ id: string }>(owner.instance, "SELECT id FROM dictionary WHERE symbol = 'gatunki'")[0]!.id;
    expect(query<{ options: string }>(owner.instance, "SELECT type_options AS options FROM registry_column WHERE symbol = 'gatunek'")).toEqual([{ options: JSON.stringify({ dictionaryId: gatunki }) }]);

    // The existing Status: a taken symbol is told at the field, then a dictionary of its own is a change of its options.
    await page.getByRole("button", { name: say(registers, "structure.newDictionaryOf", { name: "Status" }) }).click();
    await newDictionary(page).getByLabel(text(registers, "dictionaries.new.name"), { exact: true }).fill("Gatunki");
    await expect(newDictionary(page).getByLabel(text(registers, "form.symbol"), { exact: true })).toHaveValue("gatunki_2");
    await newDictionary(page).getByLabel(text(registers, "form.symbol"), { exact: true }).fill("gatunki");
    await expect(newDictionary(page).getByText(text(registers, "dictionaries.issues.SYMBOL_TAKEN"))).toBeVisible();
    await newDictionary(page).getByLabel(text(registers, "dictionaries.new.name"), { exact: true }).fill("Statusy");
    await newDictionary(page).getByLabel(text(registers, "form.symbol"), { exact: true }).fill("statusy");
    await newDictionary(page).getByRole("button", { name: text(registers, "dictionaries.new.create") }).click();
    await expect(page.getByLabel(say(registers, "structure.dictionaryOf", { name: "Status" }), { exact: true }).locator("option:checked")).toHaveText("Statusy");
    await saveShownChange(page);
    const statusy = query<{ id: string }>(owner.instance, "SELECT id FROM dictionary WHERE symbol = 'statusy'")[0]!.id;
    expect(query<{ options: string }>(owner.instance, "SELECT type_options AS options FROM registry_column WHERE symbol = 'status' AND deleted_at IS NULL")).toEqual([{ options: JSON.stringify({ dictionaryId: statusy }) }]);

    await page.goto(`${owner.baseUrl}/dictionaries`);
    await expect(page.getByRole("link", { name: "Gatunki" }).or(page.getByRole("button", { name: "Gatunki" })).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Statusy" }).or(page.getByRole("button", { name: "Statusy" })).first()).toBeVisible();
  });
});

test.describe("D31.3-AC1 the repair of a broken binding in the Designer", () => {
  test("S8: the panel shows the removed Autor, the columns chosen again are saved and the widget is ok", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await changeByApi(page, owner, "ksiazki", { kind: "removeColumn", columnId: columnIdOf(owner, "autor") });
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOnMain(page).getByText(text(widgets, "registerTable.brokenBinding"))).toBeVisible();

    const panel = await openPanel(page, owner);
    await expect(panel.getByRole("list", { name: text(designer, "panel.missing") })).toHaveText(say(designer, "panel.missingPath", { path: "Field.Register.ksiazki.autor" }));
    await expect(panel.getByText(text(designer, "panel.missingColumnHint"))).toBeVisible();
    await expectNoViolations(page);
    await panel.getByRole("checkbox", { name: "Liczba stron" }).check();
    await expect(panel.getByRole("list", { name: text(designer, "panel.missing") })).toHaveCount(0);
    await saveDesign(page);

    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOnMain(page).getByRole("columnheader")).toHaveText(["Tytuł", "Liczba stron"]);
    await expect(widgetOnMain(page).getByRole("cell", { name: "Solaris" })).toBeVisible();
  });

  test("S10: the panel shows the deleted Książki, another registry chosen brings the widget back", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await createRegistry(page, owner, { symbol: "filmy", displayName: "Filmy", columns: [{ symbol: "tytul", displayName: "Tytuł filmu", type: "text", required: true }] });
    await addRecordByApi(page, owner, "filmy", { tytul: "Stalker" }, "seed-key-101");
    await changeByApi(page, owner, "ksiazki", { kind: "deleteRegistry" });

    const panel = await openPanel(page, owner);
    await expect(panel.getByRole("list", { name: text(designer, "panel.missing") })).toHaveText(say(designer, "panel.missingPath", { path: "Field.Register.ksiazki" }));
    await expect(panel.getByText(text(designer, "panel.missingRegistryHint"))).toBeVisible();
    await panel.getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Filmy (filmy)" });
    await panel.getByRole("checkbox", { name: "Tytuł filmu" }).check();
    await expect(panel.getByRole("list", { name: text(designer, "panel.missing") })).toHaveCount(0);
    await saveDesign(page);

    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOnMain(page).getByRole("columnheader")).toHaveText(["Tytuł filmu"]);
    await expect(widgetOnMain(page).getByRole("cell", { name: "Stalker" })).toBeVisible();
  });
});
