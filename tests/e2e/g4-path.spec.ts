// G4 — the real import of F01 into an empty installation B, in a real browser (DEV §8.4, §9.45, KM4): installation A
// takes the file of F01 in its setup and gives its own export; installation B refuses a broken copy of that
// export and keeps its choice open, then takes the export of A in its setup; the export of B is the export of A in
// canonical form (everything but the moment it was made); the screen of F01 is on B with its table and its
// records; neither export nor the diagnostic report of either installation holds a secret of either; and B takes no
// second import. Made through the pages and the routes of the product (no SQL).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { DIAGNOSTICS_REPORT_PATH } from "@openlife/contracts/http/diagnostics";
import { SETUP_IMPORT_PATH } from "@openlife/contracts/http/setup";
import type { BrowserOwner } from "../support/auth-http.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const setup = locale("en", "setup");
const FIXTURE = path.join(repoRoot, "tests/fixtures/books/books-v1.export.json");
const EXPECTED = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { pageTitles: string[][]; recordCount: number };
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

/** The setup of an installation at the choice of the starting data. */
async function atTheData(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(text(setup, "data.heading"));
}

const fileInput = (page: Page) => page.getByLabel(text(setup, "data.import.fileLabel"));
const importButton = (page: Page) => page.getByRole("button", { name: text(setup, "data.import.submit") });

/** An export without the moment it was made: what two installations must agree on. */
const canonical = (exportText: string): unknown => {
  const { exportedAt: _at, ...rest } = JSON.parse(exportText) as Record<string, unknown>;
  void _at;
  return rest;
};

test.describe("G4-path the import of F01 into an empty installation B", () => {
  test("A takes F01 and exports it; B refuses a broken copy, takes the export of A, and exports the same state; no secret in either file or report", async ({ page, ownerServer }) => {
    // Installation A: F01 through the setup, then its own export.
    const a = await ownerServer("data_unchosen");
    await atTheData(page, a);
    await fileInput(page).setInputFiles(FIXTURE);
    await importButton(page).click();
    await expect(page).toHaveURL(`${a.baseUrl}/`);
    const exportOfA = await (await page.request.get(`${a.baseUrl}${EXPORT_PATH}`)).text();
    const reportOfA = await (await page.request.get(`${a.baseUrl}${DIAGNOSTICS_REPORT_PATH}`)).text();

    // Installation B, empty: a broken copy of that export is refused and nothing is chosen.
    const b = await ownerServer("data_unchosen");
    await atTheData(page, b);
    const broken = JSON.parse(exportOfA) as { registries: { columns: { type: string }[] }[] };
    broken.registries[0]!.columns[1]!.type = "no_such_type";
    await fileInput(page).setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(broken)) });
    await importButton(page).click();
    const places = page.getByRole("list", { name: text(setup, "data.import.issuesLabel") });
    await expect(places).toContainText("registries[0].columns[1].type");
    await expect(places).not.toContainText("no_such_type");
    expect(await (await page.request.get(`${b.baseUrl}/api/v1/setup/status`)).json()).toMatchObject({ dataChoice: "unselected", nextAction: "setup_data" });

    // The export of A, from the same page: B is on its private screen with the screen of F01 and its records.
    await fileInput(page).setInputFiles({ name: "openlifedashboard.json", mimeType: "application/json", buffer: Buffer.from(exportOfA) });
    await importButton(page).click();
    await expect(page).toHaveURL(`${b.baseUrl}/`);
    const table = page.getByRole("region", { name: "Moje książki" });
    await expect(table).toBeVisible();
    await expect(table).toContainText(EXPECTED.pageTitles[0]![0]!);
    const exportOfB = await (await page.request.get(`${b.baseUrl}${EXPORT_PATH}`)).text();
    expect(canonical(exportOfB)).toEqual(canonical(exportOfA));
    expect((JSON.parse(exportOfB) as { registries: { records: unknown[] }[] }).registries[0]!.records).toHaveLength(EXPECTED.recordCount);

    // No secret of either installation in either file or in the report of either.
    const reportOfB = await (await page.request.get(`${b.baseUrl}${DIAGNOSTICS_REPORT_PATH}`)).text();
    for (const [name, content] of [["export of A", exportOfA], ["export of B", exportOfB], ["report of A", reportOfA], ["report of B", reportOfB]] as const) {
      for (const secret of [...a.instance.secrets, ...b.instance.secrets, a.password, b.password, ...a.recoveryCodes, ...b.recoveryCodes]) expect(content, name).not.toContain(secret);
    }

    // The choice is made once: a second import is refused and the setup leads back to the screen.
    const second = await page.request.post(`${b.baseUrl}${SETUP_IMPORT_PATH}`, { data: exportOfA, headers: { "content-type": "application/json", origin: b.baseUrl } });
    expect(second.status()).toBe(409);
    await page.goto(`${b.baseUrl}/setup`);
    await expect(page).toHaveURL(`${b.baseUrl}/`);
  });
});
