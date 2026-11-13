// D45.3 — the export from the Settings in a real browser (Scope §5.9; Architektura Załącznik G; DEV §9.42), on a
// fresh installation.
// AC1: the Application page offers the export with the warning before the link, which the link is described by;
//      the click downloads a file named by the day that is the format of the export, holds the owner's registry
//      and records, and holds no password, code of the second factor or secret of the installation.
// AC2: the download is made from the keyboard, the page is free of axe violations, and on a phone it does not
//      scroll sideways.
import { readFileSync } from "node:fs";
import { exportFileSchema } from "@openlife/contracts/export/format";
import type { Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, expectNoViolations, signInFully } from "./owner-session.ts";

const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1200 } });

const section = (page: Page) => page.getByRole("region", { name: text(settings, "app.export.heading") });

async function toApplication(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.app") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/settings/app`);
  await expect(section(page)).toBeVisible();
}

test.describe("D45.3-AC1 the export from the Application page", () => {
  test("warns first, describes the link by the warning, and downloads a file of the format with the owner's data and no secret", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await addRecordByApi(page, owner, BOOKS_DEFINITION.symbol, { tytul: "Pan Tadeusz" }, "d45-3-one");
    await addRecordByApi(page, owner, BOOKS_DEFINITION.symbol, { tytul: "Lalka" }, "d45-3-two");
    await toApplication(page, owner);

    const exporting = section(page);
    const warning = exporting.getByText(text(settings, "app.export.warning"));
    await expect(warning).toBeVisible();
    const link = exporting.getByRole("link", { name: text(settings, "app.export.download") });
    // The warning comes before the link on the page, and the link is described by it.
    const warningBox = await warning.boundingBox();
    const linkBox = await link.boundingBox();
    expect(warningBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(linkBox?.y ?? -1);
    await expect(link).toHaveAccessibleDescription(new RegExp(text(settings, "app.export.warning").slice(0, 30)));

    const downloading = page.waitForEvent("download");
    await link.click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^openlifedashboard-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(exporting.getByText(text(settings, "app.export.started"))).toBeVisible();

    const content = readFileSync((await download.path()) ?? "", "utf8");
    const file = exportFileSchema.parse(JSON.parse(content));
    const registry = file.registries.find((candidate) => candidate.symbol === BOOKS_DEFINITION.symbol);
    expect(registry?.records.map((record) => record.values["tytul"]).sort()).toEqual(["Lalka", "Pan Tadeusz"]);
    for (const secret of [...owner.instance.secrets, owner.password, owner.email, ...owner.recoveryCodes]) expect(content).not.toContain(secret);
    for (const word of ["user_id", "session", "totp", "audit"]) expect(content).not.toContain(word);
  });
});

test.describe("D45.3-AC2 the keyboard, axe and the phone", () => {
  test("the export is downloaded from the keyboard, and the page is free of axe violations", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toApplication(page, owner);
    await expectNoViolations(page);
    const link = section(page).getByRole("link", { name: text(settings, "app.export.download") });
    await link.focus();
    await expect(link).toBeFocused();
    const downloading = page.waitForEvent("download");
    await page.keyboard.press("Enter");
    expect((await downloading).suggestedFilename()).toMatch(/^openlifedashboard-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(section(page).getByText(text(settings, "app.export.started"))).toBeVisible();
    await expectNoViolations(page);
  });

  test("on a phone the page does not scroll sideways", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.setViewportSize({ width: 375, height: 800 });
    await toApplication(page, owner);
    expect(await page.evaluate<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth")).toBeLessThanOrEqual(0);
    await expectNoViolations(page);
  });
});
