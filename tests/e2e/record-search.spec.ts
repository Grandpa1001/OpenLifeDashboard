// D23.4 — searching, sorting and paging the records in a real browser (Scope §5.6, makieta 08; DEV
// §9.19) on the 25 records of F01 added through the API.
// AC1: a fragment shows its records and "1–N of N"; Sort by title ascending gives the order of the
//      fixture; a reload keeps the search, the sort and the page.
// AC2: no match says so in one sentence with "Clear the search"; a slower answer to an older search
//      does not replace a newer one; a new search starts from page 1; the widget has no search.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { registryRecordsPath } from "@openlife/contracts/http/records";
import type { BrowserOwner } from "../support/auth-http.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
test.use({ locale: "en-US" });

const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ records: Array<{ values: Record<string, unknown> }> }> };
const RECORDS = fixture.registries[0]!.records;
const TEXTUAL = ["tytul", "autor", "status"];
const fold = (value: string) => value.normalize("NFC").toLowerCase();
/** The titles of F01 a fragment is in, by the rule of D23.2: any textual column, letter case aside. */
const matching = (fragment: string) => RECORDS.filter((record) => TEXTUAL.some((symbol) => typeof record.values[symbol] === "string" && fold(record.values[symbol] as string).includes(fold(fragment)))).map((record) => record.values["tytul"] as string);

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replace(`{{${name}}}`, String(value)), text(registers, key));
const searchBox = (page: Page) => page.getByRole("searchbox", { name: text(registers, "table.search") });
const sortSelect = (page: Page) => page.getByRole("combobox", { name: text(registers, "table.sort") });
const titles = (page: Page) => page.getByRole("row").getByRole("cell", { name: /^Książka testowa / }).allTextContents();

async function books(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  for (const [index, record] of RECORDS.entries()) await addRecordByApi(page, owner, "ksiazki", record.values, `d23-4-${String(index).padStart(2, "0")}`);
  await page.goto(`${owner.baseUrl}/registers/ksiazki`);
  await expect(page.getByText("1–10 of 25")).toBeVisible();
}

test.describe("D23.4-AC1 search, sort and pages of F01", () => {
  test("a fragment shows its records with the range, Sort by title ascending is the order of the fixture, and a reload keeps the search, the sort and the page", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await expectNoViolations(page);

    const want = matching("testowa 1");
    expect(want.length).toBeGreaterThan(1);
    expect(want.length).toBeLessThanOrEqual(10);
    await searchBox(page).fill("TESTOWA 1");
    await expect(page.getByText(say("table.range", { from: 1, to: want.length, total: want.length }))).toBeVisible();
    expect((await titles(page)).sort()).toEqual([...want].sort());
    await expect(page).toHaveURL(/search=TESTOWA(\+|%20)1/);

    // Sort by title ascending: the titles of the fixture in their own order, page after page.
    await searchBox(page).fill("");
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    await sortSelect(page).selectOption({ label: say("table.sortAsc", { column: "Tytuł" }) });
    const ordered = RECORDS.map((record) => record.values["tytul"] as string).sort();
    await expect.poll(() => titles(page)).toEqual(ordered.slice(0, 10));
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
    await expect.poll(() => titles(page)).toEqual(ordered.slice(10, 20));

    // A search on top of the sort, then a reload: the address holds all of it.
    await searchBox(page).fill("testowa 2");
    const second = matching("testowa 2").sort();
    await expect.poll(() => titles(page)).toEqual(second.slice(0, 10));
    await expect(page).toHaveURL(/sort=tytul/);
    await page.reload();
    await expect(searchBox(page)).toHaveValue("testowa 2");
    await expect(sortSelect(page)).toHaveValue("tytul:asc");
    await expect.poll(() => titles(page)).toEqual(second.slice(0, 10));

    // A page in the address survives the reload too; "back" returns to the page before.
    await searchBox(page).fill("");
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page.getByText("21–25 of 25")).toBeVisible();
    await page.reload();
    await expect(page.getByText("21–25 of 25")).toBeVisible();
    await expect.poll(() => titles(page)).toEqual(ordered.slice(20));
    await page.goBack();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
  });
});

