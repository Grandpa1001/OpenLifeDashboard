// D42.3 — the whole of the Settings walked by the owner with the keyboard alone (Scope §4, §5.9), on a fresh
// installation: from the bar into Account, Style and Application, one change on each page saved from the
// keyboard, the same change seen where it takes effect, and axe on every page.
// AC2: the path crosses the three pages through the links of the frame; each page is reachable and usable
//      by Tab, the arrows, Enter and Space; the changes are stored by the server; axe finds nothing.
import type { Page } from "@playwright/test";
import { settingListSchema, SETTINGS_PATH } from "@openlife/contracts/http/settings";
import { SCREENS_PATH, screenDesignPath, screenSchema } from "@openlife/contracts/http/screens";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

const common = locale("en");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 900 } });

const sections = (page: Page) => page.getByRole("navigation", { name: text(settings, "navigation") });
const savedNotice = (page: Page) => page.getByText(text(settings, "saved"), { exact: true });

/** Focus a control and press Enter: the way a keyboard user follows a link. */
async function follow(page: Page, link: ReturnType<Page["getByRole"]>): Promise<void> {
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
}

async function makeDashboard(page: Page, owner: BrowserOwner): Promise<string> {
  const headers = { Origin: owner.baseUrl };
  const created = await page.request.post(`${owner.baseUrl}${SCREENS_PATH}`, { data: { name: "Pulpit" }, headers });
  const screenId = ((await created.json()) as { id: string }).id;
  const saved = await page.request.put(`${owner.baseUrl}${screenDesignPath(screenId)}`, { data: { name: "Pulpit", theme: "dark", accent: "blue", widgets: [] }, headers });
  expect(saved.status()).toBe(200);
  return screenId;
}

test.describe("D42.3-AC2 the owner walks the three pages of the Settings with the keyboard", () => {
  test("Account, Style and Application are reached through the frame, used from the keyboard, saved, and free of axe violations", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const screenId = await makeDashboard(page, owner);

    // From the bar into the Settings.
    await page.goto(`${owner.baseUrl}/screens`);
    await follow(page, page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.settings") }));
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/account`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settings, "title"));
    await expect(sections(page).getByRole("link")).toHaveCount(5);

    // Account: the zone is typed, Tab leaves the field for the language, Enter saves the form.
    const zone = page.getByLabel(text(settings, "account.timezoneLabel"), { exact: true });
    await zone.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Asia/Tokyo");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("English", { exact: true })).toBeFocused();
    await expectNoViolations(page);
    await zone.focus();
    await page.keyboard.press("Enter");
    await expect(savedNotice(page)).toBeVisible();

    // Style: an arrow key chooses the green accent, Space presses the save button, the screen wears it.
    await follow(page, sections(page).getByRole("link", { name: text(settings, "tabs.style") }));
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/style`);
    await expect(sections(page).getByRole("link", { name: text(settings, "tabs.style") })).toHaveAttribute("aria-current", "page");
    const accents = page.getByRole("group", { name: text(settings, "style.accentLegend") });
    await accents.getByRole("radio", { checked: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(accents.getByRole("radio", { name: text(settings, "style.accents.green") })).toBeChecked();
    await expectNoViolations(page);
    const saveAccent = page.getByRole("button", { name: text(settings, "style.save"), exact: true });
    await saveAccent.focus();
    await page.keyboard.press("Space");
    await expect(savedNotice(page)).toBeVisible();
    const screen = screenSchema.parse(await (await page.request.get(`${owner.baseUrl}${SCREENS_PATH}/${screenId}`)).json());
    expect(screen.accent).toBe("green");

    // Application: a limit is typed, the save button is pressed with Enter, the server has the value.
    await follow(page, sections(page).getByRole("link", { name: text(settings, "tabs.app") }));
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/app`);
    await expect(sections(page).getByRole("link", { name: text(settings, "tabs.app") })).toHaveAttribute("aria-current", "page");
    const limit = page.locator('[data-option="limits.registries"] input');
    await limit.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("150");
    await expectNoViolations(page);
    const saveOptions = page.getByRole("button", { name: text(settings, "app.options.save"), exact: true });
    await saveOptions.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(text(settings, "app.options.saved"))).toBeVisible();
    const stored = settingListSchema.parse(await (await page.request.get(`${owner.baseUrl}${SETTINGS_PATH}`)).json()).settings;
    expect(stored.find((setting) => setting.key === "limits.registries")?.value).toBe(150);

    // The way back: the links of the frame lead to the first page again and the zone is there as saved.
    await follow(page, sections(page).getByRole("link", { name: text(settings, "tabs.account") }));
    await expect(page.getByLabel(text(settings, "account.timezoneLabel"), { exact: true })).toHaveValue("Asia/Tokyo");
  });
});
