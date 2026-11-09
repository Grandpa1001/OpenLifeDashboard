// D35.3 — two tabs of one owner on one screen, and a save whose answer was lost, in a real browser
// (Scope §5.4 "Konflikt dwóch kart"; Architektura §18.5, LWW; makieta 29) on Książki of F01.
// AC1: tab B, clean, takes the layout tab A saved (the stream of D38 brings the news; the return of the tab no
//      longer does), with a passing word; with changes of its own it asks: Load the newer layout gives A's
//      layout, Keep mine saves B's over it; news during a try of its own is asked about once the try has ended.
// AC2: a save that the server made but whose answer was lost is tried again without a second effect
//      and without a lasting error, and is not taken for a change from another device; axe.
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000035f1";
const DESIGN = /\/api\/v1\/screens\/[^/]+\/design$/;
const SCREEN = /\/api\/v1\/screens\/[^/]+$/;
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };

const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const tile = (page: Page, title: string): Locator => page.getByRole("button", { name: `Select widget: ${title}` });
const elsewhere = (page: Page): Locator => page.getByRole("region", { name: text(designer, "elsewhere.label") });

async function onTheServer(page: Page, owner: BrowserOwner): Promise<Array<{ id: string; config: Record<string, unknown> }>> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Array<{ id: string; config: Record<string, unknown> }> }).widgets;
}

/** A new title typed into the bar of the one table and left, so it saves. */
async function retitle(page: Page, from: string, to: string): Promise<void> {
  await tile(page, from).click();
  const field = bar(page).getByLabel(text(designer, "bar.title"), { exact: true });
  await field.fill(to);
  await field.blur();
  // The change is in the design of this tab before it is saved.
  await expect(tile(page, to)).toBeVisible();
}

/** The tab is in front again: the browser tells it it is visible and has the focus. */
async function backTo(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
}

async function twoTabs(context: BrowserContext, page: Page, owner: BrowserOwner): Promise<Page> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  const other = await context.newPage();
  await other.goto(`${owner.baseUrl}/designer`);
  await expect(tile(other, "Moje")).toBeVisible();
  return other;
}

test.describe("D35.3-AC1 a layout saved in another tab", () => {
  test("a clean tab takes the newer layout when it comes back, with a passing word", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoTabs(context, page, owner);
    await page.bringToFront();
    await retitle(page, "Moje", "Z karty A");
    await designerSaved(page);

    await backTo(other);
    await expect(tile(other, "Z karty A")).toBeVisible();
    await expect(other.getByRole("status").filter({ hasText: text(designer, "elsewhere.refreshed") })).toBeVisible();
    await expect(elsewhere(other)).toHaveCount(0);
    // Taken, not changed: nothing to save in tab B.
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
    await expectNoViolations(other);
  });

  test("a tab with changes of its own asks: Load the newer layout gives the other one, Keep mine saves its own over it", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoTabs(context, page, owner);
    // Tab B has a change it cannot send yet.
    await other.route(DESIGN, (route) => route.abort("connectionfailed"));
    await other.bringToFront();
    await retitle(other, "Moje", "Z karty B");
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "true");

    await page.bringToFront();
    await retitle(page, "Moje", "Z karty A");
    await designerSaved(page);
    await backTo(other);
    await expect(elsewhere(other)).toBeVisible();
    await expect(elsewhere(other)).toContainText(text(designer, "elsewhere.changed").split(" {{time}}")[0]!);
    await expectNoViolations(other);
    await elsewhere(other).getByRole("button", { name: text(designer, "elsewhere.load") }).click();
    await expect(elsewhere(other)).toHaveCount(0);
    await expect(tile(other, "Z karty A")).toBeVisible();
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "false");

    // Again, and this time B keeps its own: its change is saved over A's (the last save wins).
    await retitle(other, "Z karty A", "Znowu B");
    await page.bringToFront();
    await retitle(page, "Z karty A", "Znowu A");
    await designerSaved(page);
    await backTo(other);
    await elsewhere(other).getByRole("button", { name: text(designer, "elsewhere.keep") }).click();
    await expect(elsewhere(other)).toHaveCount(0);
    await other.unroute(DESIGN);
    // The connection is back and the browser says so: the waiting change goes at once, not after the growing wait of its tries.
    await other.evaluate("window.dispatchEvent(new Event('online'))");
    await designerSaved(other);
    expect((await onTheServer(page, owner))[0]!.config["title"]).toBe("Znowu B");
  });
  test("a change that arrives while its own try is in flight asks once the try has ended", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoTabs(context, page, owner);
    // B's try waits at this gate and then fails, so the test decides when it ends.
    let endTry: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (endTry = resolve));
    await other.route(DESIGN, async (route) => {
      await gate;
      await route.abort("connectionfailed");
    });
    await other.bringToFront();
    await retitle(other, "Moje", "Z karty B");
    await expect(other.locator(".designer-status")).toHaveAttribute("data-save", "saving");

    // A saves: B's stream brings the news and B reads the screen during its try (run 41833935928), without asking yet.
    const answered = other.waitForResponse((response) => SCREEN.test(response.url()) && response.request().method() === "GET");
    await page.bringToFront();
    await retitle(page, "Moje", "Z karty A");
    await designerSaved(page);
    await answered;
    await expect(elsewhere(other)).toHaveCount(0);
    // The try ends without the network: now B asks what the read found.
    endTry();
    await expect(elsewhere(other)).toBeVisible();
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "true");
  });
});

test.describe("D35.3-AC2 a save whose answer was lost", () => {
  test("is tried again without a second effect or a lasting error, and is not a change from another device", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    let lost = 1;
    let puts = 0;
    await page.route(DESIGN, async (route) => {
      puts += 1;
      if (lost > 0) {
        lost -= 1;
        // The server saves it; the answer never reaches the tab.
        await route.fetch();
        await route.abort("connectionreset");
      } else await route.continue();
    });
    await retitle(page, "Moje", "Raz");
    await designerSaved(page);
    expect(puts).toBe(2);
    const widgets = await onTheServer(page, owner);
    expect(widgets.map((widget) => [widget.id, widget.config["title"]])).toEqual([[A, "Raz"]]);
    await expect(page.getByRole("alert")).toHaveCount(0);

    await backTo(page);
    await page.waitForTimeout(1000);
    await expect(elsewhere(page)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: text(designer, "elsewhere.refreshed") })).toHaveCount(0);
    expect(context.pages()).toHaveLength(1);
  });
});
