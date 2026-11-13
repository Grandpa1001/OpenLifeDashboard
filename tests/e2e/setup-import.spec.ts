// D46.4 — starting from a file in the setup, in a real browser on a fresh installation (Scope §5.1; Architektura
// Załącznik G; DEV §9.43).
// AC1: the export file of F01 chosen in the setup is imported: the setup ends, the private screen opens in the
//      language of the file, the installation holds the registry and its 25 records and the choice of the data is
//      "imported"; a file that is not an export, a file of a newer version and a file with a wrong value are
//      refused with their reason and the places in the file, the form stays, nothing is chosen, and a good file
//      is then imported from the same page.
// AC2: the import is reached and used from the keyboard, the page has no violations of axe before and after a
//      refusal, and a phone is not wider than itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const setup = locale("en", "setup");
const plCommon = locale("pl");
const FIXTURE = path.join(repoRoot, "tests/fixtures/books/books-v1.export.json");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The setup at the choice of the starting data. */
async function atTheData(page: Page, owner: { baseUrl: string; email: string; password: string; code: (n: number) => Promise<string> }): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "data.heading"));
}

const fileInput = (page: Page) => page.getByLabel(text(setup, "data.import.fileLabel"));
const importButton = (page: Page) => page.getByRole("button", { name: text(setup, "data.import.submit") });
const upload = (name: string, body: string) => ({ name, mimeType: "application/json", buffer: Buffer.from(body, "utf8") });

test.describe("the import in the setup", () => {
  test("a refused file shows its reason and its places and keeps the form, then the file of F01 ends the setup", async ({ page, ownerServer }) => {
    const owner = await ownerServer("data_unchosen");
    await atTheData(page, owner);
    await expect(importButton(page)).toBeDisabled();
    await expectNoViolations(page);

    // Not JSON at all.
    await fileInput(page).setInputFiles(upload("notes.json", "this is not json"));
    await importButton(page).click();
    await expect(page.getByRole("alert")).toContainText(text(locale("en", "errors"), "IMPORT_INVALID"));
    await expect(page.getByText(text(setup, "data.import.reasons.EXPORT_NOT_JSON"))).toBeVisible();
    await expect(fileInput(page)).toBeEnabled();

    // A newer version of the format.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    await fileInput(page).setInputFiles(upload("future.json", JSON.stringify({ ...fixture, formatVersion: 999 })));
    await importButton(page).click();
    await expect(page.getByText(text(setup, "data.import.reasons.EXPORT_VERSION_NEWER"))).toBeVisible();

    // A wrong value: the place in the file is listed, the value is not.
    const broken = structuredClone(fixture) as { registries: { columns: { type: string }[] }[] };
    const column = broken.registries[0]?.columns[1];
    if (column === undefined) throw new Error("the fixture has no second column");
    column.type = "no_such_type";
    await fileInput(page).setInputFiles(upload("broken.json", JSON.stringify(broken)));
    await importButton(page).click();
    const places = page.getByRole("list", { name: text(setup, "data.import.issuesLabel") });
    await expect(places).toBeVisible();
    await expect(places).toContainText("registries[0].columns[1].type");
    await expect(places).not.toContainText("no_such_type");
    await expectNoViolations(page);
    // Nothing was chosen: the server still asks for the starting data.
    const status = await page.request.get(`${owner.baseUrl}/api/v1/setup/status`);
    expect(await status.json()).toMatchObject({ dataChoice: "unselected", nextAction: "setup_data" });

    // The good file, from the same page.
    await fileInput(page).setInputFiles(FIXTURE);
    await importButton(page).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(plCommon, "main.title"));
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
    const after = await page.request.get(`${owner.baseUrl}/api/v1/setup/status`);
    expect(await after.json()).toMatchObject({ dataChoice: "imported", stage: "complete", nextAction: "ready" });
    const exported = (await (await page.request.get(`${owner.baseUrl}${EXPORT_PATH}`)).json()) as { registries: { records: unknown[] }[] };
    expect([exported.registries.length, exported.registries[0]?.records.length]).toEqual([1, 25]);
    await page.goto(`${owner.baseUrl}/setup`);
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
  });

  test("the import is reached and used from the keyboard and fits a phone", async ({ page, ownerServer }) => {
    const owner = await ownerServer("data_unchosen");
    await atTheData(page, owner);
    await page.setViewportSize({ width: 390, height: 800 });
    // The order of the page: the empty start, then the file, then the import.
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).focus();
    await page.keyboard.press("Tab");
    await expect(fileInput(page)).toBeFocused();
    await fileInput(page).setInputFiles(FIXTURE);
    await page.keyboard.press("Tab");
    await expect(importButton(page)).toBeFocused();
    expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth")).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
  });
});
