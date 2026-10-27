// D16.3 — the records of a registry in a real browser (Scope §5.6, §6.2): Książki and its first
// record without SQL, the pages of 25 records, and the window that adds one.
// AC1: the first record is added from the window, shown after the server's answer with its values
//      read by their types, and the amount and the date-time reach the server in the canonical
//      form; 25 records are 10/10/5 with the count.
// AC2: a record without the title leaves the window open with the message at the field; a repeat
//      after a lost answer is not a second record; a changed schema is told and nothing typed is
//      lost; an ended session leads to the sign-in; the keyboard and axe.
import { recordPageSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import type { Page } from "@playwright/test";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const errors = locale("en", "errors");

test.use({ locale: "en-US" });

const RECORDS = registryRecordsPath("ksiazki");
const dialog = (page: Page) => page.getByRole("dialog", { name: text(registers, "record.add") });
const addButton = (page: Page) => page.getByRole("button", { name: text(registers, "record.add"), exact: true });
const field = (page: Page, label: string) => dialog(page).getByLabel(label);
const save = (page: Page) => dialog(page).getByRole("button", { name: text(registers, "record.save") });
const rows = (page: Page) => page.getByRole("row");

async function openBooks(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await page.goto(`${owner.baseUrl}/registers`);
  await page.getByRole("link", { name: "Książki" }).click();
  await expect(page).toHaveURL(`${owner.baseUrl}/registers/ksiazki`);
}

const stored = (owner: BrowserOwner) => query<Record<string, unknown>>(owner.instance, "SELECT * FROM reg_ksiazki ORDER BY created_at, id");

test.describe("D16.3-AC1 the first record and the pages", () => {
  test("Książki and its first record come out of the browser alone: the window, the answer of the server, the values read by their types", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Książki");
    await expect(page.getByText(text(registers, "table.empty_registry"))).toBeVisible();
    await expectNoViolations(page);

    await addButton(page).click();
    await expect(dialog(page)).toBeVisible();
    // A field for every column; the required one is marked; the defaults of the catalog are in place.
    await expect(dialog(page).locator("input, select")).toHaveCount(9);
    await expect(dialog(page).getByText(`(${text(registers, "record.required")})`)).toHaveCount(1);
    await expect(field(page, "Status")).toHaveValue("planowane");
    await expect(field(page, "Ponowne czytanie")).toHaveValue("false");
    await expectNoViolations(page);

    await field(page, "Tytuł").fill("Diuna");
    await field(page, "Autor").fill("Frank Herbert");
    await field(page, "Liczba stron").fill("412");
    await field(page, "Cena").fill("39,99");
    await field(page, "Data ukończenia").fill("2026-02-03");
    await field(page, "Rozpoczęto").fill("2026-07-15T12:00");
    await field(page, "Godzina przypomnienia").fill("18:30");
    await field(page, "Ponowne czytanie").selectOption({ label: text(registers, "record.yes") });
    await save(page).click();

    // The window closes only after the server has answered, and the table shows what the database holds.
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(text(registers, "record.added"));
    await expect(addButton(page)).toBeFocused();
    await expect(rows(page)).toHaveCount(2);
    const cells = rows(page).nth(1).getByRole("cell");
    await expect(cells).toHaveText(["Diuna", "Frank Herbert", "412", "39.99", "Feb 3, 2026", /^Jul 15, 2026,? 12:00/, "18:30", "Yes", "planowane"]);
    await expect(page.getByText("Page 1 of 1")).toBeVisible();
    await expect(page.getByText("1 record in total")).toBeVisible();
    await expectNoViolations(page);

    // The amount is in grosze and the date-time is the instant of the wall of Warsaw, in UTC.
    expect(stored(owner)).toMatchObject([{ tytul: "Diuna", cena: 3999, strony: 412, rozpoczeto: "2026-07-15T10:00:00.000Z", data_ukonczenia: "2026-02-03", przypomnienie: "18:30", ponowne_czytanie: 1, status: "planowane" }]);
  });

  test("25 records are three pages of 10, 10 and 5 with the count, the newest first", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    for (let index = 1; index <= 25; index += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${String(index).padStart(2, "0")}` }, `seed-key-${String(index).padStart(3, "0")}`);
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);

    const titles = async () => (await rows(page).getByRole("cell", { name: /^Książka / }).allTextContents()).map((title) => title);
    await expect(page.getByText("Page 1 of 3")).toBeVisible();
    await expect(page.getByText("25 records in total")).toBeVisible();
    expect(await titles()).toEqual(Array.from({ length: 10 }, (_, index) => `Książka ${String(25 - index).padStart(2, "0")}`));
    await expect(page.getByRole("button", { name: text(registers, "table.previous") })).toBeDisabled();

    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page.getByText("Page 2 of 3")).toBeVisible();
    expect(await titles()).toEqual(Array.from({ length: 10 }, (_, index) => `Książka ${String(15 - index).padStart(2, "0")}`));
    await page.getByRole("button", { name: text(registers, "table.next") }).click();
    await expect(page.getByText("Page 3 of 3")).toBeVisible();
    expect(await titles()).toEqual(["05", "04", "03", "02", "01"].map((number) => `Książka ${number}`));
    await expect(page.getByRole("button", { name: text(registers, "table.next") })).toBeDisabled();
    await expectNoViolations(page);

    // A new record goes to the first page, where the newest is.
    await addButton(page).click();
    await field(page, "Tytuł").fill("Nowa");
    await save(page).click();
    await expect(page.getByText("Page 1 of 3")).toBeVisible();
    await expect(page.getByText("26 records in total")).toBeVisible();
    expect(await rows(page).nth(1).getByRole("cell").first().textContent()).toBe("Nowa");
  });

  test("values are text: markup in a title is shown as it is and runs nothing", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    const hostile = `<img src=x onerror="globalThis.__ran=1"><b>bold</b>`;
    await addButton(page).click();
    await field(page, "Tytuł").fill(hostile);
    await save(page).click();
    await expect(rows(page).nth(1).getByRole("cell").first()).toHaveText(hostile);
    expect(await page.locator("main img, main b").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(globalThis, "__ran"))).toBeUndefined();
  });
});

test.describe("D16 the parent: from nothing to a record, in the browser alone", () => {
  test("a registry from the form, its card, its first record in the window, and the record in the table after a reload", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await page.getByRole("link", { name: text(locale("en"), "main.registers") }).click();
    await page.getByRole("button", { name: text(registers, "list.new") }).click();
    await page.getByLabel(text(registers, "form.name"), { exact: true }).fill("Książki");
    const first = page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "1") });
    await first.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Tytuł");
    await first.getByLabel(text(registers, "form.required"), { exact: true }).check();
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "2") }).getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Autor");
    await page.getByRole("button", { name: text(registers, "form.create") }).click();
    await page.getByRole("link", { name: "Książki" }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/registers/ksiazki`);

    await addButton(page).click();
    await save(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_REQUIRED"))).toBeVisible();
    await field(page, "Tytuł").fill("Pierwsza książka");
    await field(page, "Autor").fill("Ja");
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.reload();
    await expect(rows(page).nth(1).getByRole("cell")).toHaveText(["Pierwsza książka", "Ja"]);
    expect(stored(owner)).toHaveLength(1);
  });
});

