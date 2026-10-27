// D12.3 — the first setup in a real browser on a fresh installation: enrollment, the starting
// data, the preferences, and the empty private screen; the stage survives a restart without
// repeating anything; signing out ends the session in every tab of the browser and for the old
// cookie. The server's nextAction and the setup stage are the only authorities (F09
// minimal-setup-resumes-after-restart).
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { codeOf, execute, secretOf } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const enAuth = locale("en", "auth");
const auth = enAuth;
const errors = locale("en", "errors");
const setup = locale("en", "setup");
const common = locale("en");
const plSetup = locale("pl", "setup");
const plCommon = locale("pl");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function signIn(page: Page, owner: { baseUrl: string; email: string; password: string }, auth: Record<string, unknown> = enAuth): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
}

const heading = (page: Page) => page.getByRole("heading", { level: 2 });

test.describe("the first setup from an empty installation", () => {
  test("enrollment, recovery codes, empty data and preferences lead to the empty private screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner);
    const key = (await page.locator(".manual-key").innerText()).replaceAll(/\s/g, "");
    const secret = secretOf(`otpauth://totp/x?secret=${key}`);
    await page.getByLabel(text(setup, "enrollment.codeLabel")).fill(await codeOf(secret));
    await page.getByRole("button", { name: text(setup, "enrollment.submit") }).click();
    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();

    // The starting data: only the empty start, no import and no guided start are offered or implied.
    await expect(heading(page)).toHaveText(text(setup, "data.heading"));
    await expect(page.getByRole("button")).toHaveCount(2); // the choice and the sign-out
    expect((await page.locator("main").innerText()).toLowerCase()).not.toMatch(/import|designer|wizard|guide/);
    await expectNoViolations(page);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).click();

    // The preferences: the browser's zone is offered, an unknown one is refused by the server and kept for correction.
    await expect(heading(page)).toHaveText(text(setup, "preferences.heading"));
    await expectNoViolations(page);
    const zone = page.getByLabel(text(setup, "preferences.timezoneLabel"));
    await expect(zone).not.toHaveValue("");
    await zone.fill("Mars/Olympus_Mons");
    await page.getByRole("button", { name: text(setup, "preferences.save") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "VALIDATION_FAILED"));
    await expect(zone).toHaveValue("Mars/Olympus_Mons");
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await zone.fill("Europe/Warsaw");
    await page.getByLabel("Polski").check();
    await page.getByRole("button", { name: text(setup, "preferences.save") }).click();

    // Done: the private screen is open, in the saved language, and honest about being empty.
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(plCommon, "main.title"));
    await expect(page.getByText(text(plCommon, "main.empty"))).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    await expectNoViolations(page);
    await page.goto(`${owner.baseUrl}/setup`);
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  });

  test("a restart resumes the stage: no second enrollment, the choice and the preferences are kept", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner);
    const key = (await page.locator(".manual-key").innerText()).replaceAll(/\s/g, "");
    const secret = secretOf(`otpauth://totp/x?secret=${key}`);
    await page.getByLabel(text(setup, "enrollment.codeLabel")).fill(await codeOf(secret));
    await page.getByRole("button", { name: text(setup, "enrollment.submit") }).click();
    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await expect(heading(page)).toHaveText(text(setup, "data.heading"));

    // Restart 1: the stage is the starting data, the enrollment is not asked again.
    await owner.restart(() => execute(owner.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10"));
    await page.reload();
    await expect(heading(page)).toHaveText(text(setup, "data.heading"));
    await page.getByRole("button", { name: text(setup, "signOut") }).click();
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await codeOf(secret));
    await expect(heading(page)).toHaveText(text(setup, "data.heading"));
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).click();
    await expect(heading(page)).toHaveText(text(setup, "preferences.heading"));

    // Restart 2: the choice is kept, the preferences are still to be saved.
    await owner.restart(() => execute(owner.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10"));
    await page.reload();
    await expect(heading(page)).toHaveText(text(setup, "preferences.heading"));
    await page.getByLabel(text(setup, "preferences.timezoneLabel")).fill("America/New_York");
    await page.getByLabel("Polski").check();
    await page.getByRole("button", { name: text(setup, "preferences.save") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);

    // Restart 3: a new sign-in goes straight to the private screen in the saved language.
    await owner.restart(() => execute(owner.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10"));
    await page.getByRole("button", { name: text(plCommon, "main.signOut") }).click();
    await page.getByRole("button", { name: text(locale("pl", "auth"), "language.en") }).click();
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await codeOf(secret));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(plCommon, "main.title"));
    const saved = await page.request.get(`${owner.baseUrl}/api/v1/setup/preferences`);
    expect(await saved.json()).toEqual({ preferences: { timezone: "America/New_York", locale: "pl" }, stage: "complete" });
    const status = await page.request.get(`${owner.baseUrl}/api/v1/setup/status`);
    expect(await status.json()).toMatchObject({ dataChoice: "empty", stage: "complete", nextAction: "ready" });
  });

  test("preferences not saved yet keep the private screen closed after the second factor", async ({ page, ownerServer }) => {
    const owner = await ownerServer("preferences_unsaved");
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(heading(page)).toHaveText(text(setup, "preferences.heading"));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  });

  test("the choice of the data is asked again harmlessly after a lost answer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("data_unchosen");
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(heading(page)).toHaveText(text(setup, "data.heading"));
    await page.route("**/api/v1/setup/choose-empty", (route) => route.abort("connectionreset"));
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await page.unroute("**/api/v1/setup/choose-empty");
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).click();
    await expect(heading(page)).toHaveText(text(setup, "preferences.heading"));
  });
});

