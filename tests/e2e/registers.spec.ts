// D16.1 — the list of registries in a real browser, on the built SPA and server (Scope §5.5). The
// registries are made through the API with the owner's own session, as the form of D16.2 will;
// the server's answer is the only source of what the page shows.
// AC1: an empty list says so, a registry shows as a card with its name, symbol and number of
//      columns, and a name is text, never markup.
// AC2: every state before the gate leads where the guard sends it, a failing server shows the
//      alert with its reference code and "try again" works, and a session that ended meanwhile
//      leads to the sign-in.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const common = locale("en");
const errors = locale("en", "errors");
const registers = locale("en", "registers");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The owner past the password and the second factor, on the private screen. */
async function signInFully(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page).toHaveURL(`${owner.baseUrl}/main`);
}

/** A registry made with the session of the page, exactly as a client would. */
async function createRegistry(page: Page, owner: BrowserOwner, definition: { symbol: string; displayName: string; columns: unknown[] }): Promise<void> {
  const reply = await page.request.post(`${owner.baseUrl}${REGISTRIES_PATH}`, { data: definition, headers: { Origin: owner.baseUrl } });
  expect(reply.status()).toBe(201);
}

const column = (symbol: string, type = "text") => ({ symbol, displayName: symbol, type });

test.describe("D16.1-AC1 the list of registries", () => {
  test("from the private screen to an empty list, then a card with the name, the symbol and the number of columns", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.getByRole("link", { name: text(common, "main.registers") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(registers, "title"));
    await expect(page.getByText(text(registers, "list.empty"))).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await expectNoViolations(page);

    await createRegistry(page, owner, { symbol: "ksiazki", displayName: "Książki", columns: ["tytul", "autor", "strony", "cena", "data", "kiedy", "pora", "tak", "status"].map((symbol) => column(symbol)) });
    await page.reload();
    const card = page.getByRole("listitem");
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("heading", { level: 3 })).toHaveText("Książki");
    await expect(card).toContainText("ksiazki");
    await expect(card).toContainText("9 columns");
    await expectNoViolations(page);

    await createRegistry(page, owner, { symbol: "waga", displayName: "Waga", columns: [column("kg", "number")] });
    await page.reload();
    await expect(page.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("listitem").nth(1)).toContainText("1 column");
    // Back to the private screen by the link of the page.
    await page.getByRole("link", { name: text(common, "main.title") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  });

  test("a name is text: markup in it is shown as it is and runs nothing", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const hostile = `<img src=x onerror="window.__ran=1"><b>bold</b>`;
    await createRegistry(page, owner, { symbol: "xss", displayName: hostile.slice(0, 80), columns: [column("a")] });
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("heading", { level: 3 })).toHaveText(hostile.slice(0, 80));
    expect(await page.locator("main img, main b").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, "__ran"))).toBeUndefined();
  });
});

test.describe("D16.1-AC2 the gate, a failing server and an ended session", () => {
  test("without a session the page leads to the sign-in; a password session leads to the second factor", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
    await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: text(auth, "login.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await expect(page.getByRole("heading", { name: text(registers, "title") })).toHaveCount(0);
  });

  test("a connection that fails shows the alert and 'try again' works; a server error shows its reference code", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.route("**/api/v1/registries", (route) => route.abort("connectionreset"));
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await expect(page.getByText(text(registers, "list.empty"))).toHaveCount(0);
    await expectNoViolations(page);

    await page.unroute("**/api/v1/registries");
    await page.route("**/api/v1/registries", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "SQLSTATE[23000] secret", details: null, requestId: "req-list-1" }) }));
    await page.getByRole("button", { name: text(registers, "list.retry") }).click();
    await expect(page.getByRole("alert")).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(page.getByRole("alert")).toContainText("req-list-1");
    expect(await page.content()).not.toContain("SQLSTATE");

    await page.unroute("**/api/v1/registries");
    await page.getByRole("button", { name: text(registers, "list.retry") }).click();
    await expect(page.getByText(text(registers, "list.empty"))).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("an answer that does not match the contract is not believed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.route("**/api/v1/registries", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ registries: [{ id: 1 }] }) }));
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("alert")).toContainText(text(errors, "INVALID_RESPONSE"));
    await expect(page.getByRole("listitem")).toHaveCount(0);
  });

  test("a session that ended while the page was open leads to the sign-in when the page asks again", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.route("**/api/v1/registries", (route) => route.abort("connectionreset"));
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    // The server no longer knows the session (the browser sends no cookie); the next ask is a 401 and the guard moves the page.
    await context.clearCookies();
    await page.unroute("**/api/v1/registries");
    await page.getByRole("button", { name: text(registers, "list.retry") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
  });
});
