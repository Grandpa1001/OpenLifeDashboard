// D18.3 — the vertical path of D18 without SQL and without a test API (Scope S5, S6): a registry
// from its form, a register table in the Designer, a different arrangement in each of the three
// layouts made with the mouse, a save, a restart of the server, the screen in the three widths, and
// a record added from the widget. The owner's own database is never touched; the owner is the
// fixture installation of the test.
// AC1: after the restart the widget is where each layout put it, and a record added from /main works.
import type { Locator, Page } from "@playwright/test";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
const registers = locale("en", "registers");
const widgets = locale("en", "widgets");

test.use({ locale: "en-US", viewport: { width: 1600, height: 1000 } });

const HANDLE = "Select widget: Register table";

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

const centre = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Where the widget stands in the grid of the screen, in columns and rows. */
async function cellOf(page: Page): Promise<{ x: number; y: number; w: number }> {
  const grid = await page.locator(".screen-grid").boundingBox();
  const card = await page.locator("section.widget").first().boundingBox();
  const columns = ({ phone: 1, tablet: 8, desktop: 12 } as const)[(await page.locator(".screen-grid").getAttribute("data-layout")) as "phone" | "tablet" | "desktop"];
  if (grid === null || card === null) throw new Error("the screen is not drawn");
  const column = (grid.width - (columns - 1) * 16) / columns;
  return { x: Math.round((card.x - grid.x) / (column + 16)), y: Math.round((card.y - grid.y) / 48), w: Math.round((card.width + 16) / (column + 16)) };
}

test.describe("D18.3-AC1 registry, Designer, three layouts, restart, record", () => {
  test("a widget made without SQL keeps its place in the phone, tablet and desktop layout over a restart, and takes a record", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);

    // The registry from its form.
    await page.goto(`${owner.baseUrl}/registers`);
    await page.getByRole("button", { name: text(registers, "list.new") }).click();
    await page.getByLabel(text(registers, "form.name"), { exact: true }).fill("Książki");
    const first = page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "1") });
    await first.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Tytuł");
    await first.getByLabel(text(registers, "form.required"), { exact: true }).check();
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "2") }).getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Autor");
    await page.getByRole("button", { name: text(registers, "form.create") }).click();
    await expect(page.getByRole("status")).toHaveText(text(registers, "form.created").replace("{{name}}", "Książki"));

    // The widget in the Designer, bound to the registry and two columns.
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await page.getByRole("button", { name: "Add: Register table" }).click();
    await page.getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Książki (ksiazki)" });
    await page.getByRole("checkbox", { name: "Tytuł" }).check();
    await page.getByRole("checkbox", { name: "Autor" }).check();

    // A different arrangement in each layout, each made with the mouse.
    const layoutButton = (name: string) => page.getByRole("button", { name: text(designer, `toolbar.${name}`), exact: true });
    const frame = (name: string) => page.getByRole("group", { name: `Screen layout: ${text(designer, `toolbar.${name}`)}` });
    const handle = page.getByRole("button", { name: HANDLE });

    await layoutButton("phone").click();
    await expect(frame("phone")).toBeVisible();
    await dragBy(page, await centre(handle), 0, 2 * 48);

    await layoutButton("tablet").click();
    await expect(frame("tablet")).toBeVisible();
    const tabletColumn = (768 - 7 * 16) / 8 + 16;
    await expect(async () => {
      const corner = page.locator(".react-resizable-handle-se");
      await dragBy(page, await centre(corner), -Math.round(2 * tabletColumn), 0);
      await expect(page.locator(".designer-widget")).toHaveCSS("width", "572px");
    }).toPass({ timeout: 15_000 });

    await layoutButton("desktop").click();
    await expect(frame("desktop")).toBeVisible();
    const desktopColumn = (1200 - 11 * 16) / 12 + 16;
    await dragBy(page, await centre(handle), Math.round(2 * desktopColumn), 48);

    await page.getByRole("button", { name: text(designer, "toolbar.save"), exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: text(designer, "toolbar.saved") })).toBeVisible();
    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await page.waitForLoadState("networkidle");

    // The server stops and starts again on the same data.
    await owner.restart();
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page.locator("section.widget")).toHaveCount(1);
    await expect(page.getByText(text(widgets, "registerTable.empty"))).toBeVisible();
    expect(await cellOf(page)).toEqual({ x: 2, y: 1, w: 8 });

    await page.setViewportSize({ width: 900, height: 1000 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "tablet");
    await expect(async () => expect(await cellOf(page)).toEqual({ x: 0, y: 0, w: 6 })).toPass();

    await page.setViewportSize({ width: 375, height: 800 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "phone");
    await expect(async () => expect(await cellOf(page)).toEqual({ x: 0, y: 2, w: 1 })).toPass();

    // A record added from the widget, on the first page after the answer.
    await page.setViewportSize({ width: 1600, height: 1000 });
    const card = page.locator("section.widget").first();
    await card.getByRole("button", { name: text(widgets, "registerTable.add"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: text(registers, "record.add") });
    await dialog.getByLabel("Tytuł").fill("Solaris");
    await dialog.getByLabel("Autor").fill("Lem");
    await dialog.getByRole("button", { name: text(registers, "record.save") }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByRole("cell", { name: "Solaris" })).toBeVisible();
    await expect(card.getByRole("columnheader")).toHaveText(["Tytuł", "Autor"]);
    await page.reload();
    await expect(card.getByRole("cell", { name: "Lem" })).toBeVisible();
    await expectNoViolations(page);
  });
});
