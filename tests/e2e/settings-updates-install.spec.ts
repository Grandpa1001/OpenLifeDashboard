// D57.1 — the start of an update from the Updates page in a real browser (Scope §5.9, S14; Architektura §11.2.2; DEV §9.56), on a built
// installation whose source of releases is a server of ours on the loopback and which has no updater to reach (the updater of Compose is in
// tests/system), so the start goes up to the updater and no further.
// AC1: the page offers "Install" only for a release that is newer than the running one, asks what will happen before it starts, starts nothing
//      on "Cancel" (and gives the focus back), and sends the version and nothing else; an accepted start says the update has begun and the page
//      reads the state, which is the truth about it.
// AC2: without a fresh second factor the dialog of the page asks for a code and the start is made once with it; a refusal is told in words (the
//      release is not the one found, an update is going on, the updater did not accept it) and nothing is changed; the page is free of axe
//      violations with the confirmation and does not scroll sideways on a phone.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { PRODUCT_VERSION } from "../support/product-version.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations } from "./owner-session.ts";

const settings = locale("en", "settings");
const auth = locale("en", "auth");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1200 } });

const REPO = "acme/dashboard";
const INSTALL = "**/api/v1/updates/install";
const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));
const feed = (tag: string) => JSON.stringify([{ tag_name: tag, draft: false, prerelease: false, published_at: "2026-11-10T12:00:00Z", body: `notes of ${tag}`, html_url: "https://evil.example/elsewhere" }]);

const open: http.Server[] = [];
test.afterEach(async () => {
  for (const server of open.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

/** A repository of releases on the loopback and the environment that points an installation at it. */
async function releases(tag: string) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(feed(tag));
  });
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { UPDATER_ENABLED: "true", UPDATER_TOKEN: "ab".repeat(32), RELEASES_REPO: REPO, RELEASES_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } as const;
}

/** In by the password and a recovery code: a session that opens the data but has no fresh second factor, and leaves the TOTP step free for a step-up. */
async function signInWithoutAFreshFactor(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByRole("button", { name: text(auth, "mfa.useRecovery") }).click();
  await page.getByLabel(text(auth, "mfa.recoveryLabel"), { exact: true }).fill(owner.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/`);
}

async function toUpdatesAndCheck(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/settings/updates`);
  await page.getByRole("button", { name: text(settings, "updates.check.now") }).click();
  await expect(page.getByText(say("updates.version.available", { version: "1.2.0" }))).toBeVisible();
}

const installButton = (page: Page) => page.getByRole("button", { name: say("updates.install.button", { version: "1.2.0" }) });
const confirmGroup = (page: Page) => page.getByRole("group", { name: say("updates.install.confirmHeading", { version: "1.2.0" }) });

