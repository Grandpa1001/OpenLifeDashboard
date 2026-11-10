// D39.2 — the states of a widget on the dashboard and in the Designer, in a real browser (Scope §5.3, §5.4,
// §6.2) on Książki of F01: a widget that needs a refresh is told apart from a broken binding by colour, sign
// and words; one that cannot show its data does not stop the others and gives the code and the reference of
// the failure; the Designer marks such a widget and saves the screen without touching its configuration.
// AC1: states on the dashboard (the working table draws, the others have their own state and the link
//      "Set up in the Designer"), a failed read gives code and reference. AC2: in the Designer the tile is
//      marked, and a change of the layout leaves the stored configuration of the old widget as it was.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, signInFully } from "./owner-session.ts";

const widgets = locale("en", "widgets");
const designer = locale("en", "designer");
const errors = locale("en", "errors");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const WORKING = "019a0000-0000-7000-8000-0000000039a1";
const OLD = "019a0000-0000-7000-8000-0000000039a2";
const CLOCK = "019a0000-0000-7000-8000-0000000039a3";
const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
const WORKING_AT = { phone: rect(0, 0, 1, 6), tablet: rect(0, 0, 4, 6), desktop: rect(0, 0, 4, 6) };
const OLD_AT = { phone: rect(0, 6, 1, 6), tablet: rect(4, 0, 4, 6), desktop: rect(4, 0, 4, 6) };
const CLOCK_AT = { phone: rect(0, 12, 1, 4), tablet: rect(0, 6, 4, 4), desktop: rect(8, 0, 4, 4) };
const OLD_CONFIG = { v: 2, title: "Stara" };

const table = (key: string): string => text(widgets, `registerTable.${key}`);
const widgetOf = (page: Page, title: string): Locator => page.getByRole("region", { name: title });

/** Książki, a working table, a table whose configuration is of a version this build does not write, and a clock in the same case. */
async function screenWithOldWidgets(page: Page, owner: BrowserOwner): Promise<string> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris" }, "d39-2-solaris");
  const screenId = await createScreenWith(page, owner, [
    { id: WORKING, title: "Sprawny", layout: WORKING_AT },
    { id: OLD, title: "Stara", layout: OLD_AT },
  ]);
  const screen = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screenId}`)).json()) as { name: string; theme: string; accent: string; widgets: Array<Record<string, unknown>> };
  const design = {
    name: screen.name,
    theme: screen.theme,
    accent: screen.accent,
    widgets: [
      ...screen.widgets.map((widget) => {
        const kept = Object.fromEntries(Object.entries(widget).filter(([key]) => key !== "state"));
        return widget["id"] === OLD ? { ...kept, config: OLD_CONFIG } : kept;
      }),
      { id: CLOCK, type: "clock", config: { v: 2 }, layout: CLOCK_AT, bindings: [] },
    ],
  };
  const saved = await page.request.put(`${owner.baseUrl}/api/v1/screens/${screenId}/design`, { data: design, headers: { Origin: owner.baseUrl } });
  expect(saved.status()).toBe(200);
  return screenId;
}

/** The page's own function, named for the types: the tests of this project compile without the types of the DOM. */
declare function getComputedStyle(element: unknown, pseudo?: string): { color: string; content: string };
/** The colour of a line and the sign the style puts before it. */
const style = (locator: Locator): Promise<{ color: string; sign: string }> =>
  locator.evaluate((element) => ({ color: getComputedStyle(element).color, sign: getComputedStyle(element, "::before").content }));

test.describe("D39.2-AC1 the states on the dashboard", () => {
  test("the working table draws; the old table and the old clock say they need a refresh and offer the Designer; a broken binding looks different", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    const screenId = await screenWithOldWidgets(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    await expect(widgetOf(page, "Sprawny").getByRole("cell", { name: "Solaris" })).toBeVisible();

    const old = widgetOf(page, "Stara");
    await expect(old.getByText(table("needsRefresh"))).toBeVisible();
    await expect(old.getByRole("link", { name: table("openDesigner") })).toHaveAttribute("href", "/designer");
    const clock = page.getByRole("region", { name: new RegExp(`^${text(widgets, "types.clock")}`) });
    await expect(clock.getByText(table("needsRefresh"))).toBeVisible();
    await expect(clock.getByRole("link", { name: table("openDesigner") })).toBeVisible();
    const refresh = await style(old.locator(".widget-state > p"));

    // The same table with a broken binding, as the server would report it.
    await page.route(`**/api/v1/screens/${screenId}`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { widgets: Array<{ id: string; state: string }> };
      for (const widget of body.widgets) if (widget.id === OLD) widget.state = "needs_rebinding";
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(old.getByText(table("brokenBinding"))).toBeVisible();
    const rebinding = await style(old.locator(".widget-state > p"));
    expect(rebinding.color).not.toBe(refresh.color);
    expect(rebinding.sign).not.toBe(refresh.sign);
    expect(refresh.sign).not.toBe("none");
    expect(rebinding.sign).not.toBe("none");
  });

  test("a failed read of one table gives the code of the failure and its reference, and the clock and the other table go on", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await screenWithOldWidgets(page, owner);
    await page.route(`**/api/v1/widgets/${WORKING}/data*`, (route) => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR", message: "x", details: null, requestId: "req-d39-2" } }));
    await page.goto(`${owner.baseUrl}/`);
    const failed = widgetOf(page, "Sprawny").getByRole("alert");
    await expect(failed).toContainText(table("loadFailed"));
    await expect(failed).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(failed).toContainText("req-d39-2");
    await expect(widgetOf(page, "Stara").getByText(table("needsRefresh"))).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("D39.2-AC2 the Designer and a widget of an old version", () => {
  test("the tile of the old widget is marked, and a move of the working one saves the screen with the old configuration as it was", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    const screenId = await screenWithOldWidgets(page, owner);
    await page.goto(`${owner.baseUrl}/designer`);
    const old = page.locator(`[data-widget-id="${OLD}"]`);
    await expect(old).toHaveAttribute("data-state", "needs_refresh");
    await expect(old.getByText(text(designer, "canvas.needsRefresh"))).toBeVisible();
    await expect(page.locator(`[data-widget-id="${WORKING}"]`)).not.toHaveAttribute("data-state", "needs_refresh");

    // A change of the layout: the working table moves down one row, the screen is saved.
    const handle = page.getByRole("button", { name: "Select widget: Sprawny" });
    await handle.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await designerSaved(page);

    const stored = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screenId}`)).json()) as { widgets: Array<{ id: string; state: string; config: Record<string, unknown>; layout: { desktop: { y: number } } }> };
    const kept = stored.widgets.find((widget) => widget.id === OLD)!;
    expect(kept.config).toEqual(OLD_CONFIG);
    expect(kept.state).toBe("needs_refresh");
    expect(stored.widgets.find((widget) => widget.id === CLOCK)!.config).toEqual({ v: 2 });
    expect(stored.widgets.find((widget) => widget.id === WORKING)!.layout.desktop.y).toBe(1);
  });
});
