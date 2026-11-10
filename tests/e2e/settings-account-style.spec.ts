// D42.1 — the settings in a real browser (Scope §4, §5.9): the way in from the bar, the Account page (the
// time zone and the language) and the Style page (the accent of the dashboard), on a fresh installation.
// AC1: the bar leads to the settings and the sections are links of one frame; the language changes the
//      interface at once; an unknown zone is told at its field with everything typed kept; a new zone
//      moves the clock of the owner.
// AC2: the accent chosen in Style is on the dashboard after the save and the preview card wears it before;
//      with no dashboard the page says where to make it; axe on both pages.
import type { Page } from "@playwright/test";
import { SCREENS_PATH, screenDesignPath } from "@openlife/contracts/http/screens";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, openApp, signInFully } from "./owner-session.ts";

const common = locale("en");
const settingsPl = locale("pl", "settings");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 800 } });

const GREEN = "#3FB984";
const accentOn = (page: Page): Promise<string> => page.evaluate('document.documentElement.style.getPropertyValue("--color-accent")');
/** The page's own function, named for the types: the tests of this project compile without the types of the DOM. */
declare function getComputedStyle(element: unknown): { getPropertyValue: (name: string) => string };
const previewAccent = (page: Page): Promise<string> => page.getByRole("group", { name: text(settings, "style.previewLabel") }).evaluate((element) => getComputedStyle(element).getPropertyValue("--color-accent").trim());
const zone = (page: Page) => page.getByLabel(text(settings, "account.timezoneLabel"), { exact: true });

async function toSettings(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/screens`);
  await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.settings") }).click();
}

test.describe("D42.1-AC1 the way in and the Account page", () => {
  test("the bar leads to Account, the sections are links of one frame, the language changes the interface at once, a wrong zone is told at the field", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toSettings(page, owner.baseUrl);
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/account`);
    const sections = page.getByRole("navigation", { name: text(settings, "navigation") });
    await expect(sections.getByRole("link", { name: text(settings, "tabs.account") })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settings, "title"));
    await expectNoViolations(page);

    // An unknown zone: refused at its field, nothing typed is lost, nothing is saved.
    await zone(page).fill("Mars/Olympus");
    await expect(page.getByText(text(settings, "dirty"))).toBeVisible();
    await page.getByRole("button", { name: text(settings, "account.save"), exact: true }).click();
    await expect(page.getByText(text(settings, "account.timezoneInvalid"))).toBeVisible();
    await expect(zone(page)).toHaveValue("Mars/Olympus");
    await expect(zone(page)).toHaveAttribute("aria-invalid", "true");

    // The language: Polish at once, without a reload.
    await zone(page).fill("Europe/Warsaw");
    await page.getByLabel("Polski").check();
    await page.getByRole("button", { name: text(settings, "account.save"), exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settingsPl, "title"));
    await expect(page.getByText(text(settingsPl, "saved"), { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");

    await page.getByRole("navigation", { name: text(settingsPl, "navigation") }).getByRole("link", { name: text(settingsPl, "tabs.style") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/style`);
    await expect(page.getByRole("navigation", { name: text(settingsPl, "navigation") }).getByRole("link", { name: text(settingsPl, "tabs.style") })).toHaveAttribute("aria-current", "page");
  });

  test("a new zone moves the clock of the owner on the dashboard", async ({ page, ownerServer }) => {
    const moment = new Date("2026-03-29T00:30:00Z");
    await page.clock.install({ time: new Date(moment.getTime() + 250) });
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const headers = { Origin: owner.baseUrl };
    const created = await page.request.post(`${owner.baseUrl}${SCREENS_PATH}`, { data: { name: "Zegar" }, headers });
    const screenId = ((await created.json()) as { id: string }).id;
    const clock = { id: "019a0000-0000-7000-8000-0000000042a1", type: "clock", config: { v: 1, timezone: "owner", label: "Dom", format: "24h", showSeconds: false, showDate: false }, layout: { phone: { x: 0, y: 0, w: 1, h: 3 }, tablet: { x: 0, y: 0, w: 4, h: 3 }, desktop: { x: 0, y: 0, w: 4, h: 3 } }, bindings: [] };
    expect((await page.request.put(`${owner.baseUrl}${screenDesignPath(screenId)}`, { data: { name: "Zegar", theme: "dark", accent: "blue", widgets: [clock] }, headers })).status()).toBe(200);

    await page.goto(`${owner.baseUrl}/`);
    // The zone of the first setup is that of the browser's: read it, then move the owner to Tokyo.
    await openApp(page, common);
    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.settings") }).click();
    await zone(page).fill("Asia/Tokyo");
    await page.getByRole("button", { name: text(settings, "account.save"), exact: true }).click();
    await expect(page.getByText(text(settings, "saved"), { exact: true })).toBeVisible();

    await page.goto(`${owner.baseUrl}/`);
    // 00:30 UTC is 09:30 in Tokyo.
    await expect(page.getByRole("region", { name: "Clock: Dom" }).locator("time")).toHaveText("09:30");
  });
});

test.describe("D42.1-AC2 the Style page", () => {
  test("the preview card wears the chosen accent before the save, the dashboard wears it after, and the page is accessible", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000042b1", title: "Moje", layout: { phone: { x: 0, y: 0, w: 1, h: 6 }, tablet: { x: 0, y: 0, w: 4, h: 6 }, desktop: { x: 0, y: 0, w: 4, h: 6 } } }]);
    await page.goto(`${owner.baseUrl}/settings/style`);
    await expect(page.getByRole("group", { name: text(settings, "style.previewLabel") })).toBeVisible();
    await expect(page.getByLabel(text(settings, "style.accents.blue"))).toBeChecked();
    await expectNoViolations(page);

    await page.getByLabel(text(settings, "style.accents.green")).check();
    await expect.poll(() => previewAccent(page)).toBe(GREEN);
    // The page itself keeps its accent until the save.
    expect(await accentOn(page)).not.toBe(GREEN);
    await expect(page.getByText(text(settings, "dirty"))).toBeVisible();
    await page.getByRole("button", { name: text(settings, "style.save"), exact: true }).click();
    await expect(page.getByText(text(settings, "saved"), { exact: true })).toBeVisible();

    await page.goto(`${owner.baseUrl}/`);
    await expect.poll(() => accentOn(page)).toBe(GREEN);
    await page.goto(`${owner.baseUrl}/settings/style`);
    await expect(page.getByLabel(text(settings, "style.accents.green"))).toBeChecked();
  });

  test("with no dashboard the page says where to make it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.goto(`${owner.baseUrl}/settings/style`);
    await expect(page.getByText(text(settings, "style.noScreen"))).toBeVisible();
    await expect(page.getByRole("link", { name: text(settings, "style.openDesigner") })).toHaveAttribute("href", "/designer");
    await expectNoViolations(page);
  });
});
