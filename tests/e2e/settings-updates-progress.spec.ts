// D57.2 — the course of an update and its result on the Updates page in a real browser (Scope §5.9, S14; Architektura §11.2.2 step 8; DEV §9.56). The state of the
// operation is the one of the updater, given to the page by the answers of `GET /api/v1/updates`; the test changes them as the updater would while the application is replaced.
// AC1: while an update goes on the page says in words at which stage it is and keeps asking, the stage changes with the state, the mark in the corner says that an update
//      goes on, and while the application cannot be read (it is replaced) the page says it is reconnecting and shows no error.
// AC2: the result is told from the state once the application answers again, whatever became of the request that started it: success with the new version, a return to
//      the previous one with the reason in words, or an installation that needs attention; it stays until the owner closes it, a closed one stays closed after a reload,
//      the page is free of axe violations and does not scroll sideways on a phone.
import type { Page, Route } from "@playwright/test";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

const settings = locale("en", "settings");
const common = locale("en");
test.use({ locale: "en-US", viewport: { width: 1280, height: 1200 } });

const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";
const say = (key: string, values: Record<string, string | number> = {}, from: Record<string, unknown> = settings) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(from, key));

type Operation = { operationId: string; state: string; targetRelease: string | null; error: { code: string } | null };
type Mode = { kind: "state"; operation: Operation | null; current?: string } | { kind: "down" };

/** The state the page reads is the real one of the installation with the operation (and the running version) the test says; "down" is an application that cannot be reached. */
async function theUpdaterSays(page: Page, initial: Mode): Promise<{ set: (mode: Mode) => void }> {
  let mode = initial;
  await page.route("**/api/v1/updates", async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (mode.kind === "down") return route.abort("connectionrefused");
    const real = await route.fetch();
    const json = (await real.json()) as Record<string, unknown>;
    return route.fulfill({ response: real, json: { ...json, ...(mode.current === undefined ? {} : { current: mode.current }), operation: mode.operation } });
  });
  return { set: (next) => void (mode = next) };
}
const op = (state: string, over: Partial<Operation> = {}): Operation => ({ operationId: ID_1, state, targetRelease: "1.2.0", error: null, ...over });
const mark = (page: Page) => page.getByRole("navigation", { name: text(common, "version.navigation") }).getByRole("link");
const stages = (key: string) => say(`updates.progress.stage.${key}`);

test.describe("D57.2-AC1 where the update is, in words, and reconnecting that is no failure", () => {
  test("says the stage, follows the state, marks the corner, says reconnecting while the application is replaced and shows no error", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const updater = await theUpdaterSays(page, { kind: "state", operation: op("pulling") });
    await page.goto(`${owner.baseUrl}/settings/updates`);

    const section = page.getByRole("region", { name: say("updates.progress.heading", { version: "1.2.0" }) });
    await expect(section).toBeVisible();
    await expect(section.getByRole("status").filter({ hasText: stages("pulling") })).toBeVisible();
    await expect(section.getByRole("listitem").filter({ hasText: stages("pulling") })).toHaveAttribute("aria-current", "step");
    await expect(section.getByText(text(settings, "updates.progress.writesClosed"))).toBeVisible();
    await expect(mark(page)).toContainText(text(common, "version.updating"));
    await expect(page.locator(".version-busy")).toHaveCount(1);
    await expect(page.locator(".version-dot")).toHaveCount(0);

    updater.set({ kind: "state", operation: op("backing_up") });
    await expect(section.getByRole("status").filter({ hasText: stages("backing_up") })).toBeVisible({ timeout: 10_000 });
    await expect(section.getByRole("listitem").filter({ hasText: stages("pulling") })).toHaveAttribute("data-done", "true");

    // The application is replaced: it cannot be read for a while. That is told as reconnecting, and no alert is raised.
    updater.set({ kind: "down" });
    await expect(section.getByText(text(settings, "updates.progress.reconnecting"))).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    // It answers again, in the stage the updater is at.
    updater.set({ kind: "state", operation: op("verifying") });
    await expect(section.getByRole("status").filter({ hasText: stages("verifying") })).toBeVisible({ timeout: 10_000 });
    await expect(section.getByText(text(settings, "updates.progress.reconnecting"))).toHaveCount(0);
  });

  test("says that the previous version is being put back while the way back goes on", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await theUpdaterSays(page, { kind: "state", operation: op("rolling_back") });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await expect(page.getByRole("status").filter({ hasText: text(settings, "updates.progress.returning") })).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(0);
  });
});

