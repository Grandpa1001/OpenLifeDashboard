// D38.3 — the Designer on the live stream, S11 on two tabs in a real browser (Scope §5.4 "Konflikt dwóch
// kart", S11; Architektura §7.6, §10) on Książki of F01.
// AC1: a layout saved in tab A is in tab B within a second, with "Layout changed on another device" and
//      without any return of the tab; while B holds a widget in a drag, the news waits for the drop and is
//      not lost, and what B changed meanwhile still saves.
// AC2: news lost with the stream is found again by the reconnect; a save of a tab does not set off a
//      loop of reads in that tab.
import type { Locator, Page } from "@playwright/test";
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000038f1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };
const SCREEN = /\/api\/v1\/screens\/[^/]+$/;
/** The time a layout of tab A has to reach tab B (Scope §5.4 S11). */
const REACHES_WITHIN_MS = 1000;

const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const tile = (page: Page, title: string): Locator => page.getByRole("button", { name: `Select widget: ${title}` });
const elsewhere = (page: Page): Locator => page.getByRole("region", { name: text(designer, "elsewhere.label") });
const liveState = (page: Page): Promise<unknown> => page.evaluate("document.documentElement.dataset.liveStream ?? null");

async function retitle(page: Page, from: string, to: string): Promise<void> {
  await tile(page, from).click();
  const field = bar(page).getByLabel(text(designer, "bar.title"), { exact: true });
  await field.fill(to);
  await field.blur();
  await expect(tile(page, to)).toBeVisible();
}

/** Two tabs of one owner on the Designer, both with the stream open. */
async function twoLiveTabs(page: Page, context: ReturnType<Page["context"]>, baseUrl: string, owner: Parameters<typeof signInFully>[1]): Promise<Page> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
  await page.goto(`${baseUrl}/designer`);
  const other = await context.newPage();
  await other.goto(`${baseUrl}/designer`);
  await expect(tile(other, "Moje")).toBeVisible();
  await expect.poll(() => liveState(page)).toBe("live");
  await expect.poll(() => liveState(other)).toBe("live");
  return other;
}

test.describe("D38.3-AC1 S11: a layout of another tab, at once", () => {
  test("a layout saved in tab A is in tab B within a second with the passing word, and tab B was never touched", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoLiveTabs(page, context, owner.baseUrl, owner);
    await retitle(page, "Moje", "Z karty A");
    await expect(tile(other, "Z karty A")).toBeVisible({ timeout: REACHES_WITHIN_MS + 1500 });
    await expect(other.getByRole("status").filter({ hasText: text(designer, "elsewhere.refreshed") })).toBeVisible();
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
  });

  test("while B holds a widget in a drag the news waits for the drop, and what B changed meanwhile still saves", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoLiveTabs(page, context, owner.baseUrl, owner);
    await other.bringToFront();
    const box = (await tile(other, "Moje").boundingBox())!;
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await other.mouse.move(from.x, from.y);
    await other.mouse.down();
    await other.mouse.move(from.x + 80, from.y + 60, { steps: 6 });
    await other.mouse.move(from.x + 160, from.y + 120, { steps: 6 });

    await page.bringToFront();
    await retitle(page, "Moje", "Z karty A");
    await designerSaved(page);
    // The news has reached B (the stream is quick) but waits: B still shows its own title and does not ask.
    await other.bringToFront();
    await other.waitForTimeout(1500);
    await expect(tile(other, "Moje")).toBeVisible();
    await expect(elsewhere(other)).toHaveCount(0);

    await other.mouse.up();
    // The drop made a change of B, so after the drop B asks about the news instead of losing it; its own change still saves.
    await expect(elsewhere(other)).toBeVisible();
    await designerSaved(other);
    await elsewhere(other).getByRole("button", { name: text(designer, "elsewhere.load") }).click();
    await expect(tile(other, "Z karty A")).toBeVisible();
  });
});

test.describe("D38.3-AC2 a lost event, and the echo of the own save", () => {
  test("news that went missing with the stream is found by the reconnect", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    const other = await twoLiveTabs(page, context, owner.baseUrl, owner);
    // B's way to the stream is cut and the server restarted: B is offline when A saves.
    await other.route(`**${STREAM_PATH}`, (route) => route.abort("connectionfailed"));
    await owner.restart();
    await expect.poll(() => liveState(other), { timeout: 30_000 }).toBe("offline");
    await expect.poll(() => liveState(page), { timeout: 30_000 }).toBe("live");
    await retitle(page, "Moje", "Zapisana bez B");
    await designerSaved(page);
    await expect(tile(other, "Moje")).toBeVisible();

    await other.unroute(`**${STREAM_PATH}`);
    await other.evaluate('window.dispatchEvent(new Event("focus"))');
    await expect(tile(other, "Zapisana bez B")).toBeVisible({ timeout: 10_000 });
    await expect(other.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
  });

  test("a save of a tab comes back to it as a few reads that settle, not a loop", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await twoLiveTabs(page, context, owner.baseUrl, owner);
    let reads = 0;
    page.on("request", (request) => {
      if (SCREEN.test(new URL(request.url()).pathname) && request.method() === "GET") reads += 1;
    });
    await retitle(page, "Moje", "Moja własna");
    await designerSaved(page);
    // The event brings two reads (the list of screens, which the page holds, and this screen), then nothing.
    await expect.poll(() => reads).toBeGreaterThan(0);
    await page.waitForTimeout(1000);
    const settled = reads;
    expect(settled).toBeLessThanOrEqual(2);
    await page.waitForTimeout(1500);
    expect(reads).toBe(settled);
    await expect(elsewhere(page)).toHaveCount(0);
    await expect(page.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
  });
});
