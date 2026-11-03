// D34.2 — the columns of the register table in the context bar in a real browser (Scope §5.4, §6.2;
// makieta 37, 27) on Książki of F01 with a table of Tytuł and Autor.
// AC1: Alt + ↓ and a drag of the handle change the order of the columns, the save gives the ordinals
//      in that order and the screen shows the columns in it; All chooses every column and then leaves
//      one; a sort column and its direction are what the screen sorts by.
// AC2: the last column cannot be let go; a removed column is shown by its path and Remove the binding
//      leaves the others, after which the widget is ok; Escape closes the list back on its field; axe.
import type { Locator, Page } from "@playwright/test";
import { structurePath, structurePreviewPath, structurePreviewSchema, REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, openColumns, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000034c1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };
type Saved = Array<{ id: string; state: string; config: Record<string, unknown>; bindings: Array<{ slot: string; ordinal: number; path: string }> }>;

const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const status = (page: Page): Locator => page.getByRole("status").filter({ hasText: /changes|Saved|Saving/ });
const columnsField = (page: Page): Locator => bar(page).getByRole("button", { name: new RegExp(`^${text(designer, "panel.columns")} `) });
const listed = async (list: Locator): Promise<string[]> => (await list.getByRole("listitem").allInnerTexts()).map((each) => each.replace("⠿", "").trim());