test.describe("D16.3-AC2 what is refused, lost and changed", () => {
  test("no title: the window stays open with the message at the field, everything typed stays, nothing is stored; the title then saves", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Autor").fill("Ktoś");
    await field(page, "Liczba stron").fill("10");
    await save(page).click();
    await expect(field(page, "Tytuł")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_REQUIRED"))).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await expect(field(page, "Autor")).toHaveValue("Ktoś");
    await expect(field(page, "Liczba stron")).toHaveValue("10");
    expect(stored(owner)).toEqual([]);
    await expectNoViolations(page);

    // White space is no title either.
    await field(page, "Tytuł").fill("   ");
    await save(page).click();
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_REQUIRED"))).toBeVisible();

    await field(page, "Tytuł").fill("Jest tytuł");
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_REQUIRED"))).toHaveCount(0);
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(stored(owner)).toMatchObject([{ tytul: "Jest tytuł", autor: "Ktoś", strony: 10 }]);
  });

  test("a value that is no value of its type is told at the field without a request; one the server refuses is told there too", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    let posts = 0;
    await page.route(`**${RECORDS}`, (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.continue();
    });
    await addButton(page).click();
    await field(page, "Tytuł").fill("Test");
    await field(page, "Cena").fill("dziesięć");
    await save(page).click();
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_INVALID"))).toBeVisible();
    expect(posts).toBe(0);
    await field(page, "Cena").fill("10,375");
    await save(page).click();
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_INVALID"))).toBeVisible();
    expect(posts).toBe(0);
    await field(page, "Cena").fill("10,37");
    // 1.5 pages in a column of no decimal places parses, and is the server's to refuse.
    await field(page, "Liczba stron").fill("1,5");
    await save(page).click();
    await expect(dialog(page).getByText(text(registers, "recordIssues.VALUE_INVALID"))).toBeVisible();
    expect(posts).toBe(1);
    expect(stored(owner)).toEqual([]);
    await field(page, "Liczba stron").fill("2");
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(stored(owner)).toMatchObject([{ cena: 1037, strony: 2 }]);
  });

  test("a response lost after the commit: the repeat is the same record, not a second", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Raz");
    // The server commits and answers; the page never hears it.
    await page.route(`**${RECORDS}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      return route.abort("connectionreset");
    });
    await save(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(text(errors, "NETWORK"));
    expect(stored(owner)).toHaveLength(1);
    await expect(dialog(page)).toBeVisible();

    await page.unroute(`**${RECORDS}`);
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(stored(owner)).toHaveLength(1);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByText("1 record in total")).toBeVisible();
    expect(query(owner.instance, "SELECT 1 FROM idempotency_entry")).toHaveLength(1);

    // A second attempt with a changed value is a request of its own, with its own key.
    await addButton(page).click();
    await field(page, "Tytuł").fill("Dwa");
    await save(page).click();
    await expect(page.getByText("2 records in total")).toBeVisible();
    expect(query(owner.instance, "SELECT 1 FROM idempotency_entry")).toHaveLength(2);
  });

  test("a changed value after a lost answer gets a new key: nothing is replayed with the old body", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Pierwsza wersja");
    await page.route(`**${RECORDS}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      return route.abort("connectionreset");
    });
    await save(page).click();
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await page.unroute(`**${RECORDS}`);
    await field(page, "Tytuł").fill("Druga wersja");
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    // The first attempt was committed; the changed one is another request and another record, never a conflict.
    expect(stored(owner).map((row) => row["tytul"])).toEqual(["Pierwsza wersja", "Druga wersja"]);
  });

  test("a registry that changed since the window was opened is told, the definition is asked for again and nothing typed is lost", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Zmieniony schemat");
    await field(page, "Autor").fill("Ktoś");
    let definitionRequests = 0;
    await page.route("**/api/v1/registries", (route) => {
      definitionRequests += 1;
      return route.continue();
    });
    await page.route(`**${RECORDS}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "SCHEMA_CHANGED", message: "x", details: null, requestId: "req-schema-1" }) })
        : route.continue(),
    );
    await save(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(text(errors, "SCHEMA_CHANGED"));
    await expect(dialog(page).getByRole("alert")).toContainText("req-schema-1");
    await expect.poll(() => definitionRequests).toBeGreaterThan(0);
    await expect(field(page, "Tytuł")).toHaveValue("Zmieniony schemat");
    await expect(field(page, "Autor")).toHaveValue("Ktoś");
    expect(stored(owner)).toEqual([]);

    await page.unroute(`**${RECORDS}`);
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(stored(owner)).toMatchObject([{ tytul: "Zmieniony schemat", autor: "Ktoś" }]);
  });

  test("a session that ended while the window was open leads to the sign-in", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Bez sesji");
    await context.clearCookies();
    await save(page).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    expect(stored(owner)).toEqual([]);
  });

  test("a failing server keeps the window and the values; the same window saves once it works", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Awaria");
    await page.route(`**${RECORDS}`, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "INTERNAL_ERROR", message: "SQLSTATE[23000] secret", details: null, requestId: "req-rec-1" }) })
        : route.continue(),
    );
    await save(page).click();
    await expect(dialog(page).getByRole("alert")).toContainText(text(errors, "INTERNAL_ERROR"));
    await expect(dialog(page).getByRole("alert")).toContainText("req-rec-1");
    expect(await page.content()).not.toContain("SQLSTATE");
    await expect(field(page, "Tytuł")).toHaveValue("Awaria");
    await page.unroute(`**${RECORDS}`);
    await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(stored(owner)).toHaveLength(1);
  });

  test("Escape and Cancel close the window without adding anything, and the focus returns to the button", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openBooks(page, owner);
    await addButton(page).click();
    await field(page, "Tytuł").fill("Nie zapisuj");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    await addButton(page).press("Enter");
    await expect(field(page, "Tytuł")).toHaveValue("");
    await dialog(page).getByRole("button", { name: text(registers, "record.cancel") }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    expect(stored(owner)).toEqual([]);
  });

  test("a registry that does not exist, and the gate: no session leads to the sign-in", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect(page).toHaveURL(`${owner.baseUrl}/login`);
    await signInFully(page, owner);
    await page.goto(`${owner.baseUrl}/registers/nie_ma`);
    await expect(page.getByRole("alert")).toHaveText(text(registers, "registry.notFound"));
    await expect(addButton(page)).toHaveCount(0);
    const reply = await page.request.get(`${owner.baseUrl}${registryRecordsPath("nie_ma")}`);
    expect(reply.status()).toBe(404);
    expect(recordPageSchema.safeParse(await reply.json()).success).toBe(false);
  });
});
