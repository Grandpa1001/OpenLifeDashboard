// D33.1 — the screen of the owner under `/`, Pulpity and Właściwości in a real browser (Scope §4, §5.3;
// makiety 01, 24, 30, 31, 49) on Książki of F01 with its table widget.
// AC1: the owner signs in to `/`, `/main` leads there without a trace in the history, the icon is the
//      one control and opens Pulpity; the one row names the screen and its last change, Podgląd and
//      Edycja open `/` and the Designer, Właściwości rename it on the list and in the Designer; 1920 px
//      draws the desktop layout in a 20 px base font.
// AC2: a session on its way through the gate goes on to its step; an empty and an 81-character name are
//      refused at the field without a request, a refused save keeps the window and the text; the bar is
//      on Pulpity and Rejestry, not on `/`; a phone does not scroll sideways, the keyboard opens and
//      closes the window with the focus back, the tablet keeps 44 px targets; axe.
import type { Page } from "@playwright/test";
import { SCREENS_PATH } from "@openlife/contracts/http/screens";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, openApp, signInFully } from "./owner-session.ts";

const common = locale("en");
const designer = locale("en", "designer");
const auth = locale("en", "auth");
const errors = locale("en", "errors");
test.use({ locale: "en-US" });

const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };
const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(designer, key));
const appBar = (page: Page) => page.getByRole("navigation", { name: text(common, "appBar.navigation") });
const sideways = async (page: Page) => (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };

async function booksOnScreen(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000033a1", title: "Moje książki", layout: LAYOUT }], "Mój pulpit");
}

/** Właściwości of the one screen, opened from its row. */
async function openProperties(page: Page) {
  await page.getByRole("button", { name: text(designer, "screens.properties.open") }).click();
  const dialog = page.getByRole("dialog", { name: text(designer, "screens.properties.heading") });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("D33.1-AC1 the screen under / and Pulpity", () => {
  test("the owner signs in to /, /main leads there, the icon opens Pulpity; the row opens / and the Designer, Właściwości rename it; 1920 px is the desktop in 20 px", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    const widget = page.locator("section.widget").filter({ hasText: "Moje książki" });
    await expect(widget).toBeVisible();
    // No bar on the screen: the icon is its one link.
    await expect(appBar(page)).toHaveCount(0);
    await expect(page.locator("main a")).toHaveCount(1);
    await expectNoViolations(page);

    // /main leads to / and leaves no entry of its own: back returns to the page before it.
    await page.goto(`${owner.baseUrl}/registers`);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
    await page.goBack();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);

    await page.goto(`${owner.baseUrl}/`);
    await openApp(page);
    await expect(page).toHaveURL(`${owner.baseUrl}${"/screens"}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(designer, "screens.title"));
    const rows = page.getByRole("row");
    await expect(rows).toHaveCount(2);
    const row = rows.nth(1);
    await expect(row.getByRole("rowheader")).toHaveText("Mój pulpit");
    await expect(row.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
    await expectNoViolations(page);

    await row.getByRole("link", { name: text(designer, "screens.view") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
    await openApp(page);
    await page.getByRole("link", { name: text(designer, "screens.edit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/`);

    // Właściwości: the new name is on the list, in the Designer and in the database of the server.
    await openApp(page);
    const dialog = await openProperties(page);
    await expectNoViolations(page);
    await dialog.getByLabel(text(designer, "screens.properties.name")).fill("  Pulpit domowy  ");
    await dialog.getByRole("button", { name: text(designer, "screens.properties.save") }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("rowheader")).toHaveText("Pulpit domowy");
    await page.reload();
    await expect(page.getByRole("rowheader")).toHaveText("Pulpit domowy");
    await page.getByRole("link", { name: text(designer, "screens.edit") }).click();
    await expect(page.locator(".designer-toolbar .screen-name")).toHaveText("Pulpit domowy");
    // The widget the rename saved with the design is still on the screen.
    await page.goto(`${owner.baseUrl}/`);
    await expect(widget).toBeVisible();

    // A large display: the desktop layout and a base font of 20 px; Pulpity keep the usual size.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "desktop");
    await expect(page.locator("body")).toHaveCSS("font-size", "20px");
    await openApp(page);
    await expect(page.locator("body")).toHaveCSS("font-size", "16px");
  });
});

