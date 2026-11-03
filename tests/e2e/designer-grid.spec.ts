// D33.2 — the grid of the Designer in a real browser (Scope §5.4; makiety 41–43, 46, 48) on Książki of
// F01 and two register tables: the one rule of collisions and the minimum for the mouse, the touch and
// the keyboard, in the layout being arranged only.
// AC1: a widget moved by the mouse, by a touch on the tablet and by Alt + arrow onto its neighbour
//      pushes the neighbour down in that layout, the other layouts stay as they were; a shrink stops
//      at the minimum of the manifest; a new widget gets a place in all three layouts.
// AC2: a move past the columns does nothing; Escape during a drag takes the widget back; on a phone
//      the Designer arranges the phone layout only; a failed load shows the code, "Try again" and the
//      way back; the switch of the layout goes by the arrows; the handles are 44 px; axe.
import type { CDPSession, Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
const errors = locale("en", "errors");
test.use({ locale: "en-US" });

const A = "019a0000-0000-7000-8000-0000000033b1";
const B = "019a0000-0000-7000-8000-0000000033b2";
type Rect = { x: number; y: number; w: number; h: number };
type Layout = Record<"phone" | "tablet" | "desktop", Rect>;
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const FIRST: Layout = { phone: r(0, 0, 1, 6), tablet: r(0, 0, 4, 6), desktop: r(0, 0, 4, 6) };
const SECOND: Layout = { phone: r(0, 6, 1, 6), tablet: r(4, 0, 4, 6), desktop: r(4, 0, 4, 6) };
/** The register table of the manifest cannot be smaller than this (packages/widgets). */
const MINIMUM = { w: 3, h: 4 };

/** A cell of each grid: the width of the layout's page over its columns, with the gap of 16 px; rows of 32 px and the gap. */
const COLUMN_PX = { desktop: (1200 - 11 * 16) / 12 + 16, tablet: (768 - 7 * 16) / 8 + 16 };
const ROW_PX = 48;

const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const status = (page: Page): Locator => page.getByRole("status").filter({ hasText: /changes|Saved|Saving/ });
const handleOf = (page: Page, title: string): Locator => page.getByRole("button", { name: `Select widget: ${title}` });

async function twoTables(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [
    { id: A, title: "Pierwsza", layout: FIRST },
    { id: B, title: "Druga", layout: SECOND },
  ]);
  await page.goto(`${owner.baseUrl}/designer`);
  await expect(handleOf(page, "Druga")).toBeVisible();
}

async function saved(page: Page, owner: BrowserOwner): Promise<Record<string, Layout>> {
  await toolbarButton(page, "toolbar.save").click();
  await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  const screen = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Array<{ id: string; layout: Layout }> };
  return Object.fromEntries(screen.widgets.map((widget) => [widget.id, widget.layout]));
}

const centre = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

async function mouseDrag(page: Page, from: { x: number; y: number }, dx: number, dy: number, beforeRelease?: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await beforeRelease?.();
  await page.mouse.up();
}

/** A finger on the screen: real touch events through the protocol of the browser, as a tablet sends them. */
async function touchDrag(session: CDPSession, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let step = 1; step <= 10; step += 1) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from.x + (dx * step) / 10, from.y + (dy * step) / 10) });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("D33.2-AC1 one rule for the mouse, the touch and the keyboard", () => {
  test("the mouse drops Druga onto Pierwsza on the desktop: Pierwsza goes below it, the phone and the tablet stay as they were", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    await mouseDrag(page, await centre(handleOf(page, "Druga")), -Math.round(4 * COLUMN_PX.desktop), 0);
    const layouts = await saved(page, owner);
    expect(layouts[B]!.desktop).toEqual(r(0, 0, 4, 6));
    expect(layouts[A]!.desktop).toEqual(r(0, 6, 4, 6));
    for (const id of [A, B]) {
      expect(layouts[id]!.phone).toEqual((id === A ? FIRST : SECOND).phone);
      expect(layouts[id]!.tablet).toEqual((id === A ? FIRST : SECOND).tablet);
    }
  });

  test("Alt + arrow moves the selected widget onto its neighbour and pushes it down; Alt + Shift + arrow stops at the minimum", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    const first = handleOf(page, "Pierwsza");
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("Alt+ArrowRight");
    await expect(first).toBeFocused();
    // Smaller than the minimum of the manifest is not possible: four times narrower and lower, it stops at 3 × 4.
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("Alt+Shift+ArrowLeft");
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("Alt+Shift+ArrowUp");
    const layouts = await saved(page, owner);
    expect(layouts[A]!.desktop).toEqual(r(4, 0, MINIMUM.w, MINIMUM.h));
    expect(layouts[B]!.desktop).toEqual(r(4, 6, 4, 6));
    expect(layouts[A]!.tablet).toEqual(FIRST.tablet);
    expect(layouts[B]!.tablet).toEqual(SECOND.tablet);
    await expectNoViolations(page);
  });

  test("a touch on the tablet moves Druga onto Pierwsza with the same push; the corner resizes by touch; a new widget has a place in all three layouts", async ({ browser, ownerServer }) => {
    const context = await browser.newContext({ hasTouch: true, locale: "en-US", viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    await toolbarButton(page, "toolbar.tablet").click();
    await expect(page.getByRole("group", { name: "Screen layout: Tablet" })).toBeVisible();
    const session = await context.newCDPSession(page);
    await touchDrag(session, await centre(handleOf(page, "Druga")), -Math.round(4 * COLUMN_PX.tablet), 0);
    await expect(handleOf(page, "Druga")).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));
    // The corner of Druga, now at the top left: one column wider by touch, which pushes nothing (Pierwsza is below).
    const corner = page.locator(`[data-widget-id="${B}"] .react-resizable-handle-se`);
    await touchDrag(session, await centre(corner), Math.round(COLUMN_PX.tablet), 0);
    await page.getByRole("button", { name: "Add: Register table" }).click();
    const layouts = await saved(page, owner);
    expect(layouts[B]!.tablet).toEqual(r(0, 0, 5, 6));
    expect(layouts[A]!.tablet).toEqual(r(0, 6, 4, 6));
    expect(layouts[A]!.desktop).toEqual(FIRST.desktop);
    expect(layouts[B]!.desktop).toEqual(SECOND.desktop);
    const added = Object.entries(layouts).find(([id]) => id !== A && id !== B)![1];
    expect(added).toEqual({ phone: r(0, 12, 1, 8), tablet: r(0, 12, 8, 8), desktop: r(0, 6, 8, 8) });
    await context.close();
  });
});

