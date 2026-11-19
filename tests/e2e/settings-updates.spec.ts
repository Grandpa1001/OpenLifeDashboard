// D53.4 — the Updates page and the version mark in a real browser (Scope §5.9; Architektura §11.1; DEV §9.52), on a
// built installation whose source of releases is a server of ours on the loopback (RELEASES_API_URL), never GitHub.
// AC1: the page shows the running version and, after "Check now", the newest stable release with its notes as text and a
//      link made from the repository and the tag (not from the feed); the mark in the corner leads to the page and
//      carries a dot only while a newer release is known; a release that is not newer says "newest version"; an
//      installation without an updater says so and offers nothing to check.
// AC2: the switch of the daily check is saved on the server and survives a reload while "Check now" still works; "Check
//      now" sends an empty body and the page has no field for an address; a source that fails, is too soon or is gone
//      is told in words, the rest of the application keeps working; the page is free of axe violations and does not
//      scroll sideways on a phone.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { PRODUCT_VERSION_PATTERN } from "../support/product-version.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

const settings = locale("en", "settings");
const common = locale("en");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1200 } });

const REPO = "acme/dashboard";
const say = (key: string, values: Record<string, string | number> = {}, from: Record<string, unknown> = settings) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(from, key));

type Source = { status: number; headers: Record<string, string>; body: string; asked: number };
const feed = (...releases: Array<{ tag: string; notes?: string }>) =>
  JSON.stringify(releases.map(({ tag, notes }) => ({ tag_name: tag, draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: notes ?? `notes of ${tag}`, html_url: "https://evil.example/elsewhere" })));