test.describe("D57.2-AC2 the result is told from the state and stays until it is closed", () => {
  test("after the application answers again as the new version it says so, and a closed result stays closed after a reload", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const updater = await theUpdaterSays(page, { kind: "state", operation: op("committing") });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await expect(page.getByRole("status").filter({ hasText: stages("committing") })).toBeVisible();

    updater.set({ kind: "down" });
    await expect(page.getByText(text(settings, "updates.progress.reconnecting"))).toBeVisible({ timeout: 10_000 });
    // The new application answers: the operation is completed and the version that runs is the release it was for.
    updater.set({ kind: "state", operation: op("completed"), current: "1.2.0" });
    const result = page.getByRole("region", { name: text(settings, "updates.result.heading.updated") });
    await expect(result).toBeVisible({ timeout: 10_000 });
    await expect(result.getByText(say("updates.result.updated", { version: "1.2.0" }))).toBeVisible();
    await expect(mark(page)).toContainText("v1.2.0");
    await expect(page.locator(".version-busy")).toHaveCount(0);
    await expect(page.getByRole("region", { name: say("updates.progress.heading", { version: "1.2.0" }) })).toHaveCount(0);

    await result.getByRole("button", { name: text(settings, "updates.result.dismiss") }).click();
    await expect(result).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { name: text(settings, "updates.version.heading") })).toBeVisible();
    await expect(page.getByRole("region", { name: text(settings, "updates.result.heading.updated") })).toHaveCount(0);
  });

  test("says in words why the previous version came back, closes on request and shows the result of a later operation again", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const updater = await theUpdaterSays(page, { kind: "state", operation: op("idle", { error: { code: "B_MIGRATION_FAILED" } }) });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    const result = page.getByRole("region", { name: text(settings, "updates.result.heading.returned") });
    await expect(result).toBeVisible();
    await expect(result.getByRole("alert")).toContainText(text(settings, "updates.result.returned"));
    await expect(result.getByRole("alert")).toContainText(text(settings, "updates.result.codes.B_MIGRATION_FAILED"));
    await result.getByRole("button", { name: text(settings, "updates.result.dismiss") }).click();
    await expect(result).toBeHidden();
    await page.reload();
    await expect(page.getByRole("region", { name: text(settings, "updates.result.heading.returned") })).toHaveCount(0);
    // Another operation that ends the same way is another result.
    updater.set({ kind: "state", operation: op("idle", { operationId: ID_2, error: { code: "START_TIMEOUT" } }) });
    await page.reload();
    await expect(page.getByRole("region", { name: text(settings, "updates.result.heading.returned") })).toContainText(text(settings, "updates.result.codes.START_TIMEOUT"));
  });

  test("tells a code it does not know with the common sentence, and an installation that needs attention without a button to close it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const updater = await theUpdaterSays(page, { kind: "state", operation: op("idle", { error: { code: "SOMETHING_NEW" } }) });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await expect(page.getByRole("alert").filter({ hasText: text(settings, "updates.result.codes.UNKNOWN") })).toBeVisible();
    updater.set({ kind: "state", operation: op("recovery_failed", { operationId: ID_2, error: { code: "RESTORE_FAILED" } }) });
    await page.reload();
    const stuck = page.getByRole("region", { name: text(settings, "updates.result.heading.stuck") });
    await expect(stuck.getByRole("alert")).toContainText(text(settings, "updates.result.stuck"));
    await expect(stuck.getByRole("button")).toHaveCount(0);
    // Nothing is offered while the installation waits for the operator.
    await expect(page.getByRole("button", { name: /^Install /i })).toHaveCount(0);
  });

  test("the progress and the result are free of axe violations and do not scroll sideways on a phone", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const updater = await theUpdaterSays(page, { kind: "state", operation: op("switching") });
    await page.goto(`${owner.baseUrl}/settings/updates`);
    await expect(page.getByRole("status").filter({ hasText: stages("switching") })).toBeVisible();
    await expectNoViolations(page);
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
    updater.set({ kind: "state", operation: op("idle", { error: { code: "B_OOM_KILLED" } }) });
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: text(settings, "updates.result.codes.B_OOM_KILLED") })).toBeVisible();
    await expectNoViolations(page);
    expect(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
  });
});