test.describe("D33.1-AC2 the gate, the name, the bar and the widths", () => {
  test("a session on its way goes to its step from /; a visitor goes to the sign-in", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/`);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
    await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: text(auth, "login.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
    await page.goto(`${owner.baseUrl}/`);
    await expect(page).toHaveURL(`${owner.baseUrl}/mfa`);
  });

  test("an empty and an 81-character name are refused at the field without a request; a refused save keeps the window and the text", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await page.goto(`${owner.baseUrl}/screens`);
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes(SCREENS_PATH)) writes += 1;
    });
    const dialog = await openProperties(page);
    const name = dialog.getByLabel(text(designer, "screens.properties.name"));
    const save = dialog.getByRole("button", { name: text(designer, "screens.properties.save") });

    await name.fill("   ");
    await save.click();
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByText(text(designer, "screens.properties.required"))).toBeVisible();
    await name.fill("x".repeat(81));
    await save.click();
    await expect(dialog.getByText(say("screens.properties.tooLong", { max: 80 }))).toBeVisible();
    expect(writes).toBe(0);
    await expectNoViolations(page);

    // The server cannot be reached: the window stays with what was typed and says why.
    await page.route(`**${SCREENS_PATH}/*/design`, (route) => route.abort("connectionreset"));
    await name.fill("Pulpit z błędem");
    await save.click();
    await expect(dialog.getByRole("alert")).toContainText(text(errors, "NETWORK"));
    await expect(dialog).toBeVisible();
    await expect(name).toHaveValue("Pulpit z błędem");
    await page.unroute(`**${SCREENS_PATH}/*/design`);
    await save.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("rowheader")).toHaveText("Pulpit z błędem");
  });

  test("the bar is on Pulpity and Rejestry and not on /; a phone does not scroll sideways; the keyboard opens and closes Właściwości; the tablet keeps 44 px targets", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await page.goto(`${owner.baseUrl}/screens`);
    await expect(appBar(page).getByRole("link", { name: text(common, "appBar.screens") })).toHaveAttribute("aria-current", "page");
    await appBar(page).getByRole("link", { name: text(common, "appBar.registers") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers`);
    await expect(appBar(page).getByRole("link", { name: text(common, "appBar.registers") })).toHaveAttribute("aria-current", "page");
    // The account opens and closes by the keyboard and gives the focus back.
    const account = page.getByRole("button", { name: text(common, "appBar.account") });
    await account.focus();
    await page.keyboard.press("Enter");
    await expect(account).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(text(common, "appBar.role"))).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(account).toHaveAttribute("aria-expanded", "false");
    await expect(account).toBeFocused();
    await expectNoViolations(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${owner.baseUrl}/screens`);
    await expect(page.getByRole("rowheader")).toHaveText("Mój pulpit");
    const phone = await sideways(page);
    expect(phone.page).toBeLessThanOrEqual(phone.view);
    const properties = page.getByRole("button", { name: text(designer, "screens.properties.open") });
    await properties.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: text(designer, "screens.properties.heading") });
    await expect(dialog.getByLabel(text(designer, "screens.properties.name"))).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(properties).toBeFocused();
    await expect(page.getByRole("rowheader")).toHaveText("Mój pulpit");
    await expectNoViolations(page);
    await page.goto(`${owner.baseUrl}/`);
    const screen = await sideways(page);
    expect(screen.page).toBeLessThanOrEqual(screen.view);

    // The tablet: the icon, the links of the bar and of the row are touch targets of 44 px.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".screen-grid")).toHaveAttribute("data-layout", "tablet");
    const icon = await page.getByRole("link", { name: text(common, "main.openApp") }).boundingBox();
    expect(Math.min(icon!.width, icon!.height)).toBeGreaterThanOrEqual(44);
    await openApp(page);
    for (const target of [appBar(page).getByRole("link").first(), page.getByRole("link", { name: text(designer, "screens.edit") }), properties]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });
});
