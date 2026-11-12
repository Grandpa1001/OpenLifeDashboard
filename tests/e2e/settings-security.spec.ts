// D43.7 — the Security page in a real browser (Scope §5.9; Architektura §9.6): the sessions, the trusted
// devices and the audit log, on a fresh installation.
// AC1: the sessions are listed with the browser, the address and how each was admitted, the page's own marked
//      and without a button; another one is ended and its cookie is dead; a trusted device is listed and
//      revoked; the audit log lists the events fifty to a page, with the address and the browser, filtered by
//      kind, from the first page again after a change of the filter.
// AC2: an action that needs a fresh second factor asks for it in a dialog over the page: Escape leaves the
//      action undone, a wrong code is told at its field, the right one does the action; the page behind keeps
//      what was chosen; the page and the dialog are free of axe violations and work from the keyboard.
import type { APIRequestContext, Page } from "@playwright/test";
import { IDENTITY_STATUS_PATH } from "@openlife/contracts/http/identity";
import { SETTINGS_PATH } from "@openlife/contracts/http/settings";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations } from "./owner-session.ts";

const auth = locale("en", "auth");
const common = locale("en");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1000 } });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));
const section = (page: Page, key: string) => page.getByRole("region", { name: text(settings, key) });

async function signInWithPassword(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
}

/** In by the password and a TOTP, trusting the browser; the TOTP step of this time window is then used up. */
async function signInTrustingTheDevice(page: Page, owner: BrowserOwner): Promise<void> {
  await signInWithPassword(page, owner);
  await page.getByLabel(text(auth, "mfa.remember")).check();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page).toHaveURL(`${owner.baseUrl}/`);
}

