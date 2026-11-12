// D43.8 — the protection of the account from the Security page in a real browser (Scope §5.9; Architektura §9.6):
// the password, the recovery codes and the second factor itself, on a fresh installation.
// AC1: the password is changed from the page (a mismatch and a short one are told before anything is sent, a wrong
//      current one at its field, the right one ends the other sessions and the old password); new recovery codes
//      are shown once, the old ones stop working, the new ones work, and the batch is acknowledged on the page.
// AC2: setting TOTP up again leads to the enrollment; turning the factor off needs the tick under the warning,
//      and afterwards the password is the proof (the dialog of the password is not opened here: the proof given to
//      turn the factor off is fresh for five minutes, and HTTP D43.5 covers the dialog of the password); the sections work from the keyboard and are
//      free of axe violations.
import type { APIRequestContext, Page } from "@playwright/test";
import { IDENTITY_STATUS_PATH } from "@openlife/contracts/http/identity";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations } from "./owner-session.ts";

const auth = locale("en", "auth");
const setup = locale("en", "setup");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1400 } });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));
const section = (page: Page, key: string) => page.getByRole("region", { name: text(settings, key) });
const NEW_PASSWORD = "another long pass phrase 🔑";

/** In by the password and a recovery code: the data are open, the TOTP step of this time window is free for the proof. */
async function signInWithRecoveryCode(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByRole("button", { name: text(auth, "mfa.useRecovery") }).click();
  await page.getByLabel(text(auth, "mfa.recoveryLabel"), { exact: true }).fill(owner.recoveryCodes[0] ?? "");
  await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/`);
}

async function toSecurity(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.security") }).click();
  await expect(page).toHaveURL(`${baseUrl}/settings/security`);
}

/** Answers the dialog of the proof with the TOTP of this time window. */
async function proveWithTotp(page: Page, owner: BrowserOwner): Promise<void> {
  const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(text(settings, "security.stepUp.codeLabel")).fill(await owner.code(1));
  await dialog.getByRole("button", { name: text(settings, "security.stepUp.confirm") }).click();
  await expect(dialog).toBeHidden();
}

async function client(playwright: { request: { newContext: (options: { baseURL: string; extraHTTPHeaders: Record<string, string> }) => Promise<APIRequestContext> } }, owner: BrowserOwner): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: owner.baseUrl, extraHTTPHeaders: { Origin: owner.baseUrl } });
}

const signIn = async (api: APIRequestContext, owner: BrowserOwner, password: string): Promise<number> => (await api.post("/api/auth/sign-in/email", { data: { email: owner.email, password } })).status();
const stillSignedIn = async (api: APIRequestContext): Promise<boolean> => ((await (await api.get(IDENTITY_STATUS_PATH)).json()) as { authenticated: boolean }).authenticated;

test.describe("D43.8-AC1 the password and the recovery codes", () => {
  test("a mismatch and a short password are told before anything is sent, a wrong current one at its field, and the right change ends the old password and the other sessions", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    const other = await client(playwright, owner);
    expect(await signIn(other, owner, owner.password)).toBe(200);
    await toSecurity(page, owner.baseUrl);
    const password = section(page, "security.password.heading");
    const submit = password.getByRole("button", { name: text(settings, "security.password.submit") });

    // What is wrong with the form is told at the fields and nothing is sent: no dialog opens.
    await submit.click();
    await expect(password.getByText(text(settings, "security.password.currentMissing"))).toBeVisible();
    await password.getByLabel(text(settings, "security.password.current"), { exact: true }).fill("a wrong current pass phrase");
    await password.getByLabel(text(settings, "security.password.new"), { exact: true }).fill("short");
    await submit.click();
    await expect(password.getByText(say("security.password.tooShort", { min: 12 }))).toBeVisible();
    await password.getByLabel(text(settings, "security.password.new"), { exact: true }).fill(NEW_PASSWORD);
    await password.getByLabel(text(settings, "security.password.repeat"), { exact: true }).fill(`${NEW_PASSWORD}!`);
    await submit.click();
    await expect(password.getByText(text(settings, "security.password.mismatch"))).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The proof is asked for; then the wrong current password is told at its field and everything typed stays.
    await password.getByLabel(text(settings, "security.password.repeat"), { exact: true }).fill(NEW_PASSWORD);
    await submit.click();
    await proveWithTotp(page, owner);
    await expect(password.getByText(text(settings, "security.password.currentWrong"))).toBeVisible();
    await expect(password.getByLabel(text(settings, "security.password.new"), { exact: true })).toHaveValue(NEW_PASSWORD);

    // The right current password changes it, with no second proof: the session stands on the one just given.
    await password.getByLabel(text(settings, "security.password.current"), { exact: true }).fill(owner.password);
    await submit.click();
    await expect(password.getByText(text(settings, "security.password.changed"))).toBeVisible();
    await expect(password.getByLabel(text(settings, "security.password.current"), { exact: true })).toHaveValue("");
    await expect(password.getByLabel(text(settings, "security.password.new"), { exact: true })).toHaveValue("");
    expect(await stillSignedIn(other)).toBe(false);
    expect(((await (await page.request.get(`${owner.baseUrl}${IDENTITY_STATUS_PATH}`)).json()) as { authenticated: boolean }).authenticated).toBe(true);
    const fresh = await client(playwright, owner);
    expect(await signIn(fresh, owner, owner.password)).not.toBe(200);
    expect(await signIn(fresh, owner, NEW_PASSWORD)).toBe(200);
  });

  test("new recovery codes are shown once and acknowledged on the page, the old codes stop working and a new one signs in", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    await toSecurity(page, owner.baseUrl);
    const recovery = section(page, "security.recovery.heading");
    // One of the ten was used to sign in.
    await expect(recovery.getByText(say("security.recovery.remaining_other", { count: 9 }))).toBeVisible();

    await recovery.getByRole("button", { name: text(settings, "security.recovery.generate") }).click();
    await proveWithTotp(page, owner);
    const codes = recovery.getByRole("list", { name: text(settings, "security.recovery.listLabel") }).getByRole("listitem");
    await expect(codes).toHaveCount(10);
    const fresh = await codes.allInnerTexts();
    // The batch is not acknowledged until the owner says the codes are saved.
    const next = recovery.getByRole("button", { name: text(settings, "security.recovery.continue") });
    await expect(next).toBeDisabled();
    await recovery.getByLabel(text(settings, "security.recovery.saved")).check();
    await next.click();
    await expect(recovery.getByText(text(settings, "security.recovery.acknowledged"))).toBeVisible();
    await expect(recovery.getByText(say("security.recovery.remaining_other", { count: 10 }))).toBeVisible();
    // The codes are not on the page any more.
    await expect(recovery.getByRole("listitem")).toHaveCount(0);

    // An old code no longer signs in; a new one does.
    for (const [code, expected] of [[owner.recoveryCodes[1] ?? "", false], [fresh[0] ?? "", true]] as const) {
      const api = await client(playwright, owner);
      expect(await signIn(api, owner, owner.password)).toBe(200);
      expect((await api.post("/api/v1/mfa/verify", { data: { recoveryCode: code } })).status() === 200).toBe(expected);
    }
  });
});

test.describe("D43.8-AC2 the second factor", () => {
  test("setting TOTP up again leads this session to the enrollment", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    await toSecurity(page, owner.baseUrl);
    await section(page, "security.factor.heading").getByRole("button", { name: text(settings, "security.factor.restart") }).click();
    await proveWithTotp(page, owner);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { name: text(setup, "enrollment.heading") })).toBeVisible();
  });

  test("turning the factor off needs the tick under the warning, and afterwards the password is the proof", async ({ page, playwright, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    const other = await client(playwright, owner);
    expect(await signIn(other, owner, owner.password)).toBe(200);
    expect((await other.post("/api/v1/mfa/verify", { data: { recoveryCode: owner.recoveryCodes[1] ?? "" } })).status()).toBe(200);
    await toSecurity(page, owner.baseUrl);
    const factor = section(page, "security.factor.heading");
    const turnOff = factor.getByRole("button", { name: text(settings, "security.factor.turnOff") });
    await expect(factor.getByText(text(settings, "security.factor.offWarning"))).toBeVisible();
    await expect(turnOff).toBeDisabled();
    await factor.getByLabel(text(settings, "security.factor.offRisk")).check();
    await turnOff.click();
    await proveWithTotp(page, owner);
    await expect(factor.getByText(text(settings, "security.factor.turnedOff"))).toBeVisible();
    await expect(factor.getByText(text(settings, "security.factor.off"), { exact: true })).toBeVisible();
    expect(await stillSignedIn(other)).toBe(false);
    await expect(section(page, "security.recovery.heading").getByText(text(settings, "security.recovery.unavailable"))).toBeVisible();

    // The password is now the proof, and the one given to turn the factor off is still fresh: the next sensitive action needs no dialog.
    const third = await client(playwright, owner);
    expect(await signIn(third, owner, owner.password)).toBe(200);
    await page.reload();
    await section(page, "security.sessions.heading").getByRole("button", { name: text(settings, "security.sessions.endOthers") }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(section(page, "security.sessions.heading").getByText(say("security.sessions.ended_one", { count: 1 }))).toBeVisible();
    expect(await stillSignedIn(third)).toBe(false);
  });

  test("the sections work from the keyboard and are free of axe violations", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInWithRecoveryCode(page, owner);
    await toSecurity(page, owner.baseUrl);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settings, "title"));
    await expectNoViolations(page);

    // The tick and the button are reached and used from the keyboard; the dialog takes the focus.
    const factor = section(page, "security.factor.heading");
    const tick = factor.getByLabel(text(settings, "security.factor.offRisk"));
    await tick.focus();
    await page.keyboard.press("Space");
    await expect(tick).toBeChecked();
    const turnOff = factor.getByRole("button", { name: text(settings, "security.factor.turnOff") });
    await expect(turnOff).toBeEnabled();
    await turnOff.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: text(settings, "security.stepUp.codeHeading") });
    await expect(dialog.getByLabel(text(settings, "security.stepUp.codeLabel"))).toBeFocused();
    await expectNoViolations(page);
    await page.keyboard.type(await owner.code(1));
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(factor.getByText(text(settings, "security.factor.turnedOff"))).toBeVisible();
    await expectNoViolations(page);
  });
});
