// D34.1 — the context bar of the Designer in a real browser (Scope §5.4, §6.2; makiety 27, 34, 36, 45)
// on Książki of F01: the window "Add widget", a new widget with Powiązania only, all the columns and a
// page of 10 once the registry is chosen, the size by number, the title, the page size and Adding,
// Duplicate and Delete.
// AC1: the window lists the type of the catalog; the new widget is selected with the focus on Registry;
//      Książki gives all its columns and a page of 10, saved and on the screen; 6 × 5 changes the layout
//      being arranged only and 1 × 1 gives the minimum; the title, a page of 25 and Adding off are saved
//      and shown; Duplicate makes a copy with a new id, the same bindings and "(copy)", Delete removes.
// AC2: a page size of 0 and 101 is told at the field and changes nothing; another registry after a
//      choice of columns asks, and Cancel keeps it; Escape lets go and gives the focus to the tile; the
//      order of Tab follows the groups; a selection does not move the grid; axe.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully, designerSaved } from "./owner-session.ts";

const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000034b1";
type Rect = { x: number; y: number; w: number; h: number };
type Layout = Record<"phone" | "tablet" | "desktop", Rect>;
type Saved = Array<{ id: string; config: Record<string, unknown>; layout: Layout; bindings: Array<{ slot: string; ordinal: number; path: string }> }>;
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const LAYOUT: Layout = { phone: r(0, 0, 1, 6), tablet: r(0, 0, 4, 6), desktop: r(0, 0, 4, 6) };
const BOOK_PATHS = BOOKS_DEFINITION.columns.map((column) => `Field.Register.ksiazki.${column.symbol}`);

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(designer, key));
const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const field = (page: Page, key: string, values: Record<string, string | number> = {}): Locator => bar(page).getByLabel(say(key, values), { exact: true });

async function saved(page: Page, owner: BrowserOwner): Promise<Saved> {
  await designerSaved(page);
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Saved }).widgets;
}

async function booksWithTable(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  await page.getByRole("button", { name: "Select widget: Moje" }).click();
  await expect(field(page, "panel.registry")).toBeVisible();
}

test.describe("D34.1-AC1 the window, a new widget and the groups of the bar", () => {
  test("the window lists the type of the catalog; the new widget has Powiązania only and the focus on Registry; Książki gives all its columns and a page of 10 on the screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris", autor: "Lem" }, "seed-key-001");
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await expect(bar(page)).toContainText(text(designer, "bar.none"));

    await bar(page).getByRole("button", { name: text(designer, "bar.addWidget"), exact: true }).click();
    const catalog = page.getByRole("dialog", { name: text(designer, "palette.heading") });
    await expect(catalog).toContainText(say("palette.available", { count: 1, total: 1 }));
    const type = catalog.getByRole("button", { name: "Add: Register table" });
    await expect(type).toHaveAccessibleDescription(text(widgets, "typeDescriptions.register-table"));
    await expectNoViolations(page);
    await type.click();
    await expect(catalog).toBeHidden();

    // Only Powiązania until the registry is chosen; Delete is there, Duplicate is not.
    await expect(page.getByRole("button", { name: "Select widget: Register table" })).toHaveAttribute("aria-pressed", "true");
    await expect(field(page, "panel.registry")).toBeFocused();
    await expect(field(page, "bar.width")).toBeDisabled();
    await expect(field(page, "bar.title")).toBeDisabled();
    await expect(bar(page).getByRole("switch", { name: text(designer, "bar.allowAdd") })).toBeDisabled();
    await expect(bar(page).getByRole("button", { name: text(designer, "bar.duplicate") })).toBeDisabled();
    await expect(bar(page).getByRole("button", { name: text(designer, "bar.delete") })).toBeEnabled();
    await expect(bar(page)).toContainText(text(designer, "bar.startWithRegistry"));
    await expectNoViolations(page);

    await field(page, "panel.registry").selectOption({ label: "Książki (ksiazki)" });
    await expect(bar(page).getByRole("button", { name: new RegExp(`^${text(designer, "panel.columns")} `) })).toHaveText(say("bar.columnsCount", { count: 9, total: 11 }));
    await expect(field(page, "bar.pageSizeWithRange", { min: 1, max: 100 })).toHaveValue("10");
    await expect(field(page, "bar.width")).toBeEnabled();
    const [table] = await saved(page, owner);
    expect(table!.bindings.filter((binding) => binding.slot === "columns").map((binding) => binding.path)).toEqual(BOOK_PATHS);
    await toolbarButton(page, "toolbar.finish").click();
    await expect(page.locator("section.widget").getByRole("columnheader")).toHaveText(BOOKS_DEFINITION.columns.map((column) => column.displayName));
  });

  test("6 × 5 changes the layout being arranged only, 1 × 1 gives the minimum; the title, a page of 25 and Adding off are saved and shown on the screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithTable(page, owner);
    await field(page, "bar.width").fill("6");
    await field(page, "bar.height").fill("5");
    await field(page, "bar.height").press("Enter");
    let [table] = await saved(page, owner);
    expect(table!.layout).toEqual({ ...LAYOUT, desktop: r(0, 0, 6, 5) });

    await field(page, "bar.width").fill("1");
    await field(page, "bar.height").fill("1");
    await field(page, "bar.height").press("Enter");
    await expect(field(page, "bar.width")).toHaveValue("3");
    await expect(field(page, "bar.height")).toHaveValue("4");
    await expect(bar(page)).toContainText(say("bar.sizeWithMinimum", { w: 3, h: 4 }));

    await field(page, "bar.title").fill("Do przeczytania");
    await field(page, "bar.pageSizeWithRange", { min: 1, max: 100 }).fill("25");
    await bar(page).getByRole("switch", { name: text(designer, "bar.allowAdd") }).uncheck();
    [table] = await saved(page, owner);
    expect(table!.layout.desktop).toEqual(r(0, 0, 3, 4));
    expect(table!.config).toMatchObject({ title: "Do przeczytania", pageSize: 25, allowAdd: false });
    await toolbarButton(page, "toolbar.finish").click();
    const card = page.locator("section.widget");
    await expect(card.getByRole("heading", { name: "Do przeczytania" })).toBeVisible();
    await expect(card.getByRole("button", { name: text(widgets, "registerTable.add") })).toHaveCount(0);
  });

  test("Duplicate makes a selected copy with a new id, the same bindings and (copy) at a free place; Delete removes it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithTable(page, owner);
    await field(page, "panel.registry").selectOption({ label: "Książki (ksiazki)" });
    await bar(page).getByRole("button", { name: text(designer, "bar.duplicate") }).click();
    const copy = page.getByRole("button", { name: `Select widget: Moje ${text(designer, "bar.copySuffix")}` });
    await expect(copy).toHaveAttribute("aria-pressed", "true");
    let all = await saved(page, owner);
    expect(all).toHaveLength(2);
    const [original, duplicate] = [all.find((each) => each.id === A)!, all.find((each) => each.id !== A)!];
    expect(duplicate.bindings).toEqual(original.bindings);
    expect(duplicate.config["title"]).toBe(`Moje ${text(designer, "bar.copySuffix")}`);
    expect(duplicate.layout.desktop).toEqual(r(4, 0, 4, 6));
    expect(duplicate.layout.phone).toEqual(r(0, 6, 1, 6));

    await bar(page).getByRole("button", { name: text(designer, "bar.delete") }).click();
    await expect(copy).toHaveCount(0);
    await expect(bar(page)).toContainText(text(designer, "bar.none"));
    all = await saved(page, owner);
    expect(all.map((each) => each.id)).toEqual([A]);
  });
});

