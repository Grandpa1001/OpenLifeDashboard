// D34.3 — the context bar at the widths of a phone, a tablet and a laptop (Scope §5.4, §6.2; makiety
// 27, 36, 46) on Książki of F01.
// AC1: at 390 px a selection opens the settings as a sheet from the bottom with the groups, Done and
//      Escape close it with the focus on the tile, and the page does not scroll sideways; at 1024 and
//      1440 px the bar is above the grid and never over it.
// AC2: a register table set up only in the bar (registry, the columns in their order, the sort, a page
//      of 2, Adding, the title) is on the screen as Scope §6.2 describes it; axe.
import type { Locator, Page } from "@playwright/test";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, addRegisterTable, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, openColumns, signInFully, designerSaved } from "./owner-session.ts";

const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
test.use({ locale: "en-US" });

const A = "019a0000-0000-7000-8000-0000000034d1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };
const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const sideways = async (page: Page) => (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };

test.describe("D34.3-AC1 the bar at the widths of a phone, a tablet and a laptop", () => {
  test("390 px: the settings are a sheet from the bottom closed by Done and Escape on the tile, no sideways scroll; 1024 and 1440 px: the bar is above the grid", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${owner.baseUrl}/designer`);
    const tile = page.getByRole("button", { name: "Select widget: Moje" });
    await tile.click();
    const sheet = bar(page);
    await expect(sheet.getByRole("button", { name: text(designer, "bar.done") })).toBeVisible();
    const box = (await sheet.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    expect(box.width).toBe(390);
    for (const group of [text(designer, "panel.heading"), text(designer, "bar.appearance"), text(designer, "bar.behaviour")]) await expect(sheet.getByText(group, { exact: true }).first()).toBeAttached();
    expect((await sideways(page)).page).toBeLessThanOrEqual(390);
    await expectNoViolations(page);
    await sheet.getByRole("button", { name: text(designer, "bar.done") }).click();
    await expect(tile).toBeFocused();
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page).getByRole("button", { name: text(designer, "bar.done") })).toHaveCount(0);

    await tile.click();
    await bar(page).getByLabel(text(designer, "bar.title"), { exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(tile).toBeFocused();
    await expect(bar(page).getByRole("button", { name: text(designer, "bar.done") })).toHaveCount(0);

    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await tile.click();
      await expect(bar(page).getByRole("button", { name: text(designer, "bar.done") })).toHaveCount(0);
      const above = (await bar(page).boundingBox())!;
      const grid = (await page.locator(".designer-frame").boundingBox())!;
      expect(above.y + above.height, `${width} px`).toBeLessThanOrEqual(grid.y);
      expect((await sideways(page)).page, `${width} px`).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
    }
  });
});

test.describe("D34.3-AC2 a register table set up in the bar only", () => {
  test("the registry, the columns in their order, the sort, a page of 2, Adding and the title from the bar are the table on the screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    for (const [index, title] of ["Morze", "Anatomia", "Zorza", "Bursztyn", "Kamień"].entries()) await addRecordByApi(page, owner, "ksiazki", { tytul: title, autor: `Autor ${index}` }, `seed-key-00${index}`);

    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await addRegisterTable(page);
    await bar(page).getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Książki (ksiazki)" });
    // Autor and Tytuł in that order: All leaves Tytuł, then Autor is chosen and moved up.
    const list = await openColumns(page);
    await list.getByRole("checkbox", { name: text(designer, "bar.allColumns"), exact: true }).check();
    await list.getByRole("checkbox", { name: text(designer, "bar.allColumns"), exact: true }).uncheck();
    const rows = list.getByRole("list", { name: text(designer, "panel.columns") });
    await rows.getByRole("checkbox", { name: "Autor", exact: true }).check();
    await rows.getByRole("checkbox", { name: "Autor", exact: true }).press("Alt+ArrowUp");
    await page.keyboard.press("Escape");
    await bar(page).getByLabel(text(designer, "panel.sort"), { exact: true }).selectOption({ label: "Tytuł" });
    await bar(page).getByLabel(text(designer, "panel.direction"), { exact: true }).selectOption({ label: text(designer, "panel.asc") });
    await bar(page).getByLabel(text(designer, "bar.title"), { exact: true }).fill("Półka");
    await bar(page).getByLabel(text(designer, "bar.pageSizeWithRange").replace("{{min}}", "1").replace("{{max}}", "100"), { exact: true }).fill("2");
    await expect(bar(page).getByRole("switch", { name: text(designer, "bar.allowAdd") })).toBeChecked();
    await expectNoViolations(page);
    await designerSaved(page);

    await toolbarButton(page, "toolbar.finish").click();
    const card = page.locator("section.widget");
    await expect(card.getByRole("heading", { name: "Półka" })).toBeVisible();
    await expect(card.getByRole("columnheader")).toHaveText(["Autor", "Tytuł"]);
    await expect(card.getByRole("row")).toHaveCount(3);
    await expect(card.getByRole("row").nth(1)).toContainText("Anatomia");
    await expect(card.getByRole("row").nth(2)).toContainText("Bursztyn");
    await expect(card.getByText(text(widgets, "registerTable.page").replace("{{page}}", "1").replace("{{pages}}", "3"))).toBeVisible();
    await expect(card.getByRole("button", { name: text(widgets, "registerTable.add") })).toBeVisible();
    await expectNoViolations(page);
  });
});
