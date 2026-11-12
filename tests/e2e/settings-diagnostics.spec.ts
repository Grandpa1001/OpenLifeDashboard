// D44.6 — the Diagnostics page in a real browser (Scope §5.9; Architektura §15.3; DEV §9.41), on a fresh
// installation.
// AC1: the page lists the state of the installation, the full paths of the host and of the container and copies
//      one; the files of the log are listed and downloaded, as is the diagnostic report, which holds no secret;
//      the request id of an answer finds its lines in the log, a malformed or unknown id is told, a latest error
//      with a request id leads to the search.
// AC2: the page works from the keyboard, is free of axe violations, and does not scroll sideways on a phone.
import type { Page } from "@playwright/test";
import { diagnosticReportSchema } from "@openlife/contracts/http/diagnostics";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

const common = locale("en");
const settings = locale("en", "settings");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1600 } });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(settings, key));
const section = (page: Page, key: string) => page.getByRole("region", { name: text(settings, key) });

async function toDiagnostics(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/settings/account`);
  await page.getByRole("navigation", { name: text(settings, "navigation") }).getByRole("link", { name: text(settings, "tabs.diagnostics") }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/settings/diagnostics`);
  await expect(section(page, "diagnostics.overview.heading")).toBeVisible();
}

/** A request that fails and carries its request id in the answer, as an owner would see it in an error message. */
async function failingRequest(page: Page, owner: BrowserOwner): Promise<string> {
  const reply = await page.request.get(`${owner.baseUrl}/api/v1/registries/nothing-here/records`);
  expect(reply.status()).toBe(404);
  const id = ((await reply.json()) as { requestId?: string }).requestId;
  expect(id).toBeTruthy();
  return id ?? "";
}

