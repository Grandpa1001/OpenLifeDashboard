// D12.1-AC1 — sign-in and the second factor in a real browser, on the built app and the built
// server, with an owner made by the real CLI and the setup brought to its stage by the real routes.
// AC1: the password and the TOTP lead by the server's nextAction; 401, 429 and a lost connection
//      have working states and keep the form; the password is sent exactly as typed, lives only in
//      the form and is gone after a success, a refusal, leaving the screen and signing out.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, locale, test, text } from "./fixtures.ts";

const pl = locale("pl", "auth");
const en = locale("en", "auth");
const plErrors = locale("pl", "errors");
const enErrors = locale("en", "errors");
const plCommon = locale("pl");
const enCommon = locale("en");

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

type Texts = Readonly<{ auth: Record<string, unknown>; errors: Record<string, unknown>; common: Record<string, unknown> }>;
const polish: Texts = { auth: pl, errors: plErrors, common: plCommon };
const english: Texts = { auth: en, errors: enErrors, common: enCommon };

const emailField = (page: Page, texts: Texts) => page.getByLabel(text(texts.auth, "login.email"), { exact: true });
const passwordField = (page: Page, texts: Texts) => page.getByLabel(text(texts.auth, "login.password"), { exact: true });
const submitButton = (page: Page, texts: Texts) => page.getByRole("button", { name: text(texts.auth, "login.submit") });
const codeField = (page: Page, texts: Texts) => page.getByLabel(text(texts.auth, "mfa.codeLabel"), { exact: false });

async function signInWith(page: Page, texts: Texts, email: string, password: string): Promise<void> {
  await emailField(page, texts).fill(email);
  await passwordField(page, texts).fill(password);
  await submitButton(page, texts).click();
}

/** Everything the page itself can read of the browser's storage and cookies, as text. */
const readablePageState = (page: Page): Promise<string> =>
  page.evaluate<string>("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie })");

async function storageHolds(page: Page, needle: string): Promise<boolean> {
  return (await readablePageState(page)).includes(needle);
}

test.describe("Polish", () => {
  test.use({ locale: "pl-PL" });

  test("the sign-in screen: Polish, labelled, themed, accessible, with no sign-up and no reset link; the language can be switched", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(pl, "login.title"));
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    await expect(emailField(page, polish)).toBeVisible();
    await expect(passwordField(page, polish)).toHaveAttribute("type", "password");
    await expect(passwordField(page, polish)).toHaveAttribute("autocomplete", "current-password");
    await expect(page.getByRole("link")).toHaveCount(0);
    await expectNoViolations(page);

    await page.getByRole("button", { name: text(pl, "language.en") }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(en, "login.title"));
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("a wrong password and an unknown e-mail say the same; the e-mail stays, the password goes; no hint of which was wrong", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, polish, owner.email, "a wrong password of enough length");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(text(plErrors, "INVALID_CREDENTIALS"));
    await expect(alert).toContainText(text(plErrors, "requestReference").split("{{")[0] ?? "");
    await expect(emailField(page, polish)).toHaveValue(owner.email);
    await expect(passwordField(page, polish)).toHaveValue("");
    await expect(passwordField(page, polish)).toBeFocused();
    await expectNoViolations(page);

    await signInWith(page, polish, "someone-else@example.test", "another wrong password here");
    await expect(page.getByRole("alert")).toContainText(text(plErrors, "INVALID_CREDENTIALS"));
    expect(page.url()).toBe(`${owner.baseUrl}/login`);
  });

  test("five wrong passwords lock the form with the time to wait; the lock outlasts typing a right password", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await signInWith(page, polish, owner.email, "a wrong password of enough length");
      await expect(page.getByRole("alert")).toBeVisible();
    }
    await expect(page.getByRole("alert")).toContainText("15 minut");
    await passwordField(page, polish).fill(owner.password);
    await expect(submitButton(page, polish)).toBeDisabled();
    await expectNoViolations(page);
  });

  test("a lost connection keeps the form as typed; once the connection is back the same form signs in", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await page.route("**/api/auth/sign-in/email", (route) => route.abort("connectionreset"));
    await signInWith(page, polish, owner.email, owner.password);
    await expect(page.getByRole("alert")).toContainText(text(plErrors, "NETWORK"));
    await expect(emailField(page, polish)).toHaveValue(owner.email);
    await expect(passwordField(page, polish)).toHaveValue(owner.password);
    await expect(submitButton(page, polish)).toBeEnabled();

    await page.unroute("**/api/auth/sign-in/email");
    await submitButton(page, polish).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
  });

  test("a screen left while a request is in flight is not changed by its late answer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await page.route("**/api/auth/sign-in/email", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue().catch(() => undefined);
    });
    await signInWith(page, polish, owner.email, owner.password);
    await expect(submitButton(page, polish).or(page.getByRole("button", { name: text(pl, "login.submitting") }))).toBeVisible();
    await page.goto(`${owner.baseUrl}/`);
    await page.waitForTimeout(2200);
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("the password is sent exactly as typed, spaces included, and is nowhere afterwards", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    expect(owner.password).toMatch(/^ .* $/);
    const bodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/auth/sign-in/email")) bodies.push(request.postData() ?? "");
    });
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, polish, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ email: owner.email, password: owner.password });
    expect(page.url()).not.toContain("pass");
    expect(await storageHolds(page, "pass phrase")).toBe(false);
    expect(await page.content()).not.toContain("pass phrase");
  });
});

