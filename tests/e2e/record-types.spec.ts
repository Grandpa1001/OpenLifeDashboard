// D22.3 — every column type through the window of a record in a real browser (Scope §5.6, §6.2,
// makieta 08), against F01: what is typed in the window is stored in the canonical form of the
// fixture, and the table reads it back by type in the owner's language and zone.
// AC1: the 25 records of F01 with all nine columns, typed into the window one by one, are stored
//      exactly as the fixture holds them and list as 10/10/5 in the order of the expected file,
//      with 1037 as 10.37 and a date-time on the wall of Warsaw.
// AC2: an unfinished date and date-time, an amount with three places and one beyond the safe range
//      are told at their fields without a request.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { registryRecordsPath } from "@openlife/contracts/http/records";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { shownDateTime } from "../support/shown-date.ts";
import { repoRoot } from "../support/server-process.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { createRegistry, expectNoViolations, signInFully } from "./owner-session.ts";
import { withoutDictionary } from "../support/books-fixture.ts";

const registers = locale("en", "registers");
test.use({ locale: "en-US" });

type Cell = string | number | boolean | null;
type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: Record<string, unknown>; defaultValue: Cell; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ createdAt: string; values: Record<string, Cell> }> }>;
};
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { pageTitles: string[][] };
const BOOKS = fixture.registries[0]!;
const RECORDS_IN_ORDER = [...BOOKS.records].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const OWNER_ZONE = "Europe/Warsaw";

const dialog = (page: Page) => page.getByRole("dialog", { name: text(registers, "record.add") });
const field = (page: Page, label: string) => dialog(page).getByLabel(label);
const save = (page: Page) => dialog(page).getByRole("button", { name: text(registers, "record.save") });
const addButton = (page: Page) => page.getByRole("button", { name: text(registers, "record.add"), exact: true });