test.describe("signing out", () => {
  test("ends the session in the other tabs at once, empties their private state and kills the old cookie", async ({ page, context, ownerServer, playwright }) => {
    const owner = await ownerServer("ready");
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    const other = await context.newPage();
    await other.goto(`${owner.baseUrl}/main`);
    await expect(other.getByRole("heading", { level: 1 })).toHaveText(text(common, "main.title"));
    const oldCookies = (await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");

    await page.getByRole("button", { name: text(common, "main.signOut") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    // The other tab was never reloaded or touched, and still it leaves the private screen.
    await expect(other).toHaveURL(`${owner.baseUrl}/login`);
    await expect(other.getByRole("heading", { name: text(common, "main.title") })).toHaveCount(0);
    await other.goBack();
    await expect(other).toHaveURL(`${owner.baseUrl}/login`);

    // The cookie of the ended session opens nothing.
    const stale = await playwright.request.newContext({ baseURL: owner.baseUrl, extraHTTPHeaders: { cookie: oldCookies } });
    expect((await stale.get("/api/v1/identity/status")).status()).toBeLessThan(500);
    const status = await (await stale.get("/api/v1/identity/status")).json();
    expect(status).toMatchObject({ nextAction: "login" });
    expect((await stale.get("/api/v1/setup/preferences")).status()).toBe(401);
    await stale.dispose();
  });

  test("a tab whose session ended elsewhere is sent to the sign-in by the next request, with no broadcast needed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signIn(page, owner);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await page.evaluate("window.BroadcastChannel = undefined");
    execute(owner.instance, "DELETE FROM session");
    await page.reload();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });
});

test.describe("Polish", () => {
  test.use({ locale: "pl-PL" });

  test("the data and preferences steps are translated and accessible", async ({ page, ownerServer }) => {
    const owner = await ownerServer("data_unchosen");
    await signIn(page, owner, locale("pl", "auth"));
    await page.getByLabel(text(locale("pl", "auth"), "mfa.codeLabel")).fill(await owner.code(1));
    await expect(heading(page)).toHaveText(text(plSetup, "data.heading"));
    await expectNoViolations(page);
    await page.getByRole("button", { name: text(plSetup, "data.chooseEmpty") }).click();
    await expect(heading(page)).toHaveText(text(plSetup, "preferences.heading"));
    await expectNoViolations(page);
  });
});
