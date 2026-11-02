// D31.1 — the columns of a registry and its deletion in a real browser (Scope §5.6, S8, S10, makieta
// 19) on Książki of F01: 25 records, 22 of them with an author, and a register table bound to Tytuł and
// Autor on the screen.
// AC1: from the view of the registry to "Manage columns": removing Autor shows 25 records, 22
//      affected and the widget before it is saved, and the widget then needs its binding updated
//      (S8); a rename, a new required column with its default and a column made required with a
//      value for its empty cells are saved; deleting the registry after the same warning and its
//      copy leads to the list without Książki, and the widget needs its binding updated (S10).
// AC2: a second change waits while one is in the draft; saving waits for "I am aware"; a bad symbol
//      and a bad default are told at the field without a request; a refusal of the server lands at
//      its field and keeps what was typed; a required column without a value is blocked; a record
//      added after the preview makes the plan stale and a new preview saves it; on a phone no
//      sideways scroll; keyboard and focus of the window; axe.
import type { Locator, Page } from "@playwright/test";
import { structurePreviewPath } from "@openlife/contracts/http/registries";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const widgets = locale("en", "widgets");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(registers, key));
const WIDGET = "019a0000-0000-7000-8000-0000000031a1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };

const effects = (page: Page): Locator => page.getByRole("dialog", { name: text(registers, "structure.effects.heading") });
const showEffects = (page: Page): Locator => page.getByRole("button", { name: text(registers, "structure.showEffects") });
const nameOf = (page: Page, column: string): Locator => page.getByLabel(say("structure.columnName", { name: column }), { exact: true });
const aware = (dialog: Locator): Locator => dialog.getByRole("checkbox", { name: text(registers, "structure.effects.aware") });
const saveChange = (dialog: Locator): Locator => dialog.getByRole("button", { name: text(registers, "structure.effects.save") });
const columns = (owner: BrowserOwner) => query<{ symbol: string; display_name: string; required: number; default_value: string | null }>(owner.instance, "SELECT c.symbol, c.display_name, c.required, c.default_value FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.symbol = 'ksiazki' AND c.deleted_at IS NULL ORDER BY c.position");

/** F01 through the API: Książki with 25 records (the last three without an author) and the table of Tytuł and Autor on the screen. */
async function books(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (let index = 1; index <= 25; index += 1)
    await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${String(index).padStart(2, "0")}`, cena: 1000 + index, ...(index <= 22 ? { autor: "Autor" } : {}) }, `seed-key-${String(index).padStart(3, "0")}`);
  await createScreenWith(page, owner, [{ id: WIDGET, title: "Moje książki", layout: LAYOUT }]);
}

async function openColumns(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/registers/ksiazki`);
  await page.getByRole("link", { name: text(registers, "structure.manage") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/registers/ksiazki/columns`);
  await expect(page.getByRole("heading", { level: 1, name: say("structure.heading", { name: "Książki" }) })).toBeVisible();
}

/** Saves the change in the open window after "I am aware", and waits for the page to say so. */
async function confirmAndSave(page: Page, description: string): Promise<void> {
  const dialog = effects(page);
  await expect(saveChange(dialog)).toBeDisabled();
  await aware(dialog).check();
  await saveChange(dialog).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: say("structure.done", { change: description }) })).toBeVisible();
}

async function expectBrokenOnScreen(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/main`);
  await expect(page.locator("section.widget").filter({ hasText: "Moje książki" }).getByText(text(widgets, "registerTable.brokenBinding"))).toBeVisible();
}

