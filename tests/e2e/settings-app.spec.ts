// D42.2 — the Application page in a real browser (Scope §5.9; Architektura §14.2–§14.3), on a fresh
// installation: the format of dates and the advanced options of the application.
// AC1: the format of dates changes how the table shows a date and keeps what is stored; two options are
//      saved at once; a wrong draft is told at its field and one the server refuses leaves the form with
//      everything typed and nothing saved.
// AC2: a lower limit of text trims nothing already stored; one option goes back to its default; an option
//      the installation file sets is shown as locked and cannot be reset; one that needs a second factor is
//      frozen with its reason; leaving with unsaved changes asks first; axe.
import type { Page } from "@playwright/test";
import { settingListSchema, SETTINGS_PATH } from "@openlife/contracts/http/settings";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, createRegistry, expectNoViolations, signInFully } from "./owner-session.ts";

const common = locale("en");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 900 } });

const NOTES = { symbol: "notatki", displayName: "Notatki", columns: [{ symbol: "tytul", displayName: "Tytuł", type: "text", required: true }, { symbol: "kiedy", displayName: "Kiedy", type: "date" }] };
const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));
const option = (page: Page, key: string) => page.locator(`[data-option="${key}"]`);
const saveOptions = (page: Page) => page.getByRole("button", { name: text(settings, "app.options.save"), exact: true });
const serverOptions = async (page: Page, owner: BrowserOwner) => settingListSchema.parse(await (await page.request.get(`${owner.baseUrl}${SETTINGS_PATH}`)).json()).settings;

async function toApplication(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.app") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/settings/app`);
}

test.describe("D42.2-AC1 the format of dates and the options saved together", () => {
  test("the format of dates changes how a table shows a date and the stored date stays", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, NOTES);
    await addRecordByApi(page, owner, "notatki", { tytul: "Pierwsza", kiedy: "2026-02-03" }, "d42-2-first-note");
    await page.goto(`${owner.baseUrl}/registers/notatki`);
    await expect(page.getByRole("cell", { name: "03.02.2026", exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.settings") }).click();
    await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.app") }).click();
    await page.getByLabel("YYYY-MM-DD").check();
    await expect(page.getByText(text(settings, "dirty")).first()).toBeVisible();
    await page.getByRole("button", { name: text(settings, "app.dateFormat.save"), exact: true }).click();
    await expect(page.getByText(text(settings, "saved"), { exact: true })).toBeVisible();

    await page.getByRole("navigation", { name: text(common, "appBar.navigation") }).getByRole("link", { name: text(common, "appBar.registers") }).click();
    await page.getByRole("link", { name: "Notatki" }).first().click();
    await expect(page.getByRole("cell", { name: "2026-02-03", exact: true })).toBeVisible();
    // What is stored did not change.
    const stored = (await (await page.request.get(`${owner.baseUrl}/api/v1/registries/notatki/records`)).json()) as { records: Array<{ values: Record<string, unknown> }> };
    expect(stored.records[0]!.values["kiedy"]).toBe("2026-02-03");
  });

  test("two options are saved at once and are still there after a reload; a wrong draft is told at its field", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toApplication(page, owner);
    await expectNoViolations(page);

    await option(page, "limits.registries").getByRole("textbox").fill("abc");
    await expect(option(page, "limits.registries").getByText(text(settings, "app.errors.NOT_INTEGER"))).toBeVisible();
    await expect(saveOptions(page)).toBeDisabled();
    await option(page, "limits.registries").getByRole("textbox").fill("50");
    await option(page, "tables.defaultPageSize").getByRole("textbox").fill("40");
    await expect(page.getByText(text(settings, "dirty")).last()).toBeVisible();
    await saveOptions(page).click();
    await expect(page.getByText(text(settings, "app.options.saved"))).toBeVisible();
    const saved = await serverOptions(page, owner);
    expect(saved.filter((setting) => setting.source === "db").map((setting) => [setting.key, setting.value]).sort()).toEqual([["limits.registries", 50], ["tables.defaultPageSize", 40]]);

    await page.reload();
    await expect(option(page, "limits.registries").getByRole("textbox")).toHaveValue("50");
    await expect(option(page, "tables.defaultPageSize").getByRole("textbox")).toHaveValue("40");
  });

  test("an option the server refuses is told at its field, the other drafts stay, and nothing is saved", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toApplication(page, owner);
    // 250 KiB is inside the range of the option but leaves no room for the envelope in a 256 KiB request.
    await option(page, "limits.recordMaxKiB").getByRole("textbox").fill("250");
    await option(page, "tables.defaultPageSize").getByRole("textbox").fill("40");
    await saveOptions(page).click();
    await expect(option(page, "limits.recordMaxKiB").getByText(text(settings, "app.errors.SETTING_CONFLICT"))).toBeVisible();
    await expect(option(page, "limits.recordMaxKiB").getByRole("textbox")).toHaveValue("250");
    await expect(option(page, "tables.defaultPageSize").getByRole("textbox")).toHaveValue("40");
    expect((await serverOptions(page, owner)).filter((setting) => setting.source === "db")).toEqual([]);
  });
});

