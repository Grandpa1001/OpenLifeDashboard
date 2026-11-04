// D33.3 — S12 in a real browser at the real widths of a phone (390 px), a tablet (1024 px), a laptop
// (1440 px) and a large display (1920 px), with touch (Scope §5.3, §5.4, S12; DEV §9.30).
// AC1 (S12): a widget added on the desktop layout of an empty screen is on the phone and the tablet
//      too; its resize on the phone moves neither the desktop nor the tablet; after a reload and a
//      restart of the server the three layouts are the same.
// AC2: on the tablet a touch moves and resizes the widget in the tablet layout; from 1800 px the
//      screen uses the desktop layout in a base font of 20 px; axe on the screen, Pulpity and the Designer.
import type { CDPSession, Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, expectNoViolations, openApp, signInFully, addRegisterTable, designerSaved } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US" });

type Rect = { x: number; y: number; w: number; h: number };
type Layout = Record<"phone" | "tablet" | "desktop", Rect>;
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const WIDTH = { phone: 390, tablet: 1024, laptop: 1440, large: 1920 } as const;
/** A column of the tablet grid: 768 px over 8 columns with the gap of 16 px; a row is 32 px and the gap. */
const TABLET_COLUMN_PX = (768 - 7 * 16) / 8 + 16;
const ROW_PX = 48;

const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const handle = (page: Page): Locator => page.getByRole("button", { name: /^Select widget: / });
const corner = (page: Page): Locator => page.locator(".designer-widget .react-resizable-handle-se");

async function layoutOnServer(page: Page, owner: BrowserOwner): Promise<Layout> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  const screen = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Array<{ layout: Layout }> };
  expect(screen.widgets).toHaveLength(1);
  return screen.widgets[0]!.layout;
}

async function save(page: Page): Promise<void> {
  await designerSaved(page);
}

const centre = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** A finger on the screen: real touch events through the protocol of the browser. */
async function touchDrag(session: CDPSession, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let step = 1; step <= 10; step += 1) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from.x + (dx * step) / 10, from.y + (dy * step) / 10) });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** The cell of the widget on the screen, as the grid of the layout of the window places it. */
async function onTheScreen(page: Page, owner: BrowserOwner, width: number, expected: "phone" | "tablet" | "desktop", rect: Rect): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${owner.baseUrl}/`);
  await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", expected);
  const cell = page.locator("section.widget");
  await expect(cell).toHaveCSS("grid-column-start", String(rect.x + 1));
  await expect(cell).toHaveCSS("grid-row-start", String(rect.y + 1));
  await expect(cell).toHaveCSS("grid-column-end", `span ${rect.w}`);
  await expect(cell).toHaveCSS("grid-row-end", `span ${rect.h}`);
}

test.describe("D33.3 S12 the three layouts at real widths", () => {
  test("S12: a widget added on the desktop is on the phone and the tablet; resized on the phone and moved by touch on the tablet it keeps the other layouts, over a reload and a restart; 1920 px is the desktop in 20 px", async ({ browser, ownerServer }) => {
    const context = await browser.newContext({ hasTouch: true, locale: "en-US", viewport: { width: WIDTH.laptop, height: 900 } });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);

    // An empty screen; on a laptop the Designer opens on the desktop layout and the widget is added there.
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await expect(toolbarButton(page, "toolbar.desktop")).toHaveAttribute("aria-pressed", "true");
    await addRegisterTable(page);
    await save(page);
    const added = await layoutOnServer(page, owner);
    expect(added).toEqual({ phone: r(0, 0, 1, 8), tablet: r(0, 0, 8, 8), desktop: r(0, 0, 8, 8) });
    await expectNoViolations(page);

    // The phone: the Designer arranges its layout only; a touch on the corner makes the widget two rows taller.
    await page.setViewportSize({ width: WIDTH.phone, height: 844 });
    await page.reload();
    await expect(page.getByText(text(designer, "toolbar.phoneOnly"))).toBeVisible();
    await expect(page.getByRole("group", { name: "Screen layout: Phone" })).toBeVisible();
    await touchDrag(session, await centre(corner(page)), 0, 2 * ROW_PX);
    await save(page);
    const afterPhone = await layoutOnServer(page, owner);
    expect(afterPhone.phone).toEqual(r(0, 0, 1, 10));
    expect(afterPhone.desktop).toEqual(added.desktop);
    expect(afterPhone.tablet).toEqual(added.tablet);

    // The tablet: by touch two columns narrower at the corner, then two columns to the right by the title bar.
    await page.setViewportSize({ width: WIDTH.tablet, height: 900 });
    await page.reload();
    await toolbarButton(page, "toolbar.tablet").click();
    await expect(page.getByRole("group", { name: "Screen layout: Tablet" })).toBeVisible();
    await touchDrag(session, await centre(corner(page)), -Math.round(2 * TABLET_COLUMN_PX), 0);
    await expect(page.locator(".designer-widget")).toHaveCSS("width", `${Math.round(6 * TABLET_COLUMN_PX - 16)}px`);
    await touchDrag(session, await centre(handle(page)), Math.round(2 * TABLET_COLUMN_PX), 0);
    await save(page);
    const arranged = await layoutOnServer(page, owner);
    expect(arranged).toEqual({ phone: r(0, 0, 1, 10), tablet: r(2, 0, 6, 8), desktop: r(0, 0, 8, 8) });
    await expectNoViolations(page);

    // A reload and a restart of the server: the same three layouts, on the server and on the screen of each width.
    await owner.restart();
    expect(await layoutOnServer(page, owner)).toEqual(arranged);
    await onTheScreen(page, owner, WIDTH.phone, "phone", arranged.phone);
    await onTheScreen(page, owner, WIDTH.tablet, "tablet", arranged.tablet);
    await onTheScreen(page, owner, WIDTH.laptop, "desktop", arranged.desktop);
    await expectNoViolations(page);

    // A large display: the desktop layout in a base font of 20 px; Pulpity keep the usual font.
    await onTheScreen(page, owner, WIDTH.large, "desktop", arranged.desktop);
    await expect(page.locator("body")).toHaveCSS("font-size", "20px");
    await expectNoViolations(page);
    await openApp(page);
    await expect(page.locator("body")).toHaveCSS("font-size", "16px");
    await expectNoViolations(page);
    await context.close();
  });
});