test.describe("D31.1-AC1 the structure of Książki in the browser", () => {
  test("S8: removing Autor shows its records and the widget first, then the widget needs its binding updated; a rename, a required new column and a column made required are saved", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await openColumns(page, owner);
    await expectNoViolations(page);

    // A rename: the record count and no record altered.
    await nameOf(page, "Liczba stron").fill("Strony");
    await showEffects(page).click();
    const rename = say("structure.change.renameColumn", { name: "Liczba stron", to: "Strony" });
    await expect(effects(page).getByText(rename)).toBeVisible();
    await confirmAndSave(page, rename);

    // S8: removing Autor names the widget that shows it, and the slot that binds the column.
    await page.getByRole("button", { name: say("structure.removeColumn", { name: "Autor" }) }).click();
    await showEffects(page).click();
    const dialog = effects(page);
    await expect(dialog.getByRole("definition")).toHaveText(["25", "22"]);
    await expect(dialog.getByRole("list", { name: text(registers, "structure.effects.widgetList") })).toHaveText("Test MVP · Moje książki · columns");
    await expectNoViolations(page);
    await confirmAndSave(page, say("structure.change.removeColumn", { name: "Autor" }));
    expect(columns(owner).map((column) => column.symbol)).not.toContain("autor");

    // A new required column takes its default into every record.
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Ocena");
    await page.getByLabel(text(registers, "form.type"), { exact: true }).selectOption("number");
    await page.getByRole("checkbox", { name: text(registers, "form.required"), exact: true }).check();
    await page.getByLabel(text(registers, "structure.defaultRequired"), { exact: true }).fill("4");
    await showEffects(page).click();
    await confirmAndSave(page, say("structure.change.addColumn", { name: "Ocena" }));

    // Data ukończenia is empty everywhere: made required, its empty cells get the value typed.
    await page.getByRole("checkbox", { name: say("structure.requiredOf", { name: "Data ukończenia" }) }).check();
    await page.getByLabel(text(registers, "structure.empties"), { exact: true }).fill("2026-01-31");
    await showEffects(page).click();
    await expect(effects(page).getByRole("definition")).toHaveText(["25", "25"]);
    await confirmAndSave(page, say("structure.change.requiredOn", { name: "Data ukończenia" }));

    expect(columns(owner).map((column) => [column.symbol, column.display_name, column.required])).toEqual([
      ["tytul", "Tytuł", 1],
      ["strony", "Strony", 0],
      ["cena", "Cena", 0],
      ["data_ukonczenia", "Data ukończenia", 1],
      ["rozpoczeto", "Rozpoczęto", 0],
      ["przypomnienie", "Godzina przypomnienia", 0],
      ["ponowne_czytanie", "Ponowne czytanie", 0],
      ["status", "Status", 0],
      ["ocena", "Ocena", 1],
    ]);
    expect(query<{ n: number }>(owner.instance, "SELECT count(*) AS n FROM reg_ksiazki WHERE ocena = 4 AND data_ukonczenia = '2026-01-31'")[0]?.n).toBe(25);

    // The view of the registry shows the new structure.
    await page.getByRole("link", { name: "Książki" }).click();
    await expect(page.getByRole("region", { name: text(registers, "registry.columns") })).toContainText("Strony");
    await expect(page.getByRole("region", { name: text(registers, "registry.columns") })).toContainText("Ocena");
    await expectBrokenOnScreen(page, owner);
  });

  test("S10: deleting Książki after the warning, its widget and its copy leads to the list without it, and the widget needs its binding updated", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await openColumns(page, owner);
    await page.getByRole("button", { name: text(registers, "structure.deleteRegistry") }).click();
    const dialog = effects(page);
    await expect(dialog.getByText(say("structure.change.deleteRegistry", { name: "Książki" }))).toBeVisible();
    await expect(dialog.getByRole("definition")).toHaveText(["25", "25"]);
    await expect(dialog.getByText(text(registers, "structure.effects.copy"))).toBeVisible();
    await expect(dialog.getByRole("list", { name: text(registers, "structure.effects.widgetList") })).toContainText("Moje książki");
    const remove = dialog.getByRole("button", { name: text(registers, "structure.effects.delete") });
    await expect(remove).toBeDisabled();
    await aware(dialog).check();
    await remove.click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("link", { name: "Książki" })).toHaveCount(0);
    expect(query<{ deleted: number }>(owner.instance, "SELECT deleted_at IS NOT NULL AS deleted FROM registry WHERE symbol = 'ksiazki'")).toEqual([{ deleted: 1 }]);
    await expectBrokenOnScreen(page, owner);
  });
});

