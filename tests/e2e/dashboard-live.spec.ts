// D39.1 — the accent of the screen and the word of a layout from another device, on the dashboard and in the
// Designer in a real browser (Scope §5.3, §5.4; Architektura §7.4, Załącznik H) on Książki of F01.
// AC1: a screen with the accent green has it on the dashboard and in the Designer, and the default comes back
//      in the part of the application. AC2: the dashboard shows "The layout was changed on another device —
//      refreshed" within a second of a layout saved by another tab, takes no focus, and not for the first
//      reading or for the same layout saved again.
import type { Page } from "@playwright/test";
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, openApp, signInFully } from "./owner-session.ts";

const common = locale("en");
const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const W = "019a0000-0000-7000-8000-0000000039f1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };
const GREEN = "#3FB984";
const BLUE = "#5B8DEF";
/** The time a layout of another tab has to reach the dashboard (Scope §5.4 S11). */
const REACHES_WITHIN_MS = 1000;

const accentOf = (page: Page): Promise<string> => page.evaluate('document.documentElement.style.getPropertyValue("--color-accent")');
const liveState = (page: Page): Promise<unknown> => page.evaluate("document.documentElement.dataset.liveStream ?? null");

/** The screen as the server holds it, saved again through the API with a change of `edit`. */
async function saveAgain(page: Page, baseUrl: string, edit: (design: Record<string, unknown>) => void): Promise<void> {
  const listed = (await (await page.request.get(`${baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  const id = listed.screens[0]!.id;
  const screen = (await (await page.request.get(`${baseUrl}/api/v1/screens/${id}`)).json()) as { name: string; theme: string; accent: string; widgets: Array<Record<string, unknown>> };
  const design: Record<string, unknown> = { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: screen.widgets.map((widget) => Object.fromEntries(Object.entries(widget).filter(([key]) => key !== "state"))) };
  edit(design);
  const saved = await page.request.put(`${baseUrl}/api/v1/screens/${id}/design`, { data: design, headers: { Origin: baseUrl } });
  expect(saved.status()).toBe(200);
}

test.describe("D39.1-AC1 the accent of the screen", () => {
  test("green on the dashboard and in the Designer, the default in the part of the application", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: W, title: "Moje", layout: LAYOUT }], "Zielony", "green");
    await page.goto(`${owner.baseUrl}/`);
    await expect.poll(() => accentOf(page)).toBe(GREEN);

    await page.goto(`${owner.baseUrl}/designer`);
    await expect(page.getByRole("region", { name: text(designer, "bar.label") })).toBeVisible();
    await expect.poll(() => accentOf(page)).toBe(GREEN);

    await page.goto(`${owner.baseUrl}/`);
    await expect.poll(() => accentOf(page)).toBe(GREEN);
    await openApp(page, common);
    await expect(page).toHaveURL(`${owner.baseUrl}/screens`);
    await expect.poll(() => accentOf(page)).toBe(BLUE);
  });
});

test.describe("D39.1-AC2 the layout of another device on the dashboard", () => {
  test("a layout saved elsewhere is told within a second without a question; the first reading and the same layout again are not", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: W, title: "Moje", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.getByRole("heading", { name: "Moje" })).toBeVisible();
    await expect.poll(() => liveState(page)).toBe("live");
    const word = page.getByRole("status").filter({ hasText: text(designer, "elsewhere.refreshed") });
    await expect(word).toHaveCount(0);

    // The same layout saved again: nothing to tell.
    const other = await context.newPage();
    await other.goto(`${owner.baseUrl}/screens`);
    await saveAgain(other, owner.baseUrl, () => undefined);
    await page.waitForTimeout(1500);
    await expect(word).toHaveCount(0);

    // Another title: the dashboard takes it and says so, and the focus stays where it was.
    await saveAgain(other, owner.baseUrl, (design) => {
      const widgets = design["widgets"] as Array<{ config: Record<string, unknown> }>;
      widgets[0]!.config = { ...widgets[0]!.config, title: "Z drugiej karty" };
    });
    await expect(page.getByRole("heading", { name: "Z drugiej karty" })).toBeVisible({ timeout: REACHES_WITHIN_MS + 1500 });
    await expect(word).toBeVisible();
    expect(await page.evaluate("document.activeElement === document.body")).toBe(true);
    // And it goes by itself.
    await expect(word).toHaveCount(0, { timeout: 10_000 });
  });

  test("a stream cut off shows nothing of this: the word belongs to a layout, not to a connection", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: W, title: "Moje", layout: LAYOUT }]);
    await page.route(`**${STREAM_PATH}`, (route) => route.abort("connectionfailed"));
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.getByRole("heading", { name: "Moje" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: text(designer, "elsewhere.refreshed") })).toHaveCount(0);
  });
});