/** In by the password and a recovery code: a session that opens the data but has no fresh TOTP, and leaves the TOTP step free for a step-up. */
async function signInWithRecoveryCode(page: Page, owner: BrowserOwner): Promise<void> {
  await signInWithPassword(page, owner);
  await page.getByRole("button", { name: text(auth, "mfa.useRecovery") }).click();
  await page.getByLabel(text(auth, "mfa.recoveryLabel"), { exact: true }).fill(owner.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/`);
}

/** Another session of the owner, made by the API as another browser: by the password alone or by a recovery code too. */
async function anotherSession(playwright: { request: { newContext: (options: { baseURL: string; extraHTTPHeaders: Record<string, string> }) => Promise<APIRequestContext> } }, owner: BrowserOwner, agent: string, recoveryCode: string | null): Promise<APIRequestContext> {
  const client = await playwright.request.newContext({ baseURL: owner.baseUrl, extraHTTPHeaders: { Origin: owner.baseUrl, "User-Agent": agent } });
  expect((await client.post("/api/auth/sign-in/email", { data: { email: owner.email, password: owner.password } })).status()).toBe(200);
  if (recoveryCode !== null) expect((await client.post("/api/v1/mfa/verify", { data: { recoveryCode } })).status()).toBe(200);
  return client;
}

const stillSignedIn = async (client: APIRequestContext): Promise<boolean> => ((await (await client.get(IDENTITY_STATUS_PATH)).json()) as { authenticated: boolean }).authenticated;

async function toSecurity(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.security") }).click();
  await expect(page).toHaveURL(`${baseUrl}/settings/security`);
}

test.describe("D43.7-AC1 the sessions, the devices and the audit log", () => {
  test("the sessions are listed with their browser, address and admission, the own one is marked and has no button, another ends at once", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInTrustingTheDevice(page, owner);
    const tablet = await anotherSession(playwright, owner, "Old tablet browser", null);
    const phone = await anotherSession(playwright, owner, "Phone browser", owner.recoveryCodes[1] ?? "");
    await toSecurity(page, owner.baseUrl);
    await expect(page.getByRole("link", { name: text(settings, "tabs.security") })).toHaveAttribute("aria-current", "page");

    const sessions = section(page, "security.sessions.heading");
    const rows = sessions.getByRole("row");
    // The header and four sessions: this page's, the two made here and the one the setup of the installation left.
    await expect(rows).toHaveCount(5);
    const own = sessions.getByRole("row").filter({ hasText: text(settings, "security.sessions.current") });
    await expect(own).toHaveCount(1);
    await expect(own.getByRole("cell").nth(0)).toHaveText("127.0.0.1");
    await expect(own.getByRole("cell").nth(1)).toHaveText(text(settings, "security.sessions.assurance.totp"));
    await expect(own.getByRole("button")).toHaveCount(0);
    const phoneRow = sessions.getByRole("row").filter({ hasText: "Phone browser" });
    await expect(phoneRow.getByRole("cell").nth(1)).toHaveText(text(settings, "security.sessions.assurance.recovery"));
    const tabletRow = sessions.getByRole("row").filter({ hasText: "Old tablet browser" });
    await expect(tabletRow.getByRole("cell").nth(1)).toHaveText(text(settings, "security.sessions.assurance.password"));

    // Another session ends at once: the row is gone, the cookie of that browser is dead.
    await tabletRow.getByRole("button", { name: new RegExp(text(settings, "security.sessions.end")) }).click();
    await expect(sessions.getByText(say("security.sessions.ended_one", { count: 1 }))).toBeVisible();
    await expect(sessions.getByRole("row")).toHaveCount(4);
    expect(await stillSignedIn(tablet)).toBe(false);
    expect(await stillSignedIn(phone)).toBe(true);
  });

  test("a trusted device is listed with the day it was trusted and revoked from the page", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInTrustingTheDevice(page, owner);
    await toSecurity(page, owner.baseUrl);
    const devices = section(page, "security.devices.heading");
    await expect(devices.getByRole("row")).toHaveCount(2);
    const row = devices.getByRole("row").nth(1);
    await expect(row.getByRole("rowheader")).not.toHaveText("");
    // Trusted since today, expiring in thirty days: the two days differ.
    const [since, until] = await row.getByRole("cell").allInnerTexts();
    expect(since).not.toBe(until);
    await row.getByRole("button", { name: new RegExp(text(settings, "security.devices.revoke")) }).click();
    await expect(devices.getByText(say("security.devices.revoked_one", { count: 1 }))).toBeVisible();
    await expect(devices.getByText(text(settings, "security.devices.none"))).toBeVisible();
    await expect(devices.getByRole("button", { name: text(settings, "security.devices.revokeAll") })).toHaveCount(0);
  });

  test("the audit log lists the events fifty to a page with the address and the browser, filtered by kind from the first page", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInTrustingTheDevice(page, owner);
    // Sixty changes of an option make sixty events, and the page of fifty has a second.
    for (let n = 0; n < 60; n += 1) {
      const changed = await page.request.patch(`${owner.baseUrl}${SETTINGS_PATH}`, { data: { values: { "tables.defaultPageSize": n % 2 === 0 ? 25 : 30 } }, headers: { Origin: owner.baseUrl } });
      expect(changed.status()).toBe(200);
    }
    await toSecurity(page, owner.baseUrl);
    const log = section(page, "security.audit.heading");
    await expect(log.getByRole("row")).toHaveCount(51);
    await expect(log.getByText(say("security.audit.pageOf", { page: 1, pages: 2 }))).toBeVisible();
    await expect(log.getByRole("button", { name: text(settings, "security.audit.previous") })).toBeDisabled();
    await expect(log.getByRole("row").nth(1).getByRole("rowheader")).toHaveText(text(settings, "security.audit.actions.setting.changed"));

    await log.getByRole("button", { name: text(settings, "security.audit.next") }).click();
    await expect(log.getByText(say("security.audit.pageOf", { page: 2, pages: 2 }))).toBeVisible();
    await expect(log.getByRole("button", { name: text(settings, "security.audit.next") })).toBeDisabled();

    // A filter starts from the first page again and holds only its own kind.
    await log.getByLabel(text(settings, "security.audit.kind")).selectOption("logins");
    await expect(log.getByText(say("security.audit.pageOf", { page: 1, pages: 1 }))).toBeVisible();
    // A sign-in event carries the address and the browser it came from, in full, and the reference code of its request.
    const signedIn = log.getByRole("row").filter({ has: page.getByRole("rowheader", { name: text(settings, "security.audit.actions.login.succeeded") }) }).first();
    await expect(signedIn.getByRole("cell").nth(1)).toHaveText("127.0.0.1");
    await expect(signedIn.getByRole("cell").nth(2)).not.toHaveText("");
    await expect(signedIn.getByRole("cell").nth(3).locator("code")).not.toBeEmpty();
    for (const header of await log.getByRole("rowheader").allInnerTexts()) {
      expect([text(settings, "security.audit.actions.login.succeeded"), text(settings, "security.audit.actions.mfa.verified"), text(settings, "security.audit.actions.login.failed")]).toContain(header);
    }
    await log.getByLabel(text(settings, "security.audit.kind")).selectOption("updates");
    await expect(log.getByText(text(settings, "security.audit.none"))).toBeVisible();
  });
});

test.describe("D43.7-AC2 the dialog of the proof", () => {
  test("asks for a TOTP, leaves the action undone on Escape, tells a wrong code at its field, does the action with the right one, and the page behind keeps its choice", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    const tablet = await anotherSession(playwright, owner, "Old tablet browser", null);
    await toSecurity(page, owner.baseUrl);
    const sessions = section(page, "security.sessions.heading");
    const endOthers = sessions.getByRole("button", { name: text(settings, "security.sessions.endOthers") });
    // The page keeps what was chosen in the log while the dialog is up.
    await section(page, "security.audit.heading").getByLabel(text(settings, "security.audit.kind")).selectOption("security");

    await endOthers.click();
    const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(text(settings, "security.stepUp.codeLabel"))).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(sessions.getByRole("alert")).toContainText(text(locale("en", "errors"), "STEP_UP_REQUIRED"));
    expect(await stillSignedIn(tablet)).toBe(true);

    await endOthers.click();
    await dialog.getByLabel(text(settings, "security.stepUp.codeLabel")).fill("12345");
    await dialog.getByRole("button", { name: text(settings, "security.stepUp.confirm") }).click();
    await expect(dialog.getByText(text(settings, "security.stepUp.codeMalformed"))).toBeVisible();
    await dialog.getByLabel(text(settings, "security.stepUp.codeLabel")).fill("000000");
    await dialog.getByRole("button", { name: text(settings, "security.stepUp.confirm") }).click();
    await expect(dialog.getByText(text(settings, "security.stepUp.codeRefused"))).toBeVisible();
    await expectNoViolations(page);

    await dialog.getByLabel(text(settings, "security.stepUp.codeLabel")).fill(await owner.code(1));
    await dialog.getByRole("button", { name: text(settings, "security.stepUp.confirm") }).click();
    await expect(dialog).toBeHidden();
    // The tablet and the session the setup of the installation left are the other two.
    await expect(sessions.getByText(say("security.sessions.ended_other", { count: 2 }))).toBeVisible();
    expect(await stillSignedIn(tablet)).toBe(false);
    // The session of the page was replaced by the proof and now stands on the TOTP; the choice in the log is kept.
    await expect(sessions.getByRole("row").filter({ hasText: text(settings, "security.sessions.current") }).getByRole("cell").nth(1)).toHaveText(text(settings, "security.sessions.assurance.totp"));
    await expect(section(page, "security.audit.heading").getByLabel(text(settings, "security.audit.kind"))).toHaveValue("security");
  });

  test("the page and the dialog work from the keyboard and are free of axe violations", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    await anotherSession(playwright, owner, "Old tablet browser", null);
    await toSecurity(page, owner.baseUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settings, "title"));
    await expectNoViolations(page);

    // The button is reached and pressed from the keyboard; the dialog takes the focus and gives it back.
    const endOthers = section(page, "security.sessions.heading").getByRole("button", { name: text(settings, "security.sessions.endOthers") });
    await endOthers.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
    await expect(dialog.getByLabel(text(settings, "security.stepUp.codeLabel"))).toBeFocused();
    await expectNoViolations(page);
    await page.keyboard.type(await owner.code(1));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(section(page, "security.sessions.heading").getByText(say("security.sessions.ended_other", { count: 2 }))).toBeVisible();
    // The app bar is still there: nothing of the page was lost.
    await expect(page.getByRole("navigation", { name: text(common, "appBar.navigation") })).toBeVisible();
  });
});