test.describe("D31.1-AC2 one change at a time, and a refusal keeps the form", () => {
  test("waits, live checks and server refusals at the field, a blocked required column, a stale plan shown again, phone, keyboard and axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await openColumns(page, owner);
    let previews = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith(structurePreviewPath("ksiazki"))) previews += 1;
    });

    // Nothing in the draft: nothing to show. One change in it: every other control waits.
    await expect(showEffects(page)).toBeDisabled();
    await nameOf(page, "Autor").fill("Autorka");
    await expect(page.getByRole("button", { name: say("structure.removeColumn", { name: "Tytuł" }) })).toBeDisabled();
    await expect(nameOf(page, "Tytuł")).toBeDisabled();
    await expect(page.getByRole("button", { name: text(registers, "form.addColumn") })).toBeDisabled();
    await expect(page.getByRole("button", { name: text(registers, "structure.deleteRegistry") })).toBeDisabled();
    await page.getByRole("button", { name: text(registers, "form.cancel") }).click();
    await expect(nameOf(page, "Autor")).toHaveValue("Autor");
    await expect(nameOf(page, "Tytuł")).toBeEnabled();

    // Live checks: a bad symbol at once, a bad default on the attempt; no request either way.
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Ocena");
    await page.getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("Ocena!");
    await expect(page.getByText(text(registers, "issues.SYMBOL_PATTERN"))).toBeVisible();
    await page.getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("tytul");
    await expect(page.getByText(text(registers, "issues.COLUMN_SYMBOL_TAKEN"))).toBeVisible();
    await page.getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("ocena");
    await page.getByLabel(text(registers, "form.type"), { exact: true }).selectOption("number");
    await page.getByLabel(text(registers, "structure.default"), { exact: true }).fill("dużo");
    await showEffects(page).click();
    await expect(page.getByText(text(registers, "issues.DEFAULT_INVALID"))).toBeVisible();
    expect(previews).toBe(0);

    // A symbol only the server knows to be reserved comes back to its field; the rest stays typed.
    await page.getByLabel(text(registers, "structure.default"), { exact: true }).fill("");
    await page.getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("id");
    await showEffects(page).click();
    await expect(page.getByText(text(registers, "issues.SYMBOL_RESERVED"))).toBeVisible();
    expect(previews).toBe(1);
    await expect(page.getByLabel(text(registers, "form.columnName"), { exact: true })).toHaveValue("Ocena");

    // Required with records and no default: blocked, nothing to save.
    await page.getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("ocena");
    await page.getByRole("checkbox", { name: text(registers, "form.required"), exact: true }).check();
    await showEffects(page).click();
    await expect(effects(page).getByText(text(registers, "structure.blocked.REQUIRED_EMPTY"))).toBeVisible();
    await expect(saveChange(effects(page))).toHaveCount(0);
    await expectNoViolations(page);
    // Escape closes the window and the focus is back on the button that opened it.
    await page.keyboard.press("Escape");
    await expect(effects(page)).toBeHidden();
    await expect(showEffects(page)).toBeFocused();
    await page.getByRole("button", { name: text(registers, "form.cancel") }).click();

    // A record added after the preview: the plan is stale, a new preview saves the change.
    await nameOf(page, "Cena").fill("Cena okładkowa");
    await showEffects(page).click();
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Książka 26" }, "seed-key-026");
    await aware(effects(page)).check();
    await saveChange(effects(page)).click();
    await expect(effects(page).getByRole("alert")).toContainText(text(locale("en", "errors"), "PLAN_STALE"));
    await expect(nameOf(page, "Cena")).toHaveValue("Cena okładkowa");
    await effects(page).getByRole("button", { name: text(registers, "structure.effects.review") }).click();
    await expect(effects(page).getByRole("definition").first()).toHaveText("26");
    await confirmAndSave(page, say("structure.change.renameColumn", { name: "Cena", to: "Cena okładkowa" }));
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

    // On a narrow phone the rows are stacks and the page does not scroll sideways; 320 px leaves room for
    // the wider fonts of the CI runner (401 px at 390 in run 41465169401, 390 on macOS).
    await page.setViewportSize({ width: 320, height: 844 });
    await page.reload();
    await expect(nameOf(page, "Tytuł")).toBeVisible();
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await expectNoViolations(page);
  });
});