test.describe("English", () => {
  test.use({ locale: "en-US" });

  test("the second factor: the six digits lead on by themselves, a refused code is dropped and says why", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, english, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(en, "mfa.title"));
    await expect(codeField(page, english)).toHaveAttribute("autocomplete", "one-time-code");
    await expectNoViolations(page);

    await codeField(page, english).fill("000000");
    await expect(page.getByRole("alert")).toContainText(text(enErrors, "MFA_INVALID_CODE"));
    await expect(codeField(page, english)).toHaveValue("");

    // The next time step's code is a fresh proof; typing the last digit is enough.
    await codeField(page, english).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(enCommon, "main.title"));
    expect(await storageHolds(page, owner.password)).toBe(false);
  });

  test("a recovery code opens the screen too, once", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, english, owner.email, owner.password);
    await page.getByRole("button", { name: text(en, "mfa.useRecovery") }).click();
    const recovery = page.getByLabel(text(en, "mfa.recoveryLabel"), { exact: true });
    await recovery.fill((owner.recoveryCodes[0] ?? "").toLowerCase());
    await page.getByRole("button", { name: text(en, "mfa.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  });

  test("remembering the device leaves a trusted-device cookie that the page cannot read; the next sign-in needs no code", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, english, owner.email, owner.password);
    await page.getByLabel(text(en, "mfa.remember")).check();
    await codeField(page, english).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    const cookies = await context.cookies(owner.baseUrl);
    const trusted = cookies.find((cookie) => cookie.name.endsWith(".trusted_device"));
    expect(trusted).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    expect(cookies.find((cookie) => cookie.name.endsWith(".session_token"))).toMatchObject({ httpOnly: true });
    expect((JSON.parse(await readablePageState(page)) as { cookie: string }).cookie).toBe("");

    await page.getByRole("button", { name: text(enCommon, "main.signOut") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await expect(passwordField(page, english)).toHaveValue("");
    await signInWith(page, english, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  });

  test("signing out ends the session: the password field is empty, and the private screen is closed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signInWith(page, english, owner.email, owner.password);
    await codeField(page, english).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await page.getByRole("button", { name: text(enCommon, "main.signOut") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await expect(passwordField(page, english)).toHaveValue("");
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    expect(await storageHolds(page, owner.password)).toBe(false);
  });
});