test.describe("D23.4-AC2 no match, a late answer, the first page and the widget", () => {
  test("no match says so with Clear the search; a new search starts from page 1", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
    await searchBox(page).fill("testowa");
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    await expect(page).not.toHaveURL(/page=/);

    await searchBox(page).fill("nie ma takiej");
    await expect(page.getByText(say("table.noMatches", { search: "nie ma takiej" }))).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByText(text(registers, "table.empty_registry"))).toHaveCount(0);
    await expectNoViolations(page);
    await page.getByRole("button", { name: text(registers, "table.clearSearch") }).click();
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    await expect(searchBox(page)).toHaveValue("");
    // The box takes no more than the server does.
    await expect(searchBox(page)).toHaveAttribute("maxlength", "100");
  });

  test("a slower answer to an older search does not replace the answer to the newer one", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    let slowSent = false;
    await page.route(`**${registryRecordsPath("ksiazki")}?*`, async (route) => {
      const asked = new URL(route.request().url()).searchParams.get("search");
      if (asked !== "testowa 1") return route.continue();
      slowSent = true;
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.fulfill({ response });
    });
    await searchBox(page).fill("testowa 1");
    await expect.poll(() => slowSent).toBe(true);
    await searchBox(page).fill("autor testowy 3");
    const want = matching("autor testowy 3").sort();
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThanOrEqual(10);
    await expect.poll(async () => (await titles(page)).sort()).toEqual(want);
    // The older answer arrives after the newer one; the table stays on the newer search.
    await page.waitForTimeout(2_000);
    expect((await titles(page)).sort()).toEqual(want);
    await expect(searchBox(page)).toHaveValue("autor testowy 3");
    await expect(page.getByText(say("table.range", { from: 1, to: want.length, total: want.length }))).toBeVisible();
  });

  test("while the next page loads, the range stays with the rows on screen: never the range of one page over the rows of another", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    const firstPage = await titles(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**${registryRecordsPath("ksiazki")}?*`, async (route) => {
      if (new URL(route.request().url()).searchParams.get("page") !== "2") return route.continue();
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    });
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    // The answer for page 2 is held: the rows are page 1's, and so is the range; the table says it is busy.
    await expect(page.getByRole("region", { name: "Książki" })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    await expect(page.getByText("11–20 of 25")).toHaveCount(0);
    expect(await titles(page)).toEqual(firstPage);
    release();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
    await expect(page.getByRole("region", { name: "Książki" })).not.toHaveAttribute("aria-busy", "true");
    const secondPage = await titles(page);
    expect(secondPage).toHaveLength(10);
    expect(secondPage.some((title) => firstPage.includes(title))).toBe(false);
  });

  test("on a phone the toolbar wraps and the page does not scroll sideways: the wide table scrolls in its own region", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.setViewportSize({ width: 390, height: 844 });
    await books(page, owner);
    // The tests are compiled without the DOM library, so the page is asked in its own words.
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await expect(searchBox(page)).toBeInViewport();
    await expect(page.getByRole("button", { name: text(registers, "record.add"), exact: true })).toBeInViewport();
    const region = page.getByRole("region", { name: "Książki" });
    const [scrollWidth, clientWidth] = await Promise.all([region.evaluate((element) => (element as unknown as { scrollWidth: number }).scrollWidth), region.evaluate((element) => (element as unknown as { clientWidth: number }).clientWidth)]);
    expect(scrollWidth).toBeGreaterThan(clientWidth);
  });

  test("the register widget on /main has no search and no sort", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000d2304", title: "Moje książki", layout: { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } } }]);
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.getByRole("cell", { name: /^Książka testowa / }).first()).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: text(registers, "table.sort") })).toHaveCount(0);
  });
});
