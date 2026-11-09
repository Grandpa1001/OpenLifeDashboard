// D37.2 — the live stream of a tab in a real browser, on the built server (Scope §5.4 S11; Architektura §7.6, §10).
// AC1: a signed-in tab has one stream and shows it live; the server stops and returns, the tab goes offline,
// connects again by itself and reads its data again. AC2: a tab that comes back (focus, visibility, online)
// connects at once instead of waiting; sign-out closes the stream, also when it is done elsewhere; moves between
// private screens and lost connections leave one stream and no more.
import type { Page } from "@playwright/test";
import { SCREENS_PATH } from "@openlife/contracts/http/screens";
import { SIGN_OUT_PATH } from "@openlife/contracts/http/identity";
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { expect, locale, test, text } from "./fixtures.ts";
import { openApp, signInFully, signOutFromApp } from "./owner-session.ts";

const common = locale("en");
test.use({ locale: "en-US", viewport: { width: 1280, height: 800 } });

/** Counts the streams the page holds open and the states the tab went through. A script, as the tests of this project compile without the types of the DOM. */
const SPY = `(() => {
  const spy = { opened: 0, open: 0, states: [] };
  window.__liveSpy = spy;
  const Native = window.EventSource;
  window.EventSource = class extends Native {
    constructor(...args) {
      super(...args);
      spy.opened += 1;
      spy.open += 1;
      const close = this.close.bind(this);
      let closed = false;
      this.close = () => {
        if (!closed) spy.open -= 1;
        closed = true;
        close();
      };
    }
  };
  new MutationObserver(() => {
    const state = document.documentElement.dataset.liveStream;
    if (state && spy.states[spy.states.length - 1] !== state) spy.states.push(state);
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-live-stream"] });
})();`;

const stateOf = (page: Page): Promise<string | null> => page.evaluate("document.documentElement.dataset.liveStream ?? null");
const spyOf = (page: Page): Promise<{ opened: number; open: number; states: string[] }> => page.evaluate("({ ...window.__liveSpy, states: [...window.__liveSpy.states] })");

/** Requests for the stream and for the list of screens (a query the screen of the owner keeps active), counted from now on. */
function counters(page: Page): { streams: () => number; screenReads: () => number } {
  let streams = 0;
  let screenReads = 0;
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname === STREAM_PATH) streams += 1;
    if (pathname === SCREENS_PATH && request.method() === "GET") screenReads += 1;
  });
  return { streams: () => streams, screenReads: () => screenReads };
}

test.describe("D37.2-AC1 one stream per tab, lost and found again", () => {
  test("a signed-in tab holds one stream and is live; moves between private screens keep it", async ({ page, ownerServer }) => {
    await page.addInitScript(SPY);
    const owner = await ownerServer("ready");
    const seen = counters(page);
    await signInFully(page, owner);
    await expect.poll(() => stateOf(page)).toBe("live");
    expect(seen.streams()).toBe(1);

    await openApp(page, common);
    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.screens") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/screens`);
    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.registers") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);

    expect(await stateOf(page)).toBe("live");
    expect(seen.streams()).toBe(1);
    expect((await spyOf(page)).open).toBe(1);
  });

  test("the server stops and returns: offline, then live again by itself, and the data on the screen is read again", async ({ page, ownerServer }) => {
    await page.addInitScript(SPY);
    const owner = await ownerServer("ready");
    const seen = counters(page);
    await signInFully(page, owner);
    await expect.poll(() => stateOf(page)).toBe("live");
    const readsBefore = seen.screenReads();

    await owner.restart();
    await expect.poll(() => stateOf(page), { timeout: 30_000 }).toBe("live");
    await expect.poll(() => seen.screenReads()).toBeGreaterThan(readsBefore);

    const spy = await spyOf(page);
    expect(spy.states).toEqual(["connecting", "live", "offline", "live"]);
    expect(spy.open).toBe(1);
    expect(seen.streams()).toBe(spy.opened);
  });
});

test.describe("D37.2-AC2 a tab that comes back, and the end of the session", () => {
  for (const [name, wake] of [
    ["focus", 'window.dispatchEvent(new Event("focus"))'],
    ["online", 'window.dispatchEvent(new Event("online"))'],
    ["the visibility of the page", 'document.dispatchEvent(new Event("visibilitychange"))'],
  ] as const) {
    test(`${name} connects at once, without the wait after a failed attempt`, async ({ page, ownerServer }) => {
      await page.addInitScript(SPY);
      const owner = await ownerServer("ready");
      const seen = counters(page);
      await signInFully(page, owner);
      await expect.poll(() => stateOf(page)).toBe("live");

      // The server returns, but the way to the stream is cut: each attempt fails, and the waits grow (1 s, 2 s, then 5 s).
      await page.route(`**${STREAM_PATH}`, (route) => route.abort("connectionfailed"));
      await owner.restart();
      await expect.poll(() => seen.streams(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
      expect(await stateOf(page)).toBe("offline");

      await page.unroute(`**${STREAM_PATH}`);
      const attempts = seen.streams();
      await page.evaluate(wake);
      await expect.poll(() => stateOf(page), { timeout: 2000 }).toBe("live");
      expect(seen.streams()).toBe(attempts + 1);
      expect((await spyOf(page)).open).toBe(1);
    });
  }

  test("signing out closes the stream and it does not come back", async ({ page, ownerServer }) => {
    await page.addInitScript(SPY);
    const owner = await ownerServer("ready");
    const seen = counters(page);
    await signInFully(page, owner);
    await expect.poll(() => stateOf(page)).toBe("live");

    await signOutFromApp(page, common);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await expect.poll(() => spyOf(page).then((spy) => spy.open)).toBe(0);
    expect(await stateOf(page)).toBe("idle");
    await page.waitForTimeout(2500);
    expect(seen.streams()).toBe(1);
  });

  test("a session ended elsewhere closes the stream, the tab asks the server and goes to the sign-in", async ({ page, ownerServer }) => {
    await page.addInitScript(SPY);
    const owner = await ownerServer("ready");
    const seen = counters(page);
    await signInFully(page, owner);
    await expect.poll(() => stateOf(page)).toBe("live");

    // Not through the page: no other tab is told, the stream is the only word the tab gets.
    const ended = await page.request.post(`${owner.baseUrl}${SIGN_OUT_PATH}`, { data: {}, headers: { Origin: owner.baseUrl } });
    expect(ended.ok()).toBe(true);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await expect.poll(() => spyOf(page).then((spy) => spy.open)).toBe(0);
    expect(await stateOf(page)).toBe("idle");
    expect(seen.streams()).toBe(1);
  });
});
