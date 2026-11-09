// D36.3 — S13 (Scope §6.3) in a real browser with the clock of the page set to the two moments of F02
// (the night the clocks change in Warsaw and New York), the owner's zone, and what a clock leaves behind.
// AC1: at each moment Dom (the owner's zone) and Nowy Jork show the local times of F02; changing the
//      owner's zone moves Dom only. AC2: a tab that comes back shows the current time at once; clocks
//      removed in the Designer leave no timer and no listener behind.
import type { Page } from "@playwright/test";
import { SCREENS_PATH, screenDesignPath } from "@openlife/contracts/http/screens";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserOwner } from "../support/auth-http.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { designerSaved, expectNoViolations, openApp, signInFully } from "./owner-session.ts";

const common = locale("en");
const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

type Widget = { id: string; type: string; config: Record<string, unknown>; layout: unknown; bindings: unknown[] };
type ClockCase = { nowIso: string; "Europe/Warsaw": string; "America/New_York": string };
const F01 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { screens: Array<{ name: string; widgets: Widget[] }> };
const F02 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { fixedClockCases: ClockCase[] };
const CLOCKS = F01.screens[0]!.widgets.filter((widget) => widget.type === "clock");

/** A quarter of a second past the moment: no timer of the page ends on a whole second except the ticker of a clock. */
const OFFSET_MS = 250;
const clockOf = (page: Page, label: string) => page.getByRole("region", { name: `Clock: ${label}` });

/** The screen of F01 with its two clocks, the page clock started at the moment and left to run (a paused one holds the timers of the page too). */
async function screenWithClocks(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  const headers = { Origin: owner.baseUrl };
  const created = await page.request.post(`${owner.baseUrl}${SCREENS_PATH}`, { data: { name: F01.screens[0]!.name }, headers });
  const screenId = ((await created.json()) as { id: string }).id;
  const saved = await page.request.put(`${owner.baseUrl}${screenDesignPath(screenId)}`, { data: { name: F01.screens[0]!.name, theme: "dark", accent: "blue", widgets: CLOCKS }, headers });
  expect(saved.status()).toBe(200);
}