/** An ISO UTC instant as the wall of the owner's zone, `YYYY-MM-DDTHH:mm`, as a datetime-local field takes it. */
function wall(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** What the owner types for a stored value: the amount in units, the date-time on their wall, nothing for null. */
function typed(column: FixtureColumn, value: Cell): string {
  if (value === null) return "";
  switch (column.type) {
    case "money": {
      const cents = value as number;
      return `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    }
    case "datetime":
      return wall(value as string);
    case "boolean":
      return value === true ? "true" : "false";
    default:
      return String(value);
  }
}

async function openBooks(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, {
    symbol: BOOKS.symbol,
    displayName: BOOKS.displayName,
    columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })),
  });
  await page.goto(`${owner.baseUrl}/registers/${BOOKS.symbol}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(BOOKS.displayName);
}

test.describe("D22.3-AC1 the 25 records of F01 typed into the window", () => {
  test("every column of every record is stored as F01 holds it, and the table reads the values back by type", async ({ page, ownerServer }) => {
    test.setTimeout(180_000);
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    // The columns at a glance: name · type, the places of a number, the required one marked (makieta 08).
    await expect(page.getByRole("region", { name: text(registers, "registry.columns") }).getByRole("listitem")).toHaveCount(BOOKS.columns.length);

    for (const record of RECORDS_IN_ORDER) {
      await addButton(page).click();
      await expect(dialog(page)).toBeVisible();
      for (const column of BOOKS.columns) {
        const input = field(page, column.displayName);
        const value = typed(column, record.values[column.symbol] ?? null);
        if (column.type === "boolean") await input.selectOption(value);
        else await input.fill(value);
      }
      await save(page).click();
      await expect(dialog(page)).toHaveCount(0);
    }

    // What the database holds is the fixture, value for value, in the canonical form.
    const stored = query<Record<string, unknown>>(owner.instance, `SELECT * FROM reg_${BOOKS.symbol} ORDER BY created_at, id`);
    expect(stored).toHaveLength(25);
    stored.forEach((row, index) => {
      const values = RECORDS_IN_ORDER[index]!.values;
      for (const column of BOOKS.columns) {
        const want = values[column.symbol] ?? null;
        const got = row[column.symbol] ?? null;
        expect(column.type === "boolean" && got !== null ? got === 1 : column.type === "datetime" && got !== null ? new Date(got as string).toISOString() : got, `${index + 1} ${column.symbol}`).toEqual(
          column.type === "datetime" && want !== null ? new Date(want as string).toISOString() : want,
        );
      }
    });

    // The pages are those of the expected file, and the values are read by type in the owner's language and zone.
    const titles = async () => page.getByRole("row").getByRole("cell", { name: /^Książka testowa / }).allTextContents();
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    expect(await titles()).toEqual(expected.pageTitles[0]);
    const firstOnPage = RECORDS_IN_ORDER[24]!.values;
    const cells = page.getByRole("row").nth(1).getByRole("cell");
    await expect(cells.nth(3)).toHaveText(`${Math.trunc((firstOnPage["cena"] as number) / 100)}.${String((firstOnPage["cena"] as number) % 100).padStart(2, "0")}`);
    for (const pageTitles of expected.pageTitles.slice(1)) {
      await page.getByRole("button", { name: text(registers, "table.next") }).click();
      await expect.poll(titles).toEqual(pageTitles);
    }
    await expect(page.getByText("21–25 of 25")).toBeVisible();
    await expectNoViolations(page);

    // The first record of F01 (1037 grosze) and one with a date-time, as the table shows them.
    const recordWithTime = RECORDS_IN_ORDER.find((each) => each.values["rozpoczeto"] !== null)!;
    const timeTitle = recordWithTime.values["tytul"] as string;
    const pageOf = expected.pageTitles.findIndex((titlesOfPage) => titlesOfPage.includes(timeTitle));
    // Each click waits for the page it asked for: a click before the page shows its rows would ask for the same page again.
    await page.getByRole("button", { name: text(registers, "table.previous") }).click();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
    await page.getByRole("button", { name: text(registers, "table.previous") }).click();
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    for (let at = 0; at < pageOf; at += 1) {
      await page.getByRole("button", { name: text(registers, "table.next") }).click();
      await expect.poll(titles).toEqual(expected.pageTitles[at + 1]);
    }
    const timeRow = page.getByRole("row").filter({ hasText: timeTitle });
    const shownTime = shownDateTime(recordWithTime.values["rozpoczeto"] as string, OWNER_ZONE);
    await expect(timeRow.getByRole("cell").nth(5)).toHaveText(shownTime);
    expect(RECORDS_IN_ORDER[0]!.values["cena"]).toBe(1037);
  });
});

test.describe("D22.3-AC2 what the window refuses before sending", () => {
  test("an unfinished date and date-time, an amount with three places and one beyond the safe range are told at their fields, and nothing is sent", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    let posts = 0;
    await page.route(`**${registryRecordsPath(BOOKS.symbol)}`, (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.continue();
    });
    await addButton(page).click();
    await expect(dialog(page).getByRole("heading", { level: 2 })).toHaveText(text(registers, "record.addTo").replace("{{name}}", BOOKS.displayName));
    await field(page, "Tytuł").fill("Niedokończona");
    // Only the date of the date-time is typed: the browser holds an entry it cannot read, whose value is empty.
    await field(page, "Rozpoczęto").click();
    await page.keyboard.type("03152026");
    await field(page, "Data ukończenia").click();
    await page.keyboard.type("0315");
    await save(page).click();
    const invalid = text(registers, "recordIssues.VALUE_INVALID");
    await expect(dialog(page).getByText(invalid)).toHaveCount(2);
    expect(posts).toBe(0);

    await field(page, "Rozpoczęto").fill("2026-03-15T09:30");
    await field(page, "Data ukończenia").fill("2026-03-15");
    for (const amount of ["10,375", "90071992547409,92"]) {
      await field(page, "Cena").fill(amount);
      await save(page).click();
      await expect(dialog(page).getByText(invalid)).toHaveCount(1);
      expect(posts).toBe(0);
    }
    await field(page, "Cena").fill("90071992547409,91");
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toBe(1);
    expect(query<Record<string, unknown>>(owner.instance, `SELECT cena, rozpoczeto, data_ukonczenia FROM reg_${BOOKS.symbol}`)).toEqual([
      { cena: Number.MAX_SAFE_INTEGER, rozpoczeto: "2026-03-15T08:30:00.000Z", data_ukonczenia: "2026-03-15" },
    ]);
  });
});
