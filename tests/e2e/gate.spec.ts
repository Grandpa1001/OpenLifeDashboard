// D12.1-AC2 — the private screens stay closed to every state that is not theirs, and errors reach
// the owner only as translated codes (Architektura §7.6, §9.7). Real browser, built app and server;
// the server's nextAction is the only authority the client follows.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const errors = locale("en", "errors");
const setup = locale("en", "setup");
const common = locale("en");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
}

const path = (page: Page): string => new URL(page.url()).pathname;

test.describe("a screen is open only to its own state", () => {
  test("without a session: the private screens lead to the sign-in, the second factor too", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    for (const route of ["/main", "/mfa", "/login"]) {
      await page.goto(`${owner.baseUrl}${route}`);
      await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    }
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(auth, "login.title"));
  });

  test("a forged or foreign session cookie opens nothing", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await context.addCookies([
      { name: "openlife-000000000000.session_token", value: "forged.value", url: owner.baseUrl },
      { name: `openlife-${owner.instance.instanceId.replaceAll("-", "").slice(0, 12)}.session_token`, value: "forged.AAAA", url: owner.baseUrl },
    ]);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });

  test("a password session is not enough: /main leads to the second factor, and the second factor opens it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.goto(`${owner.baseUrl}/login`);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    // Once fully signed in, the sign-in and the second factor are not for this state any more.
    await page.goto(`${owner.baseUrl}/login`);
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await page.goto(`${owner.baseUrl}/mfa`);
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  });

  test("an owner who has no authenticator yet: the sign-in leads to the setup, and /main stays closed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");
    await page.goto(`${owner.baseUrl}/login`);
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "enrollment.heading"));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expectNoViolations(page);
  });

  test("recovery codes not yet acknowledged and not visible: the setup offers a new set, the data stay closed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("awaiting_ack");
    await page.goto(`${owner.baseUrl}/login`);
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "recovery.lostHeading"));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
  });

  test("the gate passed but the data not chosen: after the second factor the setup names the data step", async ({ page, ownerServer }) => {
    const owner = await ownerServer("data_unchosen");
    await page.goto(`${owner.baseUrl}/login`);
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "data.heading"));
    await page.getByRole("button", { name: text(setup, "signOut") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });

  test("no owner yet: every screen leads to the setup, which says how to create one and offers no form", async ({ page, server }) => {
    for (const route of ["/login", "/mfa", "/main", "/setup"]) {
      await page.goto(route);
      await expect(page).toHaveURL(`${server.baseUrl}/setup`);
    }
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "ownerMissing.heading"));
    await expect(page.getByText(text(setup, "ownerMissing.description"))).toBeVisible();
    await expect(page.locator("form, input")).toHaveCount(0);
    await expectNoViolations(page);
  });
});

test.describe("when the server cannot be asked or answers badly", () => {
  test("the private screen stays closed with the reason, and asking again goes on", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.route("**/api/v1/identity/status", (route) => route.abort("connectionreset"));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(common, "gate.unavailable.heading"));
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await expect(page.getByRole("heading", { name: text(common, "main.title") })).toHaveCount(0);
    await expectNoViolations(page);
    await page.unroute("**/api/v1/identity/status");
    await page.getByRole("button", { name: text(common, "gate.unavailable.retry") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });

  test("an answer that does not match the contract is not believed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.route("**/api/v1/identity/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, nextAction: "admin" }) }));
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page.getByRole("alert")).toContainText(text(errors, "INVALID_RESPONSE"));
    await expect(page.getByRole("heading", { name: text(common, "main.title") })).toHaveCount(0);
  });

  test("an error is shown by its code only: the server's words, SQL and markup never reach the page", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    const leak = "SQLSTATE[23000] SELECT secret FROM user <img src=x onerror=alert(1)>";
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL_ERROR", message: leak, details: { sql: leak }, requestId: "req-visible-1" }),
      }),
    );
    await signIn(page, owner.email, owner.password);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(alert).toContainText("req-visible-1");
    expect(await page.content()).not.toContain("SQLSTATE");
    expect(await page.locator("img[src='x']").count()).toBe(0);
    // A code the client does not know gets the general text, not the server's.
    await page.unroute("**/api/auth/sign-in/email");
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({ status: 418, contentType: "application/json", body: JSON.stringify({ code: "TEAPOT", message: leak, details: null, requestId: "req-visible-2" }) }),
    );
    await page.getByRole("button", { name: text(auth, "login.submit") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "UNKNOWN"));
    expect(await page.content()).not.toContain("TEAPOT");
  });

  test("an outage of the sign-in keeps the form, and the retry works", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/login`);
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "AUTH_UNAVAILABLE", message: "x", details: null, requestId: "req-503" }) }),
    );
    await signIn(page, owner.email, owner.password);
    await expect(page.getByRole("alert")).toContainText(text(errors, "AUTH_UNAVAILABLE"));
    await expect(page.getByLabel(text(auth, "login.password"), { exact: true })).toHaveValue(owner.password);
    await page.unroute("**/api/auth/sign-in/email");
    await page.getByRole("button", { name: text(auth, "login.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    expect(path(page)).toBe("/mfa");
  });
});