test.describe("D42.2-AC2 a limit trims nothing, a reset, the locks and the way out", () => {
  test("a lower limit of text keeps the text already stored, and one option goes back to its default", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, NOTES);
    const long = "x".repeat(30);
    await addRecordByApi(page, owner, "notatki", { tytul: long }, "d42-2-long-note");
    await toApplication(page, owner);
    await option(page, "limits.textLength").getByRole("textbox").fill("10");
    await saveOptions(page).click();
    await expect(page.getByText(text(settings, "app.options.saved"))).toBeVisible();

    await page.goto(`${owner.baseUrl}/registers/notatki`);
    await expect(page.getByRole("cell", { name: long, exact: true })).toBeVisible();
    const stored = (await (await page.request.get(`${owner.baseUrl}/api/v1/registries/notatki/records`)).json()) as { records: Array<{ values: Record<string, unknown> }> };
    expect(stored.records[0]!.values["tytul"]).toBe(long);

    await toApplication(page, owner);
    await page.getByRole("button", { name: say("app.options.resetFor", { name: text(settings, "options.limitTextLength") }) }).click();
    await expect(page.getByText(say("app.options.resetDone", { name: text(settings, "options.limitTextLength") }))).toBeVisible();
    await expect(option(page, "limits.textLength").getByRole("textbox")).toHaveValue("10000");
    expect((await serverOptions(page, owner)).filter((setting) => setting.source === "db")).toEqual([]);
  });

  test("an option the installation sets is locked and has no reset, one that needs a second factor is frozen with its reason, a restart is told", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    // The installation file of the test server sets no option; the answer is changed here as the server would give it with one set.
    await page.route(`**${SETTINGS_PATH}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as { settings: Array<Record<string, unknown>> };
      for (const setting of body.settings) if (setting["key"] === "limits.importMaxMiB") Object.assign(setting, { value: 200, source: "env", editable: false, restartRequired: true });
      return route.fulfill({ response, json: body });
    });
    await toApplication(page, owner);
    const locked = option(page, "limits.importMaxMiB");
    await expect(locked.getByRole("textbox")).toBeDisabled();
    await expect(locked.getByText(text(settings, "app.options.env"))).toBeVisible();
    await expect(locked.getByRole("button", { name: text(settings, "app.options.reset") })).toHaveCount(0);

    const frozen = option(page, "backup.nightlyKeep");
    await expect(frozen.getByRole("textbox")).toBeDisabled();
    await expect(frozen.getByText(text(settings, "app.options.stepUp"))).toBeVisible();
    await expect(option(page, "limits.jsonBodyKiB").getByText(text(settings, "app.options.readOnly"))).toBeVisible();
    await expectNoViolations(page);
  });

  test("leaving with unsaved changes asks first: Stay keeps the draft, Discard leaves", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toApplication(page, owner);
    await option(page, "limits.registries").getByRole("textbox").fill("60");
    const toAccount = () => page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.account") }).click();
    await toAccount();
    const dialog = page.getByRole("alertdialog", { name: text(settings, "app.leave.heading") });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: text(settings, "app.leave.stay") }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/app`);
    await expect(option(page, "limits.registries").getByRole("textbox")).toHaveValue("60");

    await toAccount();
    await page.getByRole("alertdialog", { name: text(settings, "app.leave.heading") }).getByRole("button", { name: text(settings, "app.leave.discard") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/settings/account`);
  });
});