test.describe("D33.2-AC2 the edges, Escape, the phone and a failed load", () => {
  test("past the columns nothing moves; Escape during a drag takes the widget back; the switch goes by the arrows; the handles are 44 px", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoTables(page, owner);
    const second = handleOf(page, "Druga");
    // Druga is 4 wide at column 4 of 12: four steps right reach the edge, the fifth does nothing.
    await second.focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("Alt+ArrowRight");
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));
    await page.keyboard.press("Escape");
    await expect(second).toHaveAttribute("aria-pressed", "false");

    // Escape while the mouse still holds Pierwsza: the drop is not made.
    const before = await page.locator(`[data-widget-id="${A}"]`).boundingBox();
    await mouseDrag(page, await centre(handleOf(page, "Pierwsza")), Math.round(2 * COLUMN_PX.desktop), 3 * ROW_PX, () => page.keyboard.press("Escape"));
    await expect(async () => {
      const after = await page.locator(`[data-widget-id="${A}"]`).boundingBox();
      expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
    }).toPass();
    const layouts = await saved(page, owner);
    expect(layouts[B]!.desktop).toEqual(r(8, 0, 4, 6));
    expect(layouts[A]!.desktop).toEqual(FIRST.desktop);

    // The switch of the layout: one stop of Tab, the arrows choose; the selection stays.
    await second.click();
    const desktop = toolbarButton(page, "toolbar.desktop");
    await desktop.focus();
    await page.keyboard.press("ArrowLeft");
    const tablet = toolbarButton(page, "toolbar.tablet");
    await expect(tablet).toBeFocused();
    await expect(tablet).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: "Screen layout: Tablet" })).toBeVisible();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(desktop).toHaveAttribute("tabindex", "-1");

    for (const target of [second, page.locator(`[data-widget-id="${B}"] .react-resizable-handle-se`)]) {
      const box = await target.boundingBox();
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
    }
    await expectNoViolations(page);
  });

  test("on a phone the Designer arranges the phone layout only and does not scroll sideways", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.setViewportSize({ width: 390, height: 844 });
    await twoTables(page, owner);
    await expect(page.getByText(text(designer, "toolbar.phoneOnly"))).toBeVisible();
    await expect(page.getByRole("group", { name: text(designer, "toolbar.layouts"), exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Screen layout: Phone" })).toBeVisible();
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    // Druga up past Pierwsza in the one column, a unit at a time: the first step onto Pierwsza pushes it just below
    // Druga (5 + 6), and nothing moves it back up when Druga goes on (no gap is closed).
    await handleOf(page, "Druga").focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("Alt+ArrowUp");
    const layouts = await saved(page, owner);
    expect(layouts[B]!.phone).toEqual(r(0, 0, 1, 6));
    expect(layouts[A]!.phone).toEqual(r(0, 11, 1, 6));
    expect(layouts[A]!.desktop).toEqual(FIRST.desktop);
    expect(layouts[B]!.tablet).toEqual(SECOND.tablet);
    await expectNoViolations(page);
  });

  test("a failed load shows no grid, the code and the reference, Try again and the way back; trying again opens the Designer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: A, title: "Pierwsza", layout: FIRST }]);
    await page.route("**/api/v1/screens", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "internal", details: null, requestId: "req-d33-2" }) }));
    await page.goto(`${owner.baseUrl}/designer`);
    const failed = page.getByRole("region", { name: text(designer, "loadFailed") });
    await expect(failed.getByRole("alert")).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(failed.getByRole("alert")).toContainText("req-d33-2");
    await expect(page.locator(".designer-frame")).toHaveCount(0);
    await expect(failed.getByRole("link", { name: text(designer, "backHome") })).toHaveAttribute("href", "/");
    await expectNoViolations(page);
    await page.unroute("**/api/v1/screens");
    await failed.getByRole("button", { name: text(designer, "retry") }).click();
    await expect(handleOf(page, "Pierwsza")).toBeVisible();
  });
});
