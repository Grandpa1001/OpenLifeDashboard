// D25.3 — ConfigTable in a real browser (Scope §5.5, §5.7, S17, makieta 23) with the entry of F01
// (`norma_czytania` = "20"). Two tabs are two pages of one session, as a second open tab would be.
// AC1: from /registers to /config without SQL: the entry is added, changed and deleted in the
//      browser; the table shows its path Field.Config.norma_czytania, its value and 0 bindings; the
//      value is stored as text, and the audit of the database holds the old and the new value.
// AC2: a bad symbol and an overlong value are told at the field without a request; a save from a
//      second tab is a conflict that keeps what was typed; the delete warns of the bindings that
//      point at the entry; the Designer offers the register table nothing of ConfigTable; on a
//      phone the page does not scroll sideways; keyboard; axe.
import type { Page } from "@playwright/test";
import { CONFIG_PATH } from "@openlife/contracts/http/config";
import { execute, query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, expectNoViolations, signInFully, addRegisterTable, openColumns, deafToLiveEvents } from "./owner-session.ts";

const registers = locale("en", "registers");
const designer = locale("en", "designer");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replace(`{{${name}}}`, String(value)), text(registers, key));
const NORMA = { symbol: "norma_czytania", displayName: "Norma czytania", value: "20", description: "Syntetyczna konfiguracja do przyszłych widgetów" };
const addDialog = (page: Page) => page.getByRole("dialog", { name: text(registers, "config.dialog.add") });
const editDialog = (page: Page, name: string) => page.getByRole("dialog", { name: say("config.dialog.edit", { name }) });
const row = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
const newEntry = (page: Page) => page.getByRole("button", { name: text(registers, "config.new") });

type Stored = { symbol: string; display_name: string; value: string; type: string; description: string; revision: number };
const stored = (owner: BrowserOwner) => query<Stored>(owner.instance, "SELECT symbol, display_name, value, typeof(value) AS type, description, revision FROM config_entry ORDER BY created_at, id");
const audits = (owner: BrowserOwner) => query<{ action: string; details: string }>(owner.instance, "SELECT action, details FROM audit_log WHERE action LIKE 'config.%' ORDER BY rowid").map((entry) => [entry.action, JSON.parse(entry.details) as unknown]);

/** The entry of F01 through the API and /config open. */
async function withNorma(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  expect((await page.request.post(`${owner.baseUrl}${CONFIG_PATH}`, { data: NORMA, headers: { Origin: owner.baseUrl } })).status()).toBe(201);
  await page.goto(`${owner.baseUrl}/config`);
  await expect(row(page, NORMA.displayName)).toBeVisible();
}

