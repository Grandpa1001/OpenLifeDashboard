// D18.1 — the private screen `/main` in a real browser (Scope §5.3, §6.2): the widgets of the screen
// on the grid of the layout the window calls for, the register table with its pages and the window
// that adds a record, and what a widget says when it cannot show data.
// AC1: the screen of F01 shows the 25 records as pages of 10, 10 and 5 with only the bound columns,
//      the window adds a record that is on the first page after the server's answer, and the phone,
//      the tablet and the desktop each use their own layout.
// AC2: an empty screen invites to the Designer; a draft, a broken binding and a configuration to
//      confirm say so with a link; a widget that fails to draw does not take the screen with it; a
//      failing read has "try again"; an ended session leads to the sign-in; axe.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully, type WidgetPlan } from "./owner-session.ts";

const common = locale("en");
const widgets = locale("en", "widgets");
const registers = locale("en", "registers");
const errors = locale("en", "errors");

test.use({ locale: "en-US" });

const A = "019a0000-0000-7000-8000-00000000019a";
const B = "019a0000-0000-7000-8000-00000000019d";
const table = (key: string) => text(widgets, `registerTable.${key}`);
const widgetOf = (page: Page, title: string): Locator => page.getByRole("region", { name: title }).or(page.locator(`section.widget:has(h2:text-is("${title}"))`)).first();

const HALVES = {
  a: { id: A, title: "Pierwsza", layout: { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 4, h: 8 }, desktop: { x: 0, y: 0, w: 6, h: 8 } } },
  b: { id: B, title: "Druga", layout: { phone: { x: 0, y: 8, w: 1, h: 8 }, tablet: { x: 4, y: 0, w: 4, h: 8 }, desktop: { x: 6, y: 0, w: 6, h: 8 } } },
} satisfies Record<string, WidgetPlan>;

