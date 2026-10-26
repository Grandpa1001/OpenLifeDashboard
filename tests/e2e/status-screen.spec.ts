// D08.2-AC1/AC2 — the start screen of the built app in a real browser, against the built server.
// AC1: Polish and English show the ready status of a started server and the unavailable status
//      when it stops or answers 503; checking again recovers; the theme tokens are applied and
//      axe finds no violation in either state.
// AC2: the screen offers no form (it does not pretend to be the setup) and nothing of the
//      installation reaches the page: no host path, no installation key.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, locale, test, text, type RunningServer } from "./fixtures.ts";

const pl = locale("pl");
const en = locale("en");
const HEALTH_PATH = "/api/health";
/** --color-bg of the dark theme (#0F1115). */
const THEME_BACKGROUND = "rgb(15, 17, 21)";

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectNothingOfTheInstallation(page: Page, server: RunningServer): Promise<void> {
  const html = await page.content();
  for (const secret of server.secrets) expect(html.includes(secret), "an installation key in the page").toBe(false);
  expect(html.includes(server.installationDir), "the installation path in the page").toBe(false);
  await expect(page.locator("form, input, select, textarea")).toHaveCount(0);
}

test.describe("Polish", () => {
  test.use({ locale: "pl-PL" });

  test("a started server: ready, in Polish, themed, accessible, nothing of the installation", async ({ page, server }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(pl, "status.title"));
    await expect(page.getByRole("status")).toContainText(text(pl, "status.ready.heading"));
    await expect(page.getByRole("status")).toContainText(text(pl, "status.ready.description"));
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    await expect(page.locator("body")).toHaveCSS("background-color", THEME_BACKGROUND);
    await expectNothingOfTheInstallation(page, server);
    await expectNoViolations(page);
  });

  test("the server stops: checking again shows unavailable, by keyboard", async ({ page, server }) => {
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText(text(pl, "status.ready.heading"));
    await server.stop();
    const recheck = page.getByRole("button", { name: text(pl, "status.recheck") });
    await recheck.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText(text(pl, "status.unavailable.heading"));
    await expect(page.getByRole("status")).toContainText(text(pl, "status.unavailable.description"));
    await expect(recheck).toBeEnabled();
    await expectNothingOfTheInstallation(page, server);
    await expectNoViolations(page);
  });
});

test.describe("English", () => {
  test.use({ locale: "en-US" });

  test("a started server: ready, in English", async ({ page, server }) => {
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText(text(en, "status.ready.heading"));
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expectNothingOfTheInstallation(page, server);
  });

  test("503 from health: unavailable; once ready again, checking again recovers", async ({ page }) => {
    await page.route(HEALTH_PATH, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"status":"unavailable"}' }));
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText(text(en, "status.unavailable.heading"));
    await expectNoViolations(page);
    await page.unroute(HEALTH_PATH);
    await page.getByRole("button", { name: text(en, "status.recheck") }).click();
    await expect(page.getByRole("status")).toContainText(text(en, "status.ready.heading"));
  });

  test("an unknown screen: not found, with the way back", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(en, "notFound.title"));
    await page.getByRole("link", { name: text(en, "notFound.backHome") }).click();
    await expect(page.getByRole("status")).toContainText(text(en, "status.ready.heading"));
  });
});