test.describe("D25.3-AC1 the entry of F01 in the browser without SQL", () => {
  test("is added from /registers, shown with its path, value and bindings, changed and deleted; the value is text and the audit holds both values", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByText(say("config.count_other", { count: 0 }))).toBeVisible();
    await page.getByRole("link", { name: text(registers, "config.title") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/config`);
    await expect(page.getByText(text(registers, "config.empty"))).toBeVisible();
    // The page says what the entries are for, and that no widget of this version reads them.
    await expect(page.getByText(text(registers, "config.lead"))).toBeVisible();

    await newEntry(page).click();
    const dialog = addDialog(page);
    await dialog.getByLabel(text(registers, "config.dialog.name"), { exact: true }).fill(NORMA.displayName);
    await expect(dialog.getByLabel(text(registers, "form.symbol"), { exact: true })).toHaveValue(NORMA.symbol);
    await dialog.getByLabel(text(registers, "config.dialog.value"), { exact: true }).fill(NORMA.value);
    await expect(dialog.getByText(say("config.dialog.valueCount", { length: 2, max: 10000 }))).toBeVisible();
    await dialog.getByLabel(text(registers, "config.dialog.description"), { exact: true }).fill(NORMA.description);
    await expectNoViolations(page);
    await dialog.getByRole("button", { name: text(registers, "config.dialog.create") }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(say("config.done.add", { name: NORMA.displayName }));
    await expect(newEntry(page)).toBeFocused();
    const shown = row(page, NORMA.displayName);
    await expect(shown.getByRole("cell")).toHaveText(["Field.Config.norma_czytania", "20", NORMA.description, "0", ""]);
    expect(stored(owner)).toEqual([{ symbol: NORMA.symbol, display_name: NORMA.displayName, value: "20", type: "text", description: NORMA.description, revision: 1 }]);

    // A change: the symbol is fixed, the value is saved as typed.
    await page.getByRole("button", { name: say("config.edit", { name: NORMA.displayName }) }).click();
    const edit = editDialog(page, NORMA.displayName);
    await expect(edit.getByText("Field.Config.norma_czytania")).toBeVisible();
    await expect(edit.getByLabel(text(registers, "form.symbol"), { exact: true })).toHaveCount(0);
    await expect(edit.getByRole("button", { name: text(registers, "record.save"), exact: true })).toBeDisabled();
    await edit.getByLabel(text(registers, "config.dialog.value"), { exact: true }).fill("25 stron");
    await edit.getByRole("button", { name: text(registers, "record.save"), exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(say("config.done.edit", { name: NORMA.displayName }));
    await expect(page.getByRole("button", { name: say("config.edit", { name: NORMA.displayName }) })).toBeFocused();
    await expect(shown).toContainText("25 stron");
    expect(stored(owner)[0]).toMatchObject({ value: "25 stron", revision: 2 });

    // A delete with no binding says so.
    await page.getByRole("button", { name: say("config.remove", { name: NORMA.displayName }) }).click();
    const question = page.getByRole("dialog", { name: say("config.delete.question", { name: NORMA.displayName }) });
    await expect(question).toContainText(text(registers, "config.delete.unbound"));
    await question.getByRole("button", { name: text(registers, "config.delete.confirm") }).click();
    await expect(page.getByRole("status")).toHaveText(say("config.done.delete", { name: NORMA.displayName }));
    await expect(page.getByText(text(registers, "config.empty"))).toBeVisible();
    await expect(newEntry(page)).toBeFocused();
    expect(stored(owner)).toEqual([]);
    expect(audits(owner)).toEqual([
      ["config.created", { symbol: NORMA.symbol, value: "20" }],
      ["config.updated", { symbol: NORMA.symbol, oldValue: "20", newValue: "25 stron" }],
      ["config.deleted", { symbol: NORMA.symbol, oldValue: "25 stron", bindings: 0 }],
    ]);
  });
});

test.describe("D25.3-AC2 what the window refuses, a second tab and the bindings", () => {
  test("a bad symbol and an overlong value are told at the field and nothing is sent; a taken symbol too", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await withNorma(page, owner);
    let posts = 0;
    await page.route(`**${CONFIG_PATH}`, (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.continue();
    });
    await newEntry(page).click();
    const dialog = addDialog(page);
    const symbol = dialog.getByLabel(text(registers, "form.symbol"), { exact: true });
    await dialog.getByLabel(text(registers, "config.dialog.name"), { exact: true }).fill("Data urlopu");
    await symbol.fill("Zły symbol");
    await expect(symbol).toHaveAccessibleDescription(new RegExp(text(registers, "issues.SYMBOL_PATTERN").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await symbol.fill(NORMA.symbol);
    await expect(dialog.getByText(text(registers, "config.issues.SYMBOL_TAKEN"))).toBeVisible();
    await symbol.fill("data_urlopu");
    const value = dialog.getByLabel(text(registers, "config.dialog.value"), { exact: true });
    await value.fill("ł".repeat(10_001));
    await expect(dialog.getByText(text(registers, "config.issues.VALUE_TOO_LONG"))).toBeVisible();
    await dialog.getByRole("button", { name: text(registers, "config.dialog.create") }).click();
    await expect(dialog).toBeVisible();
    expect(posts).toBe(0);

    // Fixed, it is sent once; the empty description and the value as typed.
    await value.fill(" 2027-07-01 ");
    await dialog.getByRole("button", { name: text(registers, "config.dialog.create") }).click();
    await expect(dialog).toHaveCount(0);
    expect(posts).toBe(1);
    expect(stored(owner).find((each) => each.symbol === "data_urlopu")).toMatchObject({ value: " 2027-07-01 ", description: "" });
  });

  test("a save from a second tab first: the window tells it, keeps what was typed, and saves it only when the owner says so", async ({ page, ownerServer }) => {
    await deafToLiveEvents(page);
    const owner = await ownerServer("ready");
    await withNorma(page, owner);
    const other = await page.context().newPage();
    await other.goto(`${owner.baseUrl}/config`);
    await page.getByRole("button", { name: say("config.edit", { name: NORMA.displayName }) }).click();
    await other.getByRole("button", { name: say("config.edit", { name: NORMA.displayName }) }).click();
    await editDialog(other, NORMA.displayName).getByLabel(text(registers, "config.dialog.value"), { exact: true }).fill("30");
    await editDialog(other, NORMA.displayName).getByRole("button", { name: text(registers, "record.save"), exact: true }).click();
    await expect(editDialog(other, NORMA.displayName)).toHaveCount(0);

    const mine = editDialog(page, NORMA.displayName);
    await mine.getByLabel(text(registers, "config.dialog.value"), { exact: true }).fill("40");
    await mine.getByRole("button", { name: text(registers, "record.save"), exact: true }).click();
    const conflict = mine.getByRole("alert").filter({ hasText: text(registers, "config.conflict.changed") });
    await expect(conflict).toContainText(text(registers, "config.conflict.kept"));
    await expect(mine.getByLabel(text(registers, "config.dialog.value"), { exact: true })).toHaveValue("40");
    await expect(mine.getByRole("button", { name: text(registers, "record.save"), exact: true })).toBeDisabled();
    expect(stored(owner)[0]).toMatchObject({ value: "30", revision: 2 });

    await conflict.getByRole("button", { name: text(registers, "config.conflict.overwrite") }).click();
    await expect(mine).toHaveCount(0);
    await expect(row(page, NORMA.displayName)).toContainText("40");
    expect(stored(owner)[0]).toMatchObject({ value: "40", revision: 3 });

    // The other tab, on its old revision, loads the stored version instead.
    await other.getByRole("button", { name: say("config.edit", { name: NORMA.displayName }) }).click();
    const theirs = editDialog(other, NORMA.displayName);
    await expect(theirs.getByLabel(text(registers, "config.dialog.value"), { exact: true })).toHaveValue("30");
    await theirs.getByLabel(text(registers, "config.dialog.value"), { exact: true }).fill("50");
    await theirs.getByRole("button", { name: text(registers, "record.save"), exact: true }).click();
    await theirs.getByRole("alert").getByRole("button", { name: text(registers, "config.conflict.load") }).click();
    await expect(theirs.getByLabel(text(registers, "config.dialog.value"), { exact: true })).toHaveValue("40");
    expect(stored(owner)[0]).toMatchObject({ value: "40", revision: 3 });
  });

  test("the delete warns of the bindings that point at the entry; the Designer offers the register table nothing of ConfigTable", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await withNorma(page, owner);
    // A type that binds an entry comes after the MVP: its rows stand for it.
    const [entry] = query<{ id: string }>(owner.instance, "SELECT id FROM config_entry");
    const [user] = query<{ id: string }>(owner.instance, 'SELECT id FROM "user"');
    const screen = "019a0000-0000-7000-8000-0000000d2531";
    const widget = "019a0000-0000-7000-8000-0000000d2532";
    const layout = JSON.stringify({ phone: { x: 0, y: 0, w: 1, h: 4 }, tablet: { x: 0, y: 0, w: 4, h: 4 }, desktop: { x: 0, y: 0, w: 4, h: 4 } });
    execute(owner.instance, `INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('${screen}', '${user!.id}', 'Ekran', 'dark', 'blue', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
      INSERT INTO widget (id, screen_id, position, type, config, layout, state) VALUES ('${widget}', '${screen}', 0, 'progress', '{"v":1}', '${layout}', 'ok');
      INSERT INTO binding (widget_id, slot, ordinal, position, path, target) VALUES ('${widget}', 'norm', 0, 0, 'Field.Config.norma_czytania', '${JSON.stringify({ kind: "config", entryId: entry!.id })}');`);
    await page.reload();
    await expect(row(page, NORMA.displayName).getByRole("cell").nth(3)).toHaveText("1");
    await page.getByRole("button", { name: say("config.remove", { name: NORMA.displayName }) }).click();
    const question = page.getByRole("dialog", { name: say("config.delete.question", { name: NORMA.displayName }) });
    await expect(question).toContainText(say("config.delete.bound_one", { count: 1 }));
    await expect(question.getByRole("button", { name: text(registers, "record.cancel") })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(page.getByRole("button", { name: say("config.remove", { name: NORMA.displayName }) })).toBeFocused();
    expect(stored(owner)).toHaveLength(1);

    // The Designer: a register table bound to Książki is offered its columns only.
    await createRegistry(page, owner, BOOKS_DEFINITION);
    execute(owner.instance, `DELETE FROM binding; DELETE FROM widget; DELETE FROM screen;`);
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await addRegisterTable(page);
    await page.getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Książki (ksiazki)" });
    await expect((await openColumns(page)).getByRole("checkbox", { name: "Tytuł" })).toBeVisible();
    const body = await page.locator("main").innerText();
    expect(body).not.toContain("Field.Config");
    expect(body).not.toContain("Field.System");
    expect(body).not.toContain(NORMA.displayName);
  });

  test("on a phone the page does not scroll sideways and the table scrolls in its region; the keyboard opens and closes the window; axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.setViewportSize({ width: 390, height: 844 });
    await withNorma(page, owner);
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await expect(newEntry(page)).toBeInViewport();
    await expectNoViolations(page);

    await newEntry(page).focus();
    await page.keyboard.press("Enter");
    await expect(addDialog(page).getByLabel(text(registers, "config.dialog.name"), { exact: true })).toBeVisible();
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(addDialog(page)).toHaveCount(0);
    await expect(newEntry(page)).toBeFocused();
  });
});
