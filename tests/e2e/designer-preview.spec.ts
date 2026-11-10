// D39.3 — the preview of the Designer in a real browser (Scope §5.4, makieta 47) on Książki of F01.
// AC1: the preview hides the grid, the handles and the bar; the widgets work as on the dashboard on real
//      data (the table adds a record, the clock goes); nothing is saved by looking.
// AC2: a widget with an unbound slot shows sample data, marked as such and saying what the dashboard will
//      show, in the preview only; leaving by the button or by Escape gives back the grid with the selection
//      and the focus on "Preview".
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
const registers = locale("en", "registers");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const BOUND = "019a0000-0000-7000-8000-0000000039b1";
const UNBOUND = "019a0000-0000-7000-8000-0000000039b2";
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const BOUND_AT = { phone: rect(0, 0, 1, 6), tablet: rect(0, 0, 4, 6), desktop: rect(0, 0, 4, 6) };
const UNBOUND_AT = { phone: rect(0, 6, 1, 6), tablet: rect(4, 0, 4, 6), desktop: rect(4, 0, 4, 6) };
const DESIGN = /\/api\/v1\/screens\/[^/]+\/design$/;

const table = (key: string): string => text(widgets, `registerTable.${key}`);
const previewButton = (page: Page): Locator => page.getByRole("button", { name: text(designer, "toolbar.preview"), exact: true });
const frame = (page: Page): Locator => page.getByRole("region", { name: text(designer, "preview.label") });
const handle = (page: Page, title: string): Locator => page.getByRole("button", { name: `Select widget: ${title}` });

async function twoTables(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris" }, "d39-3-solaris");
  await createScreenWith(page, owner, [
    { id: BOUND, title: "Moje", layout: BOUND_AT },
    { id: UNBOUND, title: "Puste", layout: UNBOUND_AT, draft: true },
  ]);
  await page.goto(`${owner.baseUrl}/designer`);
  await expect(handle(page, "Puste")).toBeVisible();
}

test.describe("D39.3-AC1 the preview works like the dashboard and saves nothing", () => {
  test("no grid, no handles and no bar; the table adds a record and shows it; the layout can be switched; nothing is sent", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    let saves = 0;
    page.on("request", (request) => {
      if (DESIGN.test(new URL(request.url()).pathname) && request.method() === "PUT") saves += 1;
    });

    await previewButton(page).click();
    await expect(page.getByText(text(designer, "preview.badge"))).toBeVisible();
    await expect(page.getByRole("region", { name: text(designer, "bar.label") })).toHaveCount(0);
    await expect(handle(page, "Moje")).toHaveCount(0);
    await expect(frame(page).getByRole("cell", { name: "Solaris", exact: true })).toBeVisible();

    await frame(page).getByRole("button", { name: table("add"), exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: text(registers, "record.add") });
    await dialog.getByLabel("Tytuł").fill("Z podglądu");
    await dialog.getByRole("button", { name: text(registers, "record.save") }).click();
    await expect(dialog).toHaveCount(0);
    await expect(frame(page).getByRole("cell", { name: "Z podglądu", exact: true })).toBeVisible();

    await page.getByRole("button", { name: text(designer, "toolbar.tablet"), exact: true }).click();
    await expect(frame(page)).toHaveAttribute("data-layout", "tablet");
    expect(saves).toBe(0);
  });
});

test.describe("D39.3-AC2 sample data only for an unbound widget, and the way back", () => {
  test("the unbound table shows marked sample data in the preview and asks to be configured on the dashboard; the bound one never shows a sample", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    await previewButton(page).click();
    const sample = frame(page).locator('[data-sample="true"]');
    await expect(sample).toHaveCount(1);
    await expect(sample.getByText(table("sample.data"), { exact: true })).toBeVisible();
    await expect(sample.getByText(table("sample.configure"))).toBeVisible();
    await expectNoViolations(page);
    await expect(frame(page).getByRole("cell", { name: "Solaris", exact: true })).toBeVisible();

    await page.goto(`${owner.baseUrl}/`);
    await expect(page.getByText(table("configure"))).toBeVisible();
    await expect(page.locator('[data-sample="true"]')).toHaveCount(0);
  });

  test("leaving by the button or by Escape gives back the grid with the same widget selected and the focus on Preview", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    for (const leave of ["button", "escape"] as const) {
      await handle(page, "Moje").click();
      await expect(handle(page, "Moje")).toHaveAttribute("aria-pressed", "true");
      await previewButton(page).click();
      await expect(frame(page)).toBeVisible();
      if (leave === "button") await page.getByRole("button", { name: text(designer, "preview.exit") }).click();
      else await page.keyboard.press("Escape");
      await expect(frame(page)).toHaveCount(0);
      await expect(handle(page, "Moje")).toHaveAttribute("aria-pressed", "true");
      await expect(previewButton(page)).toBeFocused();
    }
  });
});
