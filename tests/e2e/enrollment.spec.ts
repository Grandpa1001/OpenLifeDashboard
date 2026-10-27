// D12.2 — enrolling the second factor in a real browser, on the built app and the built server:
// QR code and key, the confirming code, the recovery codes shown once with an explicit
// acknowledgment, and the safe resume after a reload or a second tab (new code → new set, the
// active secret unchanged). Owner made by the real CLI; the authenticator is the test's own TOTP.
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { codeOf, execute, secretOf } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const errors = locale("en", "errors");
const setup = locale("en", "setup");
const plSetup = locale("pl", "setup");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function signIn(page: Page, baseUrl: string, email: string, password: string): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
}

const codeField = (page: Page, label = "enrollment.codeLabel") => page.getByLabel(text(setup, label));
const recoveryCodesOf = async (page: Page): Promise<string[]> => (await page.getByRole("list", { name: text(setup, "recovery.listLabel") }).getByRole("listitem").allTextContents()).map((code) => code.trim());

/** The secret the page shows as a key, the way a person would type it into an app. */
async function secretShown(page: Page): Promise<Buffer> {
  const key = (await page.locator(".manual-key").innerText()).replaceAll(/\s/g, "");
  return secretOf(`otpauth://totp/x?secret=${key}`);
}

async function confirmWith(page: Page, code: string): Promise<void> {
  await codeField(page).fill(code);
  await page.getByRole("button", { name: text(setup, "enrollment.submit") }).click();
}

async function reissueWith(page: Page, code: string): Promise<void> {
  await codeField(page, "recovery.reissueLabel").fill(code);
  await page.getByRole("button", { name: text(setup, "recovery.reissueSubmit") }).click();
}

/** Everything the page can read of the browser's storage, plus its markup, as text. */
const readable = (page: Page): Promise<string> =>
  page.evaluate<string>("JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, url: location.href })");

async function enrolOnPage(page: Page, owner: { baseUrl: string; email: string; password: string }): Promise<{ secret: Buffer; codes: string[]; keyShown: string }> {
  await signIn(page, owner.baseUrl, owner.email, owner.password);
  await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  const keyShown = (await page.locator(".manual-key").innerText()).trim();
  const secret = await secretShown(page);
  await confirmWith(page, await codeOf(secret));
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.heading"));
  return { secret, codes: await recoveryCodesOf(page), keyShown };
}

test.describe("the authenticator step", () => {
  test("QR code and key are shown, the page is accessible, /main stays closed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "enrollment.heading"));
    const qr = page.getByRole("img", { name: text(setup, "enrollment.qrLabel") });
    await expect(qr).toBeVisible();
    expect(await qr.locator("path").getAttribute("d")).toMatch(/^M\d/);
    await expect(page.locator(".manual-key")).toHaveText(/^[A-Z2-7]{1,4}( [A-Z2-7]{1,4})+$/);
    await expect(page.getByLabel(text(setup, "enrollment.codeLabel"))).toHaveAttribute("autocomplete", "one-time-code");
    await expectNoViolations(page);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  });

  test("a reload returns the same key: there is never a second secret", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    const first = await page.locator(".manual-key").innerText();
    await page.reload();
    await expect(page.locator(".manual-key")).toHaveText(first);
  });

  test("a wrong code says why, clears the field and keeps the step; the right one goes on", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    const secret = await secretShown(page);
    const valid = await Promise.all([-1, 0, 1].map((offset) => codeOf(secret, offset)));
    const wrong = ["000000", "111111"].find((candidate) => !valid.includes(candidate)) ?? "222222";
    await confirmWith(page, wrong);
    await expect(page.getByRole("alert")).toContainText(text(errors, "MFA_INVALID_CODE"));
    await expect(codeField(page)).toHaveValue("");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "enrollment.heading"));
    await confirmWith(page, await codeOf(secret));
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.heading"));
  });

  test("a lost connection keeps the step and the retry works; a lock disables the button", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    const secret = await secretShown(page);
    await page.route("**/api/v1/mfa/enrollment/confirm", (route) => route.abort("connectionreset"));
    await confirmWith(page, await codeOf(secret));
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await expect(page.locator(".manual-key")).toBeVisible();
    await page.unroute("**/api/v1/mfa/enrollment/confirm");
    await page.route("**/api/v1/mfa/enrollment/confirm", (route) =>
      route.fulfill({ status: 429, headers: { "Retry-After": "120" }, contentType: "application/json", body: JSON.stringify({ code: "AUTH_LOCKED", message: "x", details: null, requestId: "req-lock" }) }),
    );
    await confirmWith(page, await codeOf(secret));
    await expect(page.getByRole("alert")).toContainText("2 minutes");
    await codeField(page).fill(await codeOf(secret));
    await expect(page.getByRole("button", { name: text(setup, "enrollment.submit") })).toBeDisabled();
    await page.unroute("**/api/v1/mfa/enrollment/confirm");
  });
});