async function books(page: Page, owner: BrowserOwner, records = 0): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (let index = 1; index <= records; index += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${String(index).padStart(2, "0")}`, autor: "Autor", cena: 1000 + index }, `seed-key-${String(index).padStart(3, "0")}`);
}

test.describe("D18.1-AC1 the register table on the screen", () => {
  test("the 25 records of F01 as pages of 10, 10 and 5 with the bound columns only, and a record added from the window is on the first page", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 25);
    await createScreenWith(page, owner, [{ id: A, title: "Moje książki", layout: HALVES.a.layout }]);
    await page.goto(`${owner.baseUrl}/main`);

    const card = widgetOf(page, "Moje książki");
    await expect(card.getByRole("columnheader")).toHaveText(["Tytuł", "Autor"]);
    await expect(card.getByRole("row")).toHaveCount(11);
    await expect(card.getByText("Page 1 of 3")).toBeVisible();
    await expect(card.getByText("25 records in total")).toBeVisible();
    await expect(card.getByRole("cell", { name: "Książka 25" })).toBeVisible();
    await expect(card.getByRole("cell", { name: "Książka 16" })).toBeVisible();
    await expectNoViolations(page);

    await card.getByRole("button", { name: table("next") }).click();
    await expect(card.getByText("Page 2 of 3")).toBeVisible();
    await expect(card.getByRole("cell", { name: "Książka 15" })).toBeVisible();
    await card.getByRole("button", { name: table("next") }).click();
    await expect(card.getByText("Page 3 of 3")).toBeVisible();
    await expect(card.getByRole("row")).toHaveCount(6);
    await expect(card.getByRole("button", { name: table("next") })).toBeDisabled();

    // The window shows the whole structure of the registry, not the two columns of the widget; the record is on the first page after the answer.
    await card.getByRole("button", { name: table("add"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: text(registers, "record.add") });
    await expect(dialog.locator("input, select")).toHaveCount(9);
    await dialog.getByLabel("Tytuł").fill("Nowa książka");
    await dialog.getByRole("button", { name: text(registers, "record.save") }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByText("Page 1 of 3")).toBeVisible();
    await expect(card.getByText("26 records in total")).toBeVisible();
    await expect(card.getByRole("row").nth(1).getByRole("cell").first()).toHaveText("Nowa książka");
    await page.reload();
    await expect(card.getByRole("row").nth(1).getByRole("cell").first()).toHaveText("Nowa książka");
  });

  test("a table that does not allow adding has no button, and one with no records says so", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 0);
    await createScreenWith(page, owner, [{ id: A, title: "Pusta", allowAdd: false, layout: HALVES.a.layout }, { id: B, title: "Z dodawaniem", layout: HALVES.b.layout }]);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOf(page, "Pusta").getByText(table("empty"))).toBeVisible();
    await expect(widgetOf(page, "Pusta").getByRole("button", { name: table("add"), exact: true })).toHaveCount(0);
    await expect(widgetOf(page, "Z dodawaniem").getByText(table("empty"))).toBeVisible();
    await expect(widgetOf(page, "Z dodawaniem").getByRole("button", { name: table("add"), exact: true })).toBeVisible();
  });

  test("the phone, the tablet and the desktop each use their own layout", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 3);
    await createScreenWith(page, owner, [HALVES.a, HALVES.b]);
    const boxes = async () => {
      const first = await widgetOf(page, "Pierwsza").boundingBox();
      const second = await widgetOf(page, "Druga").boundingBox();
      const grid = await page.locator(".screen-grid").boundingBox();
      if (first === null || second === null || grid === null) throw new Error("a widget or the grid is not on the page");
      return { first, second, grid };
    };
    const near = (value: number, expected: number, tolerance = 2) => expect(Math.abs(value - expected), `${value} ≈ ${expected}`).toBeLessThanOrEqual(tolerance);

    // Phone: one column, the second widget under the first, both as wide as the grid.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "phone");
    let { first, second, grid } = await boxes();
    near(first.x, grid.x);
    near(second.x, grid.x);
    near(first.width, grid.width);
    near(second.y, first.y + first.height + 16);

    // Tablet: eight columns, the widgets side by side, four columns each.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "tablet");
    ({ first, second, grid } = await boxes());
    near(first.y, second.y);
    near(first.width, (grid.width - 7 * 16) / 8 * 4 + 3 * 16);
    near(second.x, first.x + first.width + 16);

    // Desktop: twelve columns, six each; a height of eight rows is 8 * 32 + 7 * 16 = 368 px.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "desktop");
    ({ first, second, grid } = await boxes());
    near(first.y, second.y);
    near(first.width, (grid.width - 11 * 16) / 12 * 6 + 5 * 16);
    near(first.height, 368);
    near(second.x, first.x + first.width + 16);
    await expectNoViolations(page);
  });

  test("values and titles are text: markup shows as it is and runs nothing", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    const hostile = `<img src=x onerror="globalThis.__ran=1"><b>bold</b>`;
    await addRecordByApi(page, owner, "ksiazki", { tytul: hostile }, "seed-key-001");
    await createScreenWith(page, owner, [{ id: A, title: hostile.slice(0, 60), layout: HALVES.a.layout }]);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page.getByRole("cell", { name: hostile })).toBeVisible();
    expect(await page.locator("main img, main b").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, "__ran"))).toBeUndefined();
  });
});

test.describe("D18.1-AC2 what a widget says when it cannot show data", () => {
  test("no screen and an empty screen invite to the Designer, whose link leads there", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await expect(page.getByRole("heading", { level: 2, name: text(common, "main.emptyHeading") })).toBeVisible();
    await expect(page.getByText(text(common, "main.empty"))).toBeVisible();
    await expectNoViolations(page);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, []);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: text(common, "main.emptyHeading") })).toBeVisible();
    await page.getByRole("link", { name: text(common, "main.openDesigner") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/designer`);
  });

  test("a draft says 'configure', and a binding broken since and a configuration to confirm say so, each with the link to the Designer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 2);
    const screenId = await createScreenWith(page, owner, [
      { id: A, title: "Szkic", draft: true, layout: HALVES.a.layout },
      { id: B, title: "Dane", layout: HALVES.b.layout },
    ]);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOf(page, "Szkic").getByText(table("configure"))).toBeVisible();
    await expect(widgetOf(page, "Szkic").getByRole("link", { name: table("openDesigner") })).toBeVisible();
    await expect(widgetOf(page, "Dane").getByRole("cell", { name: "Książka 02" })).toBeVisible();

    // The server's states for the other two cases, as the screen reports them.
    const withState = async (state: string) => {
      await page.unroute("**/api/v1/screens/*");
      await page.route(`**/api/v1/screens/${screenId}`, async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as { widgets: Array<{ id: string; state: string }> };
        for (const widget of body.widgets) if (widget.id === B) widget.state = state;
        await route.fulfill({ response, json: body });
      });
      await page.reload();
    };
    await withState("needs_rebinding");
    await expect(widgetOf(page, "Dane").getByText(table("brokenBinding"))).toBeVisible();
    await expect(widgetOf(page, "Dane").getByRole("link", { name: table("openDesigner") })).toBeVisible();
    await expect(widgetOf(page, "Dane").getByRole("row")).toHaveCount(0);
    await withState("needs_refresh");
    await expect(widgetOf(page, "Dane").getByText(table("needsRefresh"))).toBeVisible();
    await expectNoViolations(page);
  });

  test("a widget that fails to draw does not take the screen or the other widget with it, and 'try again' draws it anew", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 2);
    await createScreenWith(page, owner, [
      { id: A, title: "Wadliwy", columns: ["tytul", "strony"], layout: HALVES.a.layout },
      { id: B, title: "Sprawny", layout: HALVES.b.layout },
    ]);
    // A number column whose decimals no formatter can use: an answer the contract allows and the drawing cannot survive.
    await page.route(`**/api/v1/widgets/${A}/data*`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { columns: Array<{ key: string; typeOptions: { decimalPlaces?: number } }>; rows: Array<{ values: Record<string, unknown> }> };
      for (const column of body.columns) if (column.key === "strony") column.typeOptions = { decimalPlaces: 101 };
      for (const row of body.rows) row.values["strony"] = 12;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOf(page, "Wadliwy").getByRole("alert")).toHaveText(text(widgets, "crashed"));
    await expect(widgetOf(page, "Sprawny").getByRole("cell", { name: "Książka 02" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(common, "main.title"));
    await page.unroute(`**/api/v1/widgets/${A}/data*`);
    await widgetOf(page, "Wadliwy").getByRole("button", { name: table("retry") }).click();
    await expect(widgetOf(page, "Wadliwy").getByRole("cell", { name: "Książka 02" })).toBeVisible();
  });

  test("a failing read of the data says so with 'try again', and an ended session leads to the sign-in", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner, 2);
    await createScreenWith(page, owner, [{ id: A, title: "Dane", layout: HALVES.a.layout }]);
    await page.route("**/api/v1/widgets/*/data*", (route) => route.abort("connectionreset"));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(widgetOf(page, "Dane").getByRole("alert")).toHaveText(table("loadFailed"));
    await expectNoViolations(page);
    await page.unroute("**/api/v1/widgets/*/data*");
    await widgetOf(page, "Dane").getByRole("button", { name: table("retry") }).click();
    await expect(widgetOf(page, "Dane").getByRole("cell", { name: "Książka 02" })).toBeVisible();

    await page.route("**/api/v1/widgets/*/data*", (route) => route.abort("connectionreset"));
    await page.reload();
    await expect(widgetOf(page, "Dane").getByRole("alert")).toBeVisible();
    await context.clearCookies();
    await page.unroute("**/api/v1/widgets/*/data*");
    await widgetOf(page, "Dane").getByRole("button", { name: table("retry") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });

  test("a screen the server cannot give says so with 'try again'", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.route("**/api/v1/screens", (route) => route.abort("connectionreset"));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await page.unroute("**/api/v1/screens");
    await page.getByRole("button", { name: text(common, "main.retry") }).click();
    await expect(page.getByRole("heading", { level: 2, name: text(common, "main.emptyHeading") })).toBeVisible();
  });
});