test.describe("D57.1-AC1 the offer, the question before it and what is sent", () => {
  test("offers the install only for a newer release, and asks what will happen before anything is sent; Cancel sends nothing and returns the focus", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases("v1.2.0"));
    await signInWithoutAFreshFactor(page, owner);
    await page.goto(`${owner.baseUrl}/settings/updates`);
    // Before the first check there is no release, so no offer.
    await expect(installButton(page)).toHaveCount(0);
    await page.getByRole("button", { name: text(settings, "updates.check.now") }).click();
    await expect(installButton(page)).toBeVisible();

    const sent: string[] = [];
    page.on("request", (request) => request.url().endsWith("/api/v1/updates/install") && sent.push(request.url()));
    await installButton(page).click();
    const group = confirmGroup(page);
    await expect(group).toBeVisible();
    await expect(group.getByText(text(settings, "updates.install.confirmText"))).toBeVisible();
    await group.getByRole("button", { name: text(settings, "updates.install.cancel") }).click();
    await expect(group).toBeHidden();
    await expect(installButton(page)).toBeFocused();
    expect(sent).toEqual([]);
  });

  test("an installation with no newer release has no offer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases(`v${PRODUCT_VERSION}`));
    await signInWithoutAFreshFactor(page, owner);
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await page.getByRole("button", { name: text(settings, "updates.check.now") }).click();
    await expect(page.getByText(text(settings, "updates.version.upToDate"))).toBeVisible();
    await expect(page.getByRole("button", { name: /^Install /i })).toHaveCount(0);
  });

  test("an accepted start sends the version and nothing else, says the update has begun, and the page reads the state, which hides the offer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases("v1.2.0"));
    await signInWithoutAFreshFactor(page, owner);
    await toUpdatesAndCheck(page, owner);
    let body: string | null = null;
    await page.route(INSTALL, async (route) => {
      body = route.request().postData();
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ operationId: "11111111-1111-4111-8111-111111111111", release: "1.2.0", accepted: true }) });
    });
    // The state as the updater has it once the operation is on its journal.
    await page.route("**/api/v1/updates", async (route) => {
      const real = await route.fetch();
      const json = (await real.json()) as Record<string, unknown>;
      await route.fulfill({ response: real, json: { ...json, operation: { operationId: "11111111-1111-4111-8111-111111111111", state: "pulling", targetRelease: "1.2.0", error: null } } });
    });
    await installButton(page).click();
    // A fresh factor is asked for first: this session has none.
    const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
    await confirmGroup(page).getByRole("button", { name: text(settings, "updates.install.confirm") }).click();
    // The mocked answer does not ask for a factor, so the start went through at once.
    await expect(page.getByText(text(settings, "updates.install.started"))).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(JSON.parse(body ?? "{}")).toEqual({ release: "1.2.0" });
    await expect(installButton(page)).toHaveCount(0);
    // The page reads the state again on its own: a read still in flight when the test ends must not fail it (nightly run 44282883994).
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test.describe("D57.1-AC2 the factor, the refusals in words, and the page", () => {
  test("asks for a fresh code in the dialog of the page, then makes the start once, and the refusal of the updater is told in words with nothing changed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases("v1.2.0"));
    await signInWithoutAFreshFactor(page, owner);
    await toUpdatesAndCheck(page, owner);
    const installs: Array<string | null> = [];
    page.on("request", (request) => request.url().endsWith("/api/v1/updates/install") && installs.push(request.postData()));

    await installButton(page).click();
    await confirmGroup(page).getByRole("button", { name: text(settings, "updates.install.confirm") }).click();
    const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(text(settings, "security.stepUp.codeLabel")).fill(await owner.code(1));
    await dialog.getByRole("button", { name: text(settings, "security.stepUp.confirm") }).click();
    // The server checks the access, finds the release, and cannot reach an updater: the start is refused, in words, and nothing is held.
    await expect(page.getByRole("alert").filter({ hasText: text(settings, "updates.install.refused.UPDATE_UNAVAILABLE") })).toBeVisible();
    expect(installs).toEqual(['{"release":"1.2.0"}', '{"release":"1.2.0"}']);
    await expect(page.getByText(text(settings, "updates.install.started"))).toHaveCount(0);
    expect((await page.request.get(`${owner.baseUrl}/api/health`)).status()).toBe(200);
    // A settings write still works: nothing was closed.
    const check = page.getByRole("switch", { name: text(settings, "updates.check.switch") });
    const saved = page.waitForResponse((reply) => reply.url().endsWith("/api/v1/settings") && reply.request().method() === "PATCH");
    await check.click();
    expect((await saved).status()).toBe(200);
  });

  test("tells a refusal that the release is not the one found, and one that an update is going on, in words, and reads the state again", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases("v1.2.0"));
    await signInWithoutAFreshFactor(page, owner);
    await toUpdatesAndCheck(page, owner);
    for (const [code, status] of [["UPDATE_RELEASE_UNKNOWN", 409], ["UPDATE_IN_PROGRESS", 409], ["MAINTENANCE", 503]] as const) {
      await page.unroute(INSTALL);
      await page.route(INSTALL, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code, message: "x", details: null, requestId: "r-1" }) }));
      await installButton(page).click();
      let reread = false;
      page.on("request", (request) => request.url().endsWith("/api/v1/updates") && request.method() === "GET" && (reread = true));
      await confirmGroup(page).getByRole("button", { name: text(settings, "updates.install.confirm") }).click();
      await expect(page.getByRole("alert").filter({ hasText: text(settings, `updates.install.refused.${code}`) })).toBeVisible();
      await expect.poll(() => reread).toBe(true);
    }
  });

  test("the confirmation is free of axe violations, works from the keyboard and the page does not scroll sideways on a phone", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready", await releases("v1.2.0"));
    await signInWithoutAFreshFactor(page, owner);
    await toUpdatesAndCheck(page, owner);
    await installButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(confirmGroup(page)).toBeVisible();
    await expectNoViolations(page);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(confirmGroup(page)).toBeVisible();
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    await expectNoViolations(page);
  });
});