const open: http.Server[] = [];
test.afterEach(async () => {
  for (const server of open.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

/** A repository of releases on the loopback whose answer the test sets, and the environment that points an installation at it. */
async function releases(initial: Pick<Source, "status" | "body"> & Partial<Source>) {
  const source: Source = { headers: {}, asked: 0, ...initial };
  const server = http.createServer((_request, response) => {
    source.asked += 1;
    response.writeHead(source.status, { "Content-Type": "application/json", ...source.headers });
    response.end(source.body);
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    source,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    env: { UPDATER_ENABLED: "true", UPDATER_TOKEN: "ab".repeat(32), RELEASES_REPO: REPO, RELEASES_API_URL: url } as const,
  };
}

async function toUpdates(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.updates") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/settings/updates`);
  await expect(page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.updates") })).toHaveAttribute("aria-current", "page");
}

const mark = (page: Page) => page.getByRole("navigation", { name: text(common, "version.navigation") }).getByRole("link", { name: new RegExp(`^v${PRODUCT_VERSION_PATTERN}`) });
const checkNow = (page: Page) => page.getByRole("button", { name: text(settings, "updates.check.now") });

test.describe("D53.4-AC1 the version, the release and the mark", () => {
  test("shows the running version, then the newer release with its notes as text and a link made from the tag, and the mark gets a dot", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 200, body: feed({ tag: "v1.2.0", notes: "Fixes <script>window.hacked = 1</script> and adds **things**" }, { tag: "v1.1.0" }) });
    const owner = await ownerServer("ready", repository.env);
    await signInFully(page, owner);
    await toUpdates(page, owner);

    await expect(page.getByText(say("updates.version.current", { version: "0.0.0" }))).toBeVisible();
    await expect(page.getByText(text(settings, "updates.version.notChecked"))).toBeVisible();
    await expect(mark(page)).toBeVisible();
    await expect(page.locator(".version-dot")).toHaveCount(0);

    await checkNow(page).click();
    await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
    const release = page.getByRole("region", { name: say("updates.release.heading", { version: "1.2.0" }) });
    await expect(release.getByText("Fixes <script>window.hacked = 1</script> and adds **things**")).toBeVisible();
    expect(await page.evaluate("window.hacked")).toBeUndefined();
    await expect(release.getByRole("link", { name: text(settings, "updates.release.open") })).toHaveAttribute("href", `https://github.com/${REPO}/releases/tag/v1.2.0`);
    await expect(page.locator(".version-dot")).toHaveCount(1);
    await expect(mark(page).filter({ hasText: say("version.newer", { latest: "1.2.0" }, common) })).toBeVisible();
    expect(repository.source.asked).toBe(1);

    // The mark leads here from any page of the application, and the state is the same after a reload.
    await page.goto(`${owner.baseUrl}/registers`);
    await mark(page).filter({ hasText: say("version.newer", { latest: "1.2.0" }, common) }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/updates`);
    await page.reload();
    await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
  });

  test("a release that is not newer says that the newest version is in use and the mark has no dot", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 200, body: feed({ tag: "v0.0.0" }) });
    const owner = await ownerServer("ready", repository.env);
    await signInFully(page, owner);
    await toUpdates(page, owner);
    await checkNow(page).click();
    await expect(page.getByText(text(settings, "updates.version.upToDate"))).toBeVisible();
    await expect(page.getByRole("region", { name: /^Version 1/ })).toHaveCount(0);
    await expect(page.locator(".version-dot")).toHaveCount(0);
  });

  test("an installation without an updater says so, offers nothing to check and still shows the version", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toUpdates(page, owner);
    await expect(page.getByText(text(settings, "updates.notConfigured"))).toBeVisible();
    await expect(page.getByText(say("updates.version.current", { version: "0.0.0" }))).toBeVisible();
    await expect(checkNow(page)).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expect(mark(page)).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe("D53.4-AC2 the switch, what Check now sends and what goes wrong", () => {
  test("the switch is saved on the server and survives a reload, Check now works with it off, and the request carries no address", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 200, body: feed({ tag: "v1.2.0" }) });
    const owner = await ownerServer("ready", repository.env);
    await signInFully(page, owner);
    await toUpdates(page, owner);
    const daily = page.getByRole("switch", { name: text(settings, "updates.check.switch") });
    await expect(daily).toBeChecked();
    // There is no field to type an address, a repository or a version into.
    await expect(page.getByRole("textbox")).toHaveCount(0);

    const saved = page.waitForResponse((reply) => reply.url().endsWith("/api/v1/settings") && reply.request().method() === "PATCH");
    await daily.click();
    expect((await saved).status()).toBe(200);
    await expect(daily).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole("switch", { name: text(settings, "updates.check.switch") })).not.toBeChecked();

    const sent = page.waitForRequest((request) => request.url().endsWith("/api/v1/updates/check"));
    await checkNow(page).click();
    expect((await sent).postData()).toBe("{}");
    await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
    // Off, the page does not promise a next check.
    await expect(page.getByText(/^Next check:/)).toHaveCount(0);
  });

  test("a source that fails is told in words, a second try is too soon with the seconds, and the application goes on", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 500, body: "{}" });
    const owner = await ownerServer("ready", repository.env);
    await signInFully(page, owner);
    await toUpdates(page, owner);
    await checkNow(page).click();
    await expect(page.getByRole("alert").filter({ hasText: text(settings, "updates.errors.SERVER_ERROR") })).toBeVisible();
    await expect(page.getByText(text(settings, "updates.check.failed"))).toBeVisible();

    await checkNow(page).click();
    await expect(page.getByRole("alert").filter({ hasText: /It was checked a moment ago\. Try again in \d+ seconds?\./ })).toBeVisible();
    expect(repository.source.asked).toBe(1);

    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(locale("en", "registers"), "title"));
  });

  test("a source that is gone is told as unreachable and the data are untouched", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 200, body: feed({ tag: "v1.2.0" }) });
    const owner = await ownerServer("ready", repository.env);
    await repository.stop();
    await signInFully(page, owner);
    await toUpdates(page, owner);
    await checkNow(page).click();
    await expect(page.getByRole("alert").filter({ hasText: text(settings, "updates.errors.NETWORK_UNAVAILABLE") })).toBeVisible();
    await expect(page.locator(".version-dot")).toHaveCount(0);
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);
  });

  test("the page is free of axe violations with a release, works from the keyboard and does not scroll sideways on a phone", async ({ page, ownerServer }) => {
    const repository = await releases({ status: 200, body: feed({ tag: "v1.2.0", notes: `${"A long line of the notes of the release. ".repeat(40)}\n${"x".repeat(200)}` }) });
    const owner = await ownerServer("ready", repository.env);
    await signInFully(page, owner);
    await toUpdates(page, owner);
    await checkNow(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
    await expectNoViolations(page);

    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    await expectNoViolations(page);
  });
});