test.describe("the recovery codes", () => {
  test("shown once, ten of them, and the step cannot be passed without the explicit acknowledgment", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    const { codes } = await enrolOnPage(page, owner);
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    const proceed = page.getByRole("button", { name: text(setup, "recovery.continue") });
    await expect(proceed).toBeDisabled();
    await expectNoViolations(page);
    // The setup moves on only through the server: /main stays closed while the batch is open.
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    // The reload loses the codes: they are not kept anywhere.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    for (const code of codes) expect(await page.content()).not.toContain(code);
  });

  test("acknowledging leads on, and the codes leave the page, the storage and the URL", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    const { codes, secret, keyShown } = await enrolOnPage(page, owner);
    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await expect(page.getByText(text(setup, "pending.setup_data"))).toBeVisible();
    const state = await readable(page);
    for (const code of codes) {
      expect(state).not.toContain(code);
      expect(await page.content()).not.toContain(code);
    }
    expect(state).not.toContain(secret.toString("base64"));
    // Neither the codes, nor the key, nor the link of the app reach the server's log.
    const log = owner.serverOutput();
    for (const code of codes) expect(log).not.toContain(code);
    for (const secretText of [secret.toString("hex"), secret.toString("base64"), keyShown.replaceAll(" ", ""), keyShown, "otpauth://"]) expect(log).not.toContain(secretText);
    // The owner signs in with a recovery code of this batch, which is spent by it.
    await page.getByRole("button", { name: text(setup, "signOut") }).click();
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.getByRole("button", { name: text(auth, "mfa.useRecovery") }).click();
    await page.getByLabel(text(auth, "mfa.recoveryLabel")).fill(codes[0] ?? "");
    await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  });

  test("after a reload the codes are gone: a new code gives a new set, the old set is dead, the secret stays", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    const first = await enrolOnPage(page, owner);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    await expectNoViolations(page);

    // The step that confirmed the enrollment is spent: the app's next code is needed, and the step stays.
    await reissueWith(page, await codeOf(first.secret));
    await expect(page.getByRole("alert")).toContainText(text(errors, "MFA_INVALID_CODE"));
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));

    await reissueWith(page, await codeOf(first.secret, 1));
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.heading"));
    const second = await recoveryCodesOf(page);
    expect(second).toHaveLength(10);
    expect(second.filter((code) => first.codes.includes(code))).toEqual([]);
    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await expect(page.getByText(text(setup, "pending.setup_data"))).toBeVisible();

    // The old set is refused, the new one works, and the secret is still the one the owner enrolled.
    await page.getByRole("button", { name: text(setup, "signOut") }).click();
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    await page.getByRole("button", { name: text(auth, "mfa.useRecovery") }).click();
    await page.getByLabel(text(auth, "mfa.recoveryLabel")).fill(first.codes[0] ?? "");
    await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "MFA_INVALID_CODE"));
    await page.getByLabel(text(auth, "mfa.recoveryLabel")).fill(second[0] ?? "");
    await page.getByRole("button", { name: text(auth, "mfa.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    // The secret is the enrolled one: after the spent steps are set aside, its code opens a session.
    execute(owner.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10");
    await page.getByRole("button", { name: text(setup, "signOut") }).click();
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await codeOf(first.secret));
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  });

  test("a batch replaced in another tab is not acknowledged: the right error, and the step is kept", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("password_only");
    const first = await enrolOnPage(page, owner);
    const other = await context.newPage();
    await other.goto(`${owner.baseUrl}/setup`);
    await expect(other.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    await reissueWith(other, await codeOf(first.secret, 1));
    await expect(other.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.heading"));

    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "RECOVERY_BATCH_CHANGED"));
    // The stale codes leave the screen; the step is still the recovery codes, not an advance.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    await expect(other.getByRole("button", { name: text(setup, "recovery.continue") })).toBeDisabled();
    await other.getByLabel(text(setup, "recovery.saved")).check();
    await other.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await expect(other.getByText(text(setup, "pending.setup_data"))).toBeVisible();
  });

  test("an owner who lost the view in an earlier session sees the lost-codes step first", async ({ page, ownerServer }) => {
    const owner = await ownerServer("awaiting_ack");
    await signIn(page, owner.baseUrl, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    await reissueWith(page, await owner.code(1));
    const codes: Locator = page.getByRole("list", { name: text(setup, "recovery.listLabel") }).getByRole("listitem");
    await expect(codes).toHaveCount(10);
  });
});

test.describe("Polish", () => {
  test.use({ locale: "pl-PL" });

  test("the steps are translated", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await page.goto(`${owner.baseUrl}/login`);
    await page.getByLabel(text(locale("pl", "auth"), "login.email"), { exact: true }).fill(owner.email);
    await page.getByLabel(text(locale("pl", "auth"), "login.password"), { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: text(locale("pl", "auth"), "login.submit") }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(plSetup, "enrollment.heading"));
    await expect(page.getByRole("img", { name: text(plSetup, "enrollment.qrLabel") })).toBeVisible();
    await expectNoViolations(page);
  });
});