test.describe("D36.3-AC1 S13: the clocks at the two moments of F02 and the zone of the owner", () => {
  for (const [index, moment] of F02.fixedClockCases.entries()) {
    test(`moment ${index + 1} of F02 (${moment.nowIso}): Dom shows ${moment["Europe/Warsaw"]} in Warsaw and Nowy Jork ${moment["America/New_York"]} in New York`, async ({ page, ownerServer }) => {
      await page.clock.install({ time: new Date(new Date(moment.nowIso).getTime() + OFFSET_MS) });
      const owner = await ownerServer("ready");
      await screenWithClocks(page, owner);
      await page.goto(`${owner.baseUrl}/`);

      await expect(clockOf(page, "Dom").locator("time")).toHaveText(moment["Europe/Warsaw"]);
      await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(new RegExp(`^${moment["America/New_York"]}:[0-5]\\d$`));
      await expect(clockOf(page, "Dom")).toContainText("Dom · Europe/Warsaw");
      await expect(clockOf(page, "Nowy Jork")).toContainText("Nowy Jork · America/New_York");
      await expectNoViolations(page);
    });
  }

  test("changing the zone of the owner moves the clock of the owner and leaves the one with its own zone", async ({ page, ownerServer }) => {
    const moment = F02.fixedClockCases[0]!;
    await page.clock.install({ time: new Date(new Date(moment.nowIso).getTime() + OFFSET_MS) });
    const owner = await ownerServer("ready");
    await screenWithClocks(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    await expect(clockOf(page, "Dom").locator("time")).toHaveText(moment["Europe/Warsaw"]);

    const changed = await page.request.put(`${owner.baseUrl}/api/v1/setup/preferences`, { data: { timezone: "Asia/Tokyo", locale: "en" }, headers: { Origin: owner.baseUrl } });
    expect(changed.status()).toBe(200);
    await page.reload();

    // 00:30 UTC is 09:30 in Tokyo; New York keeps its own zone.
    await expect(clockOf(page, "Dom").locator("time")).toHaveText("09:30");
    await expect(clockOf(page, "Dom")).toContainText("Dom · Asia/Tokyo");
    await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(new RegExp(`^${moment["America/New_York"]}:[0-5]\\d$`));
    await expect(clockOf(page, "Nowy Jork")).toContainText("Nowy Jork · America/New_York");
  });
});

/** What a clock leaves in the page, counted by a spy that is set up after the page clock: the ticks that end on a whole second, and the listeners of `focus`. Written as a script, as the tests of this project compile without the types of the DOM. */
const SPY = `(() => {
  const spy = { ticks: 0, focus: new Set() };
  window.__clockSpy = spy;
  const set = window.setTimeout.bind(window);
  window.setTimeout = (handler, delay, ...rest) => {
    if ((Date.now() + (delay ?? 0)) % 1000 === 0) spy.ticks += 1;
    return set(handler, delay, ...rest);
  };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, listener, ...rest) => {
    if (type === "focus") spy.focus.add(listener);
    return add(type, listener, ...rest);
  };
  window.removeEventListener = (type, listener, ...rest) => {
    if (type === "focus") spy.focus.delete(listener);
    return remove(type, listener, ...rest);
  };
})();`;
const spyOnTheClocks = async (page: Page): Promise<void> => {
  await page.addInitScript(SPY);
};
const spyState = (page: Page): Promise<{ ticks: number; focus: number }> => page.evaluate("({ ticks: window.__clockSpy.ticks, focus: window.__clockSpy.focus.size })");

test.describe("D36.3-AC2 a tab that comes back and clocks that are removed", () => {
  test("a tab that comes back shows the current time at once, by the focus and by the visibility of the page", async ({ page, ownerServer }) => {
    const first = F02.fixedClockCases[0]!;
    const second = F02.fixedClockCases[1]!;
    await page.clock.install({ time: new Date(new Date(first.nowIso).getTime() + OFFSET_MS) });
    const owner = await ownerServer("ready");
    await screenWithClocks(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    await expect(clockOf(page, "Dom").locator("time")).toHaveText(first["Europe/Warsaw"]);

    // The time moves while the timers of a hidden tab do not run; the next boundary of the minute is ~59 s away.
    await page.clock.setSystemTime(new Date(new Date(second.nowIso).getTime() + OFFSET_MS));
    await page.evaluate('window.dispatchEvent(new Event("focus"))');
    await expect(clockOf(page, "Dom").locator("time")).toHaveText(second["Europe/Warsaw"]);
    await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(new RegExp(`^${second["America/New_York"]}:[0-5]\\d$`));

    await page.clock.setSystemTime(new Date(new Date("2026-03-29T02:30:00Z").getTime() + OFFSET_MS));
    await page.evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await expect(clockOf(page, "Dom").locator("time")).toHaveText("04:30");
    await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(/^22:30:[0-5]\d$/);
  });

  test("clocks removed in the Designer leave no timer and no listener when the screen is shown again", async ({ page, ownerServer }) => {
    const moment = F02.fixedClockCases[0]!;
    await page.clock.install({ time: new Date(new Date(moment.nowIso).getTime() + OFFSET_MS) });
    await spyOnTheClocks(page);
    const owner = await ownerServer("ready");
    await screenWithClocks(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(new RegExp(`^${moment["America/New_York"]}:[0-5]\\d$`));

    // The spy sees the clocks at work: each has its listener and the seconds keep ticking.
    const withClocks = await spyState(page);
    const ticksBefore = withClocks.ticks;
    await page.clock.runFor(3000);
    expect((await spyState(page)).ticks).toBeGreaterThan(ticksBefore);

    // Through the application to the Designer (the same page, nothing reloaded), both clocks deleted, back on the screen.
    await openApp(page, common);
    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.screens") }).click();
    await page.getByRole("link", { name: text(designer, "screens.edit") }).first().click();
    const bar = page.getByRole("region", { name: text(designer, "bar.label") });
    for (const label of ["Nowy Jork", "Dom"]) {
      await page.getByRole("button", { name: `Select widget: ${label}` }).click();
      await bar.getByRole("button", { name: text(designer, "bar.delete") }).click();
    }
    await designerSaved(page);
    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(common, "main.title"));
    await expect(page.getByText(text(common, "main.empty"))).toBeVisible();

    // Two clocks gone: two listeners fewer, and a quarter of a minute of the page clock ends no tick on a whole second.
    const without = await spyState(page);
    expect(withClocks.focus - without.focus).toBe(2);
    const ticksAfter = without.ticks;
    await page.clock.runFor(15_000);
    expect((await spyState(page)).ticks).toBe(ticksAfter);
  });
});
