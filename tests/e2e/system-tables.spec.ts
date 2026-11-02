// D32.2 — the cards of the registries and the system preview in a real browser (Scope §5.5, makieta
// 06, 32) on Książki of F01 with its table widget.
// AC1: the card of Książki counts its 25 records and its one widget; the section System lists the six
//      tables, the audit opens in pages kept in the address, the catalog shows Książki, and nothing
//      on these pages can be edited.
// AC2: a table the preview does not know is said so and nothing is asked of the server; on a narrow
//      phone the page does not scroll sideways (the table scrolls in its own region); keyboard; axe.
import type { Page } from "@playwright/test";
import { SYSTEM_TABLES_PATH } from "@openlife/contracts/http/system-tables";
import { execute, query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replaceAll(`{{${name}}}`, String(value)), text(registers, key));
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };
const TABLE_NAMES = ["registry", "registry_column", "screen", "widget", "binding", "audit_log"];

async function booksOnScreen(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (let index = 1; index <= 25; index += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${String(index).padStart(2, "0")}` }, `seed-key-${String(index).padStart(3, "0")}`);
  await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000032a1", title: "Moje książki", layout: LAYOUT }]);
}

test.describe("D32.2-AC1 the cards and the system preview", () => {
  test("the card counts 25 records and 1 widget; System lists six tables; the audit in pages kept in the address; the catalog shows Książki; nothing to edit", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    await page.goto(`${owner.baseUrl}/registers`);
    const card = page.locator(".registry-card").filter({ has: page.getByRole("link", { name: "Książki" }) });
    await expect(card).toContainText(`${say("list.records_other", { count: 25 })} · ${say("list.widgets_one", { count: 1 })}`);

    const system = page.getByRole("region", { name: text(registers, "system.heading") });
    await expect(system.getByRole("link")).toHaveText(TABLE_NAMES.map((name) => text(registers, `system.tables.${name}`)));
    await expectNoViolations(page);

    // The audit: more than a page, newest first, the page in the address.
    for (let index = 0; index < 30; index += 1) execute(owner.instance, `INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id, details) VALUES ('2026-11-02T12:00:00.000Z', NULL, 'test.entry', 'test', 'e-${String(index).padStart(2, "0")}', 'r-${index}', NULL)`);
    const total = query<{ n: number }>(owner.instance, "SELECT count(*) AS n FROM audit_log")[0]!.n;
    await page.reload();
    await system.getByRole("link", { name: text(registers, "system.tables.audit_log") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/system-tables/audit_log`);
    await expect(page.getByRole("heading", { level: 1, name: text(registers, "system.tables.audit_log") })).toBeVisible();
    await expect(page.getByRole("columnheader")).toHaveText(["id", "at", "actor", "action", "entity", "entity_id", "request_id", "details"]);
    await expect(page.getByRole("row").nth(1)).toContainText("e-29");
    await expect(page.getByText(say("table.range", { from: 1, to: 25, total }))).toBeVisible();
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/system-tables/audit_log?page=2`);
    await expect(page.getByText(say("table.range", { from: 26, to: total, total }))).toBeVisible();
    await page.reload();
    await expect(page.getByText(say("table.range", { from: 26, to: total, total }))).toBeVisible();
    // Read only: no field and no button but the pages.
    await expect(page.locator("main input, main select, main textarea")).toHaveCount(0);
    await expect(page.locator("main button")).toHaveCount(2);
    await expectNoViolations(page);

    await page.goto(`${owner.baseUrl}/system-tables/registry`);
    await expect(page.getByRole("row").nth(1)).toContainText("ksiazki");
    await expect(page.getByRole("cell", { name: "Książki", exact: true })).toBeVisible();
  });
});

test.describe("D32.2-AC2 an unknown table, a phone and the keyboard", () => {
  test("a table the preview does not know is said so without a request; a 320 px phone does not scroll sideways; the table region takes the focus", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksOnScreen(page, owner);
    let asked = 0;
    page.on("request", (request) => {
      if (request.url().includes(`${SYSTEM_TABLES_PATH}/`)) asked += 1;
    });
    await page.goto(`${owner.baseUrl}/system-tables/user`);
    await expect(page.getByRole("alert")).toHaveText(text(registers, "system.unknown"));
    expect(asked).toBe(0);

    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${owner.baseUrl}/system-tables/registry_column`);
    await expect(page.getByRole("row")).toHaveCount(10);
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    const region = page.getByRole("region", { name: text(registers, "system.tables.registry_column") });
    await region.focus();
    await expect(region).toBeFocused();
    await expectNoViolations(page);

    await page.goto(`${owner.baseUrl}/registers`);
    const scroll = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(scroll.page).toBeLessThanOrEqual(scroll.view);
  });
});