test.describe("D34.1-AC2 what the bar refuses, asks and how it is used by the keyboard", () => {
  test("a page size of 0 and 101 is told at the field and changes nothing; another registry after a choice of columns asks, Cancel keeps it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithTable(page, owner);
    await createRegistry(page, owner, { symbol: "filmy", displayName: "Filmy", columns: [{ symbol: "tytul", displayName: "Tytuł filmu", type: "text" }] });
    await page.reload();
    await page.getByRole("button", { name: "Select widget: Moje" }).click();
    await field(page, "panel.registry").selectOption({ label: "Książki (ksiazki)" });
    await saved(page, owner);

    const pageSize = field(page, "bar.pageSizeWithRange", { min: 1, max: 100 });
    for (const wrong of ["0", "101"]) {
      await pageSize.fill(wrong);
      await expect(pageSize).toHaveAttribute("aria-invalid", "true");
      await expect(bar(page).getByText(say("bar.pageSizeInvalid", { min: 1, max: 100 }))).toBeVisible();
      await expect(page.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
    }
    await expectNoViolations(page);

    await field(page, "panel.registry").selectOption({ label: "Filmy (filmy)" });
    const question = bar(page).getByRole("alertdialog", { name: text(designer, "bar.registryChange") });
    await expect(question).toBeVisible();
    await question.getByRole("button", { name: text(designer, "bar.cancel") }).click();
    await expect(question).toHaveCount(0);
    await expect(field(page, "panel.registry").locator("option:checked")).toHaveText("Książki (ksiazki)");
    await expect(page.locator(".designer-status")).toHaveAttribute("data-dirty", "false");

    await field(page, "panel.registry").selectOption({ label: "Filmy (filmy)" });
    await question.getByRole("button", { name: text(designer, "bar.registryChangeConfirm") }).click();
    const [table] = await saved(page, owner);
    expect(table!.bindings.map((binding) => binding.path)).toEqual(["Field.Register.filmy", "Field.Register.filmy.tytul"]);
  });

  test("Tab goes Powiązania → Size → the actions → Appearance → Behaviour; Escape lets go and gives the focus to the tile; a selection does not move the grid", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    const frame = page.locator(".designer-frame");
    const unselected = (await frame.boundingBox())!.y;
    const tile = page.getByRole("button", { name: "Select widget: Moje" });
    await tile.click();
    await expect(field(page, "panel.registry")).toBeVisible();
    expect((await frame.boundingBox())!.y).toBe(unselected);

    await field(page, "panel.registry").focus();
    const order = [
      text(designer, "panel.columns"),
      text(designer, "panel.sort"),
      text(designer, "panel.direction"),
      text(designer, "bar.width"),
      text(designer, "bar.height"),
      text(designer, "bar.duplicate"),
      text(designer, "bar.delete"),
      text(designer, "bar.addWidget"),
      text(designer, "bar.title"),
      say("bar.pageSizeWithRange", { min: 1, max: 100 }),
      text(designer, "bar.allowAdd"),
    ];
    const names: string[] = [];
    for (let step = 0; step < order.length; step += 1) {
      await page.keyboard.press("Tab");
      names.push(await page.evaluate("(() => { const e = document.activeElement; const l = e && e.labels && e.labels[0]; return (l ? l.textContent : (e && (e.getAttribute('aria-labelledby') ? document.getElementById(e.getAttribute('aria-labelledby').split(' ')[0]).textContent : e.textContent))) || ''; })()"));
    }
    expect(names.map((name) => name.trim())).toEqual(order);

    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page)).toContainText(text(designer, "bar.none"));
    expect((await frame.boundingBox())!.y).toBe(unselected);
    await expectNoViolations(page);
  });
});
