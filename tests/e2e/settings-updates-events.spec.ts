// D57.3 — a tab that did not start the update sees it through the live stream (Scope §5.9; Architektura §10; DEV §9.56), in a real browser. The event of the stream is
// delivered by a source of events the test controls (the real one is the server's stream, which the integration tests read frame by frame); the state is the
// real one of the installation with the operation the test says.
// AC1: an event that the update moved makes the tab read the state at once, without waiting for the next poll: the offer to install goes and the course of the
//      update is shown; the end of the update is shown the same way; an event of another kind does not read it again.
// AC2: the event carries nothing of the operation: what the tab shows is what the state says, not what the event said.
import type { Page, Route } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, locale, test, text } from "./fixtures.ts";
import { signInFully } from "./owner-session.ts";

const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1200 } });

const ID = "11111111-1111-4111-8111-111111111111";
const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));

const open: http.Server[] = [];
test.afterEach(async () => {
  for (const server of open.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

async function releases() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([{ tag_name: "v1.2.0", draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: "notes", html_url: "https://evil.example/elsewhere" }]));
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { UPDATER_ENABLED: "true", UPDATER_TOKEN: "ab".repeat(32), RELEASES_REPO: "acme/dashboard", RELEASES_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } as const;
}

/** A source of events the test drives: the page's own `EventSource` is replaced by one that says `ready` and then says what the test emits. */
async function controllableStream(page: Page): Promise<void> {
  await page.context().addInitScript(`
    window.__live = { sources: [], emit(name, data) { for (const source of this.sources) source.emit(name, data); } };
    window.EventSource = class {
      constructor(url) { this.url = url; this.listeners = {}; window.__live.sources.push(this); queueMicrotask(() => this.emit("ready", "{}")); }
      addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
      close() {}
      emit(name, data) { for (const listener of this.listeners[name] || []) listener({ data }); }
    };
  `);
}
const emit = (page: Page, name: string, data = "{}") => page.evaluate(`window.__live.emit(${JSON.stringify(name)}, ${JSON.stringify(data)})`);

type Operation = { operationId: string; state: string; targetRelease: string | null; error: { code: string } | null } | null;

test.describe("D57.3-AC1 a tab that did not start the update reads the state when the stream says it moved", () => {
  test("the offer goes and the course is shown at once on the event, and the end is shown the same way, while an event of another kind reads nothing", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases());
    await controllableStream(page);
    await signInFully(page, owner);
    let operation: Operation = null;
    let current: string | undefined = undefined;
    let reads = 0;
    await page.route("**/api/v1/updates", async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      reads += 1;
      const real = await route.fetch();
      const json = (await real.json()) as Record<string, unknown>;
      return route.fulfill({ response: real, json: { ...json, ...(current === undefined ? {} : { current }), operation } });
    });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await page.getByRole("button", { name: text(settings, "updates.check.now") }).click();
    const offer = page.getByRole("button", { name: say("updates.install.button", { version: "1.2.0" }) });
    await expect(offer).toBeVisible();

    // Another tab starts the update: this one is told only that something moved.
    const before = reads;
    operation = { operationId: ID, state: "pulling", targetRelease: "1.2.0", error: null };
    await emit(page, "update.changed");
    await expect(page.getByRole("status").filter({ hasText: say("updates.progress.stage.pulling") })).toBeVisible({ timeout: 1500 });
    await expect(offer).toHaveCount(0);
    expect(reads).toBeGreaterThan(before);

    // The end, the same way: the application answers as the new version.
    operation = { operationId: ID, state: "completed", targetRelease: "1.2.0", error: null };
    current = "1.2.0";
    await emit(page, "update.changed");
    await expect(page.getByRole("region", { name: text(settings, "updates.result.heading.updated") })).toBeVisible({ timeout: 3500 });

    // An event that says nothing of the update reads nothing of it.
    const settled = reads;
    operation = { operationId: ID, state: "pulling", targetRelease: "1.3.0", error: null };
    await emit(page, "day.changed");
    await page.waitForTimeout(600);
    expect(reads).toBe(settled);
  });
});

test.describe("D57.3-AC2 what the tab shows is what the state says, not what the event said", () => {
  test("an event whose data claims another operation changes nothing: the state is what is shown", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases());
    await controllableStream(page);
    await signInFully(page, owner);
    await page.route("**/api/v1/updates", async (route: Route) => {
      if (route.request().method() !== "GET") return route.continue();
      const real = await route.fetch();
      const json = (await real.json()) as Record<string, unknown>;
      return route.fulfill({ response: real, json: { ...json, operation: { operationId: ID, state: "backing_up", targetRelease: "1.2.0", error: null } } });
    });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await expect(page.getByRole("status").filter({ hasText: say("updates.progress.stage.backing_up") })).toBeVisible();
    // An event that carries a state of its own is not an event of the contract: it is dropped, and nothing of it is shown.
    await emit(page, "update.changed", JSON.stringify({ state: "completed", targetRelease: "9.9.9" }));
    await page.waitForTimeout(400);
    await expect(page.getByRole("status").filter({ hasText: say("updates.progress.stage.backing_up") })).toBeVisible();
    await expect(page.getByRole("region", { name: text(settings, "updates.result.heading.updated") })).toHaveCount(0);
    await expect(page.getByText("9.9.9")).toHaveCount(0);
  });
});
