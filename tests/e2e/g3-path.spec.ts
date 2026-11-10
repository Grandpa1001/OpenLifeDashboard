// G3 — the screen of F01 on one installation in a real browser (DEV §8.4, §9.37, KM3): the register table
// "Moje książki" and the two clocks Dom and Nowy Jork of F01, seen on a laptop and on a phone, with the
// clock of the page at the night the clocks change (F02); a record added in one tab shown in another
// without a reload; the stream lost with the server and found again; a widget that fails beside the others
// that go on; and the Designer with its preview over the same screen. Made through the routes of the
// product with the session of the page (no SQL).
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const widgets = locale("en", "widgets");
const designer = locale("en", "designer");
const errors = locale("en", "errors");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

type Widget = { id: string; type: string; config: Record<string, unknown>; layout: Record<"phone" | "tablet" | "desktop", unknown>; bindings: unknown[] };
type ClockCase = { nowIso: string; "Europe/Warsaw": string; "America/New_York": string };
const F01 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { screens: Array<{ name: string; widgets: Widget[] }> };
const F02 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { fixedClockCases: ClockCase[] };
const TABLE = F01.screens[0]!.widgets.find((widget) => widget.type === "register-table")!;
const CLOCKS = F01.screens[0]!.widgets.filter((widget) => widget.type === "clock");
/** A quarter of a second past the moment of F02, so no tick of a clock ends on it. */
const OFFSET_MS = 250;
const STREAM_STATE = "document.documentElement.dataset.liveStream ?? null";
/** The time a record of tab A has to reach tab B (Scope §5.4 S11). */
const REACHES_WITHIN_MS = 1000;

const clockOf = (page: Page, label: string) => page.getByRole("region", { name: `Clock: ${label}` });
const tableOf = (page: Page) => page.getByRole("region", { name: "Moje książki" });

/** F01's table and its two clocks on the first screen, through the routes with the session of the page. */
async function f01Screen(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (const [index, title] of ["Solaris", "Diuna", "Lalka"].entries()) await addRecordByApi(page, owner, "ksiazki", { tytul: title }, `g3-path-book-${index}`);
  const screenId = await createScreenWith(page, owner, [{ id: TABLE.id, title: "Moje książki", layout: TABLE.layout as never }], F01.screens[0]!.name);
  const saved = await page.request.get(`${owner.baseUrl}/api/v1/screens/${screenId}`);
  const screen = (await saved.json()) as { name: string; theme: string; accent: string; widgets: Array<Record<string, unknown>> };
  const kept = screen.widgets.map((widget) => Object.fromEntries(Object.entries(widget).filter(([key]) => key !== "state")));
  const put = await page.request.put(`${owner.baseUrl}/api/v1/screens/${screenId}/design`, { data: { name: screen.name, theme: screen.theme, accent: screen.accent, widgets: [...kept, ...CLOCKS] }, headers: { Origin: owner.baseUrl } });
  expect(put.status(), await put.text()).toBe(200);
}

test.describe("G3 the screen of F01 on a laptop and a phone", () => {
  test("the table and the clocks at the night the clocks change, on a laptop and then on a phone, axe on both", async ({ page, ownerServer }) => {
    const moment = F02.fixedClockCases[1]!;
    await page.clock.install({ time: new Date(new Date(moment.nowIso).getTime() + OFFSET_MS) });
    const owner = await ownerServer("ready");
    await f01Screen(page, owner);
    await page.goto(`${owner.baseUrl}/`);

    await expect(tableOf(page).getByRole("cell", { name: "Solaris", exact: true })).toBeVisible();
    await expect(clockOf(page, "Dom").locator("time")).toHaveText(moment["Europe/Warsaw"]);
    await expect(clockOf(page, "Nowy Jork").locator("time")).toHaveText(new RegExp(`^${moment["America/New_York"]}:[0-5]\\d$`));
    await expectNoViolations(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(clockOf(page, "Dom").locator("time")).toHaveText(moment["Europe/Warsaw"]);
    expect(await page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth")).toBe(false);
    const tops = (await page.evaluate("[...document.querySelectorAll('section.widget')].map((section) => Math.round(section.getBoundingClientRect().top + window.scrollY))")) as number[];
    expect(tops).toHaveLength(3);
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    await expectNoViolations(page);
  });
});

test.describe("G3 two tabs, a lost stream, a failing widget", () => {
  test("a record added in tab A is in tab B within a second, and after the server restarts tab B is live again and shows what came meanwhile", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await f01Screen(page, owner);
    await page.goto(`${owner.baseUrl}/`);
    await expect(tableOf(page).getByRole("cell", { name: "Solaris", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(STREAM_STATE)).toBe("live");

    const tabA = await context.newPage();
    await tabA.goto(`${owner.baseUrl}/screens`);
    await addRecordByApi(tabA, owner, "ksiazki", { tytul: "Z karty A" }, "g3-path-from-a");
    await expect(tableOf(page).getByRole("cell", { name: "Z karty A", exact: true })).toBeVisible({ timeout: REACHES_WITHIN_MS });

    // Tab A has done its part: a tab left open keeps connections the orderly stop of the server waits for (run of the gate: "process still running after 15000 ms").
    await tabA.close();
    await owner.restart();
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Po restarcie" }, "g3-path-after-restart");
    await expect.poll(() => page.evaluate(STREAM_STATE), { timeout: 30_000 }).toBe("live");
    await expect(tableOf(page).getByRole("cell", { name: "Po restarcie", exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test("a table whose data cannot be read says why, the clocks and the page go on, and the Designer and its preview open the same screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await f01Screen(page, owner);
    await page.route(`**/api/v1/widgets/${TABLE.id}/data*`, (route) => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR", message: "x", details: null, requestId: "req-g3-path" } }));
    await page.goto(`${owner.baseUrl}/`);
    const failed = tableOf(page).getByRole("alert");
    await expect(failed).toContainText(text(widgets, "registerTable.loadFailed"));
    await expect(failed).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(failed).toContainText("req-g3-path");
    await expect(clockOf(page, "Dom").locator("time")).toBeVisible();
    await expect(clockOf(page, "Nowy Jork").locator("time")).toBeVisible();

    await page.unroute(`**/api/v1/widgets/${TABLE.id}/data*`);
    await page.goto(`${owner.baseUrl}/designer`);
    await expect(page.getByRole("button", { name: "Select widget: Moje książki" })).toBeVisible();
    await page.getByRole("button", { name: text(designer, "toolbar.preview"), exact: true }).click();
    const frame = page.getByRole("region", { name: text(designer, "preview.label") });
    await expect(frame.getByRole("cell", { name: "Solaris", exact: true })).toBeVisible();
    await expect(frame.locator("section.widget")).toHaveCount(3);
    await expectNoViolations(page);
  });
});
