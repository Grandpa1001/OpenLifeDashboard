// D40.1 — a screen with ten widgets in a real browser (Scope §5.3, §5.4; Architektura §16) on Książki of F01:
// six working tables, two clocks, a draft and a table of an old configuration, in the three layouts.
// AC1: the dashboard draws all ten, reads the data of the working tables only (one read each), does not
//      scroll sideways on a phone, and shows the data within the budget of Scope (2 s, warm, local); axe.
// AC2: the Designer opens it, selects and moves a widget and saves, the phone layout shows all ten; the
//      preview draws all ten; axe.
import type { Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, expectNoViolations, signInFully, type WidgetPlan } from "./owner-session.ts";

const widgets = locale("en", "widgets");
const designer = locale("en", "designer");

const TABLES = 8;
const CLOCKS = 2;
const WORKING = 6;
/** The budget of Scope for the dashboard: data and a usable view in under two seconds. */
const BUDGET_MS = 2000;
const id = (n: number): string => `019a0000-0000-7000-8000-0000000${String(40100 + n)}`;
const DATA = /\/api\/v1\/widgets\/[^/]+\/data/;

type Rect = { x: number; y: number; w: number; h: number };
/** Widget `index` of ten: three to a row on the desktop, two on the tablet, one on the phone. */
function placed(index: number): { phone: Rect; tablet: Rect; desktop: Rect } {
  return {
    phone: { x: 0, y: index * 6, w: 1, h: 6 },
    tablet: { x: (index % 2) * 4, y: Math.floor(index / 2) * 6, w: 4, h: 6 },
    desktop: { x: (index % 3) * 4, y: Math.floor(index / 3) * 6, w: 4, h: 6 },
  };
}

/** The ten widgets through the routes of the product, with the session of the page. Returns the id of the screen. */
async function tenWidgets(page: Page, owner: BrowserOwner): Promise<string> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (let n = 1; n <= 12; n += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${String(n).padStart(2, "0")}` }, `d40-1-book-${n}`);
  const plans: WidgetPlan[] = Array.from({ length: TABLES }, (_unused, n) => ({
    id: id(n),
    title: n < WORKING ? `Tabela ${n + 1}` : n === WORKING ? "Szkic" : "Stara",
    pageSize: 5,
    layout: placed(n),
    ...(n === WORKING ? { draft: true } : {}),
  }));
  const screenId = await createScreenWith(page, owner, plans, "Dziesięć");
  const screen = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screenId}`)).json()) as { name: string; theme: string; accent: string; widgets: Array<Record<string, unknown>> };
  const kept = screen.widgets.map((widget) => {
    const design = Object.fromEntries(Object.entries(widget).filter(([key]) => key !== "state"));
    return widget["id"] === id(TABLES - 1) ? { ...design, config: { v: 2, title: "Stara" } } : design;
  });
  const clocks = Array.from({ length: CLOCKS }, (_unused, n) => ({ id: id(100 + n), type: "clock", config: { v: 1, timezone: n === 0 ? "owner" : "Asia/Tokyo", format: "24h", showSeconds: false, showDate: true, label: n === 0 ? "Dom" : "Tokio" }, layout: placed(TABLES + n), bindings: [] }));
  const saved = await page.request.put(`${owner.baseUrl}/api/v1/screens/${screenId}/design`, { data: { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: [...kept, ...clocks] }, headers: { Origin: owner.baseUrl } });
  expect(saved.status(), await saved.text()).toBe(200);
  return screenId;
}

/** Whether the page is wider than the window: the width of the document and of the window, read in the page. */
const scrollsSideways = (page: Page): Promise<boolean> => page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");

test.describe("D40.1-AC1 the dashboard with ten widgets", () => {
  test("laptop: all ten drawn, the data of the working tables read once each, the others do not stop the screen, within the budget", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tenWidgets(page, owner);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A warm start: the first visit builds the caches of the server and the browser.
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.locator("section.widget")).toHaveCount(TABLES + CLOCKS);

    let reads = 0;
    page.on("request", (request) => {
      if (DATA.test(new URL(request.url()).pathname) && request.method() === "GET") reads += 1;
    });
    const started = Date.now();
    await page.goto(`${owner.baseUrl}/`);
    for (let n = 1; n <= WORKING; n += 1) await expect(page.getByRole("region", { name: `Tabela ${n}` }).getByRole("row")).not.toHaveCount(0);
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: "dashboard-ms", description: String(elapsed) });
    expect(elapsed, "warm start of the dashboard with ten widgets").toBeLessThan(BUDGET_MS);

    await expect(page.locator("section.widget")).toHaveCount(TABLES + CLOCKS);
    await expect(page.getByRole("region", { name: "Szkic" }).getByText(text(widgets, "registerTable.configure"))).toBeVisible();
    await expect(page.getByRole("region", { name: "Stara" }).getByText(text(widgets, "registerTable.needsRefresh"))).toBeVisible();
    await expect(page.getByText("Dom", { exact: false }).first()).toBeVisible();
    expect(reads, "one read of data per working table").toBe(WORKING);
    expect(await scrollsSideways(page)).toBe(false);
    await expectNoViolations(page);
  });

  test("phone: all ten in one column without sideways scrolling, and axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tenWidgets(page, owner);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.locator("section.widget")).toHaveCount(TABLES + CLOCKS);
    await expect(page.getByRole("region", { name: "Tabela 1" }).getByRole("row")).not.toHaveCount(0);
    expect(await scrollsSideways(page)).toBe(false);
    const tops = (await page.evaluate("[...document.querySelectorAll('section.widget')].map((section) => Math.round(section.getBoundingClientRect().top + window.scrollY))")) as number[];
    expect(tops).toHaveLength(TABLES + CLOCKS);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await expectNoViolations(page);
  });
});

test.describe("D40.1-AC2 the Designer and the preview with ten widgets", () => {
  test("the Designer selects and moves a widget and saves, the phone layout shows all ten, the preview draws all ten, axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    const screenId = await tenWidgets(page, owner);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${owner.baseUrl}/designer`);
    await expect(page.locator(".designer-widget")).toHaveCount(TABLES + CLOCKS);

    const tile = page.getByRole("button", { name: "Select widget: Tabela 4" });
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await tile.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await designerSaved(page);
    const stored = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screenId}`)).json()) as { widgets: Array<{ id: string; layout: { desktop: Rect } }> };
    expect(stored.widgets.find((widget) => widget.id === id(3))!.layout.desktop.x).toBe(1);
    await expectNoViolations(page);

    await page.getByRole("button", { name: text(designer, "toolbar.phone"), exact: true }).click();
    await expect(page.locator(".designer-widget")).toHaveCount(TABLES + CLOCKS);

    await page.getByRole("button", { name: text(designer, "toolbar.preview"), exact: true }).click();
    const frame = page.getByRole("region", { name: text(designer, "preview.label") });
    await expect(frame.locator("section.widget")).toHaveCount(TABLES + CLOCKS);
    await expect(frame.locator('[data-sample="true"]')).toHaveCount(1);
    await expectNoViolations(page);
  });
});