async function saved(page: Page, owner: BrowserOwner): Promise<Saved> {
  await toolbarButton(page, "toolbar.save").click();
  await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
  const screens = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screens.screens[0]!.id}`)).json()) as { widgets: Saved }).widgets;
}
const columnPaths = (widget: Saved[number]): string[] => widget.bindings.filter((binding) => binding.slot === "columns").sort((a, b) => a.ordinal - b.ordinal).map((binding) => binding.path.replace("Field.Register.ksiazki.", ""));

async function tableOfTwo(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (const [index, title] of ["Morze", "Anatomia", "Zorza"].entries()) await addRecordByApi(page, owner, "ksiazki", { tytul: title, autor: `Autor ${index}`, strony: 100 + index }, `seed-key-00${index}`);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", columns: ["tytul", "autor"], layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  await page.getByRole("button", { name: "Select widget: Moje" }).click();
}

test.describe("D34.2-AC1 the order of the columns, All and the sort", () => {
  test("Alt + ↓ and a drag of the handle order the columns, the save and the screen follow; All chooses every column, then leaves one; the sort is the screen's", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableOfTwo(page, owner);
    const list = (await openColumns(page)).getByRole("list", { name: text(designer, "panel.columns") });
    expect((await listed(list)).slice(0, 3)).toEqual(["Tytuł", "Autor", "Liczba stron"]);
    await expectNoViolations(page);

    // Alt + ↓ on Tytuł: Autor, Tytuł.
    await list.getByRole("checkbox", { name: "Tytuł", exact: true }).focus();
    await page.keyboard.press("Alt+ArrowDown");
    expect((await listed(list)).slice(0, 2)).toEqual(["Autor", "Tytuł"]);
    await expect(list.getByRole("checkbox", { name: "Tytuł", exact: true })).toBeFocused();
    // Liczba stron chosen comes last; dragged by its handle onto Autor it goes first.
    await list.getByRole("checkbox", { name: "Liczba stron", exact: true }).check();
    await list.getByRole("img", { name: "Move the column Liczba stron" }).dragTo(list.getByRole("listitem").filter({ hasText: "Autor" }));
    expect((await listed(list)).slice(0, 3)).toEqual(["Liczba stron", "Autor", "Tytuł"]);
    await expect(columnsField(page)).toHaveText("3 of 11");

    // The sort: Tytuł ascending.
    await page.keyboard.press("Escape");
    await bar(page).getByLabel(text(designer, "panel.sort"), { exact: true }).selectOption({ label: "Tytuł" });
    await bar(page).getByLabel(text(designer, "panel.direction"), { exact: true }).selectOption({ label: text(designer, "panel.asc") });
    const [table] = await saved(page, owner);
    expect(columnPaths(table!)).toEqual(["strony", "autor", "tytul"]);
    expect(table!.bindings.find((binding) => binding.slot === "sortColumn")?.path).toBe("Field.Register.ksiazki.tytul");
    expect(table!.config["sortDirection"]).toBe("asc");

    await toolbarButton(page, "toolbar.finish").click();
    const card = page.locator("section.widget");
    await expect(card.getByRole("columnheader")).toHaveText(["Liczba stron", "Autor", "Tytuł"]);
    await expect(card.getByRole("row").nth(1)).toContainText("Anatomia");
    await expect(card.getByRole("row").nth(3)).toContainText("Zorza");

    // All: every column, then only the first chosen one.
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: "Select widget: Moje" }).click();
    const again = await openColumns(page);
    const all = again.getByRole("checkbox", { name: text(designer, "bar.allColumns"), exact: true });
    await all.check();
    await expect(columnsField(page)).toHaveText("11 of 11");
    await all.uncheck();
    await expect(columnsField(page)).toHaveText("1 of 11");
    expect((await listed(again.getByRole("list", { name: text(designer, "panel.columns") })))[0]).toBe("Liczba stron");
  });
});

test.describe("D34.2-AC2 the last column, a removed one and the keyboard", () => {
  test("the last column cannot be let go; Escape closes the list on its field; a removed Autor is shown by its path and Remove the binding leaves Tytuł, the widget ok", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableOfTwo(page, owner);
    const list = await openColumns(page);
    await list.getByRole("checkbox", { name: "Autor", exact: true }).uncheck();
    await expect(list.getByRole("checkbox", { name: "Tytuł", exact: true })).toBeDisabled();
    await expect(list.getByRole("checkbox", { name: "Tytuł", exact: true })).toBeChecked();
    await list.getByRole("checkbox", { name: "Liczba stron", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(columnsField(page)).toBeFocused();
    await expect(columnsField(page)).toHaveAttribute("aria-expanded", "false");
    // The widget stays selected: the first Escape is the list's.
    await expect(page.getByRole("button", { name: "Select widget: Moje" })).toHaveAttribute("aria-pressed", "true");
    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));

    // Autor back in the table, then removed from Książki through the structure: a broken binding.
    await openColumns(page).then((again) => again.getByRole("checkbox", { name: "Autor", exact: true }).check());
    let [table] = await saved(page, owner);
    expect(columnPaths(table!)).toEqual(["tytul", "autor"]);
    const registry = registryListSchema.parse(await (await page.request.get(`${owner.baseUrl}${REGISTRIES_PATH}`)).json()).registries.find((each) => each.symbol === "ksiazki")!;
    const change = { kind: "removeColumn", columnId: registry.columns.find((column) => column.symbol === "autor")!.id };
    const preview = structurePreviewSchema.parse(await (await page.request.post(`${owner.baseUrl}${structurePreviewPath("ksiazki")}`, { data: { change }, headers: { Origin: owner.baseUrl } })).json());
    expect((await page.request.post(`${owner.baseUrl}${structurePath("ksiazki")}`, { data: { change, planToken: preview.planToken }, headers: { Origin: owner.baseUrl } })).status()).toBe(200);

    await page.reload();
    await page.getByRole("button", { name: "Select widget: Moje" }).click();
    const missing = bar(page).getByRole("list", { name: text(designer, "panel.missing") });
    await expect(missing).toContainText("Field.Register.ksiazki.autor");
    // The other groups stay usable beside the broken binding.
    await expect(bar(page).getByLabel(text(designer, "bar.title"), { exact: true })).toBeEnabled();
    await expectNoViolations(page);
    await bar(page).getByRole("button", { name: text(designer, "bar.removeBinding") }).click();
    await expect(missing).toHaveCount(0);
    [table] = await saved(page, owner);
    expect(columnPaths(table!)).toEqual(["tytul"]);
    expect(table!.state).toBe("ok");
  });
});