test.describe("D44.6-AC1 the state, the paths, the files and the search", () => {
  test("shows the version and the sizes, the paths of the host and the container, and copies a path", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: owner.baseUrl });
    await signInFully(page, owner);
    await toDiagnostics(page, owner);
    await expect(page.getByRole("link", { name: text(settings, "tabs.diagnostics") })).toHaveAttribute("aria-current", "page");

    const overview = section(page, "diagnostics.overview.heading");
    await expect(overview.getByText(text(settings, "diagnostics.overview.modes.local"))).toBeVisible();
    await expect(overview.getByText(owner.instance.instanceId)).toBeVisible();
    await expect(overview.getByText(text(settings, "diagnostics.overview.loggerOk"))).toBeVisible();
    await expect(overview.getByText(text(settings, "diagnostics.overview.missing"))).toBeVisible();

    const paths = section(page, "diagnostics.paths.heading");
    const database = paths.getByRole("row").filter({ has: page.getByRole("rowheader", { name: text(settings, "diagnostics.paths.roles.database") }) });
    await expect(database.getByRole("cell").nth(0)).toHaveText(path.join(owner.instance.dir, "data", "app.db"));
    await expect(database.getByRole("cell").nth(1)).toHaveText("/data/app.db");
    await expect(paths.getByRole("row").filter({ has: page.getByRole("rowheader", { name: text(settings, "diagnostics.paths.roles.installation") }) }).getByRole("cell").nth(0)).toHaveText(owner.instance.dir);

    await database.getByRole("button", { name: new RegExp(text(settings, "diagnostics.paths.copy")) }).click();
    await expect(paths.getByText(say("diagnostics.paths.copied", { what: text(settings, "diagnostics.paths.roles.database") }))).toBeVisible();
    expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe(path.join(owner.instance.dir, "data", "app.db"));
    await paths.getByRole("button", { name: text(settings, "diagnostics.paths.copyCommand") }).click();
    expect(await page.evaluate<string>("navigator.clipboard.readText()")).toBe("docker compose logs --tail=200 app");
    // There is no button that opens a folder: a browser cannot open one on another machine.
    await expect(page.getByRole("button", { name: /open folder|otwórz folder/i })).toHaveCount(0);
  });

  test("lists the files of the log and downloads one, and downloads the report, which holds no secret", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toDiagnostics(page, owner);
    await failingRequest(page, owner);

    const files = section(page, "diagnostics.files.heading");
    await expect(files.getByRole("rowheader", { name: /app\.jsonl/ })).toBeVisible();
    const downloading = page.waitForEvent("download");
    await files.getByRole("link", { name: new RegExp(`${text(settings, "diagnostics.files.download")} app\\.jsonl`) }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("app.jsonl");
    const logText = readFileSync((await download.path()) ?? "", "utf8");
    expect(logText).toContain('"event":"http.request"');
    for (const secret of owner.instance.secrets) expect(logText).not.toContain(secret);

    const reporting = page.waitForEvent("download");
    await files.getByRole("link", { name: text(settings, "diagnostics.files.report") }).click();
    const reportDownload = await reporting;
    expect(reportDownload.suggestedFilename()).toBe("openlife-diagnostics.json");
    const reportText = readFileSync((await reportDownload.path()) ?? "", "utf8");
    const report = diagnosticReportSchema.parse(JSON.parse(reportText));
    expect(report.overview.app.instanceId).toBe(owner.instance.instanceId);
    for (const secret of [...owner.instance.secrets, owner.password, ...owner.recoveryCodes]) expect(reportText).not.toContain(secret);
  });

  test("finds the lines of a request by the id of its answer, and tells a malformed and an unknown id", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const requestId = await failingRequest(page, owner);
    await toDiagnostics(page, owner);

    const search = section(page, "diagnostics.search.heading");
    const field = search.getByLabel(text(settings, "diagnostics.search.label"));
    const submit = search.getByRole("button", { name: text(settings, "diagnostics.search.submit") });
    // A malformed id is told at the field and nothing is sent.
    await field.fill("not an id!");
    await submit.click();
    await expect(search.getByText(text(settings, "diagnostics.search.malformed"))).toBeVisible();

    // The log is written a moment after the request: the search is repeated until the line is there.
    await field.fill(requestId);
    await expect(async () => {
      await submit.click();
      await expect(search.getByRole("list", { name: text(settings, "diagnostics.search.linesLabel") }).getByRole("listitem").first()).toContainText(requestId, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(search.getByRole("list", { name: text(settings, "diagnostics.search.linesLabel") })).toContainText('"status":404');
    await expect(search.getByText(/line(s)? found/)).toBeVisible();

    await field.fill("a-request-that-never-was");
    await submit.click();
    await expect(search.getByText(text(settings, "diagnostics.search.none"))).toBeVisible();
    await expect(search.getByRole("list", { name: text(settings, "diagnostics.search.linesLabel") })).toHaveCount(0);
  });

  test("shows no errors when the log has none", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await toDiagnostics(page, owner);
    await expect(section(page, "diagnostics.errors.heading").getByText(text(settings, "diagnostics.errors.none"))).toBeVisible();
  });
});

test.describe("D44.6-AC2 the keyboard, axe and the phone", () => {
  test("the page works from the keyboard and is free of axe violations", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const requestId = await failingRequest(page, owner);
    await toDiagnostics(page, owner);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(text(settings, "title"));
    await expectNoViolations(page);

    // The field is typed in and the search is made with Enter.
    const search = section(page, "diagnostics.search.heading");
    const field = search.getByLabel(text(settings, "diagnostics.search.label"));
    await field.focus();
    await page.keyboard.type(requestId);
    await expect(async () => {
      await page.keyboard.press("Enter");
      await expect(search.getByRole("list", { name: text(settings, "diagnostics.search.linesLabel") })).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expectNoViolations(page);

    // The scrolling tables are reachable by the keyboard.
    const files = section(page, "diagnostics.files.heading").getByRole("group");
    await files.focus();
    await expect(files).toBeFocused();
    // The app bar stays: nothing of the page was lost.
    await expect(page.getByRole("navigation", { name: text(common, "appBar.navigation") })).toBeVisible();
  });

  test("on a phone the page does not scroll sideways and the paths stay in their own region", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.setViewportSize({ width: 375, height: 800 });
    await toDiagnostics(page, owner);
    await expect(section(page, "diagnostics.paths.heading")).toBeVisible();
    const overflow = await page.evaluate<number>("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoViolations(page);
  });
});
