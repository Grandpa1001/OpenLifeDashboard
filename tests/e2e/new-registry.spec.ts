// D16.2 — the form of a new registry in a real browser (Scope §5.5): Książki of F01 is made
// without SQL, the symbol follows the name and is checked as it is typed, and what the server
// refuses is shown at its field with everything typed kept.
// AC1: Książki is created from the form with its nine columns; the symbol offered is the one the
//      plan gives; the created registry is on the list with the columns it was given.
// AC2: a bad symbol, a taken one, a reserved column symbol, a repeated
//      symbol, a missing name and no columns are refused at the field; a double click makes one
//      registry; the keyboard reaches everything; axe.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";

const auth = locale("en", "auth");
const registers = locale("en", "registers");

test.use({ locale: "en-US" });

async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function openRegisters(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page).toHaveURL(`${owner.baseUrl}/main`);
  await page.goto(`${owner.baseUrl}/registers`);
  await page.getByRole("button", { name: text(registers, "list.new") }).click();
}

const registryName = (page: Page) => page.getByLabel(text(registers, "form.name"), { exact: true });
const registrySymbol = (page: Page) => page.getByLabel(text(registers, "form.symbol"), { exact: true });
const column = (page: Page, position: number) => page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", String(position)) });
const create = (page: Page) => page.getByRole("button", { name: text(registers, "form.create") });
const issue = (key: string) => text(registers, `issues.${key}`);

/** One column of the form: the name (the symbol follows it), the type and the rest. */
async function fillColumn(page: Page, position: number, spec: { name: string; type?: string; required?: boolean; decimals?: string; defaultValue?: string; yesNoDefault?: string }): Promise<void> {
  const group = column(page, position);
  await group.getByLabel(text(registers, "form.columnName"), { exact: true }).fill(spec.name);
  if (spec.type !== undefined) await group.getByLabel(text(registers, "form.type"), { exact: true }).selectOption({ label: spec.type });
  if (spec.decimals !== undefined) await group.getByLabel(text(registers, "form.decimalPlaces"), { exact: true }).selectOption(spec.decimals);
  if (spec.defaultValue !== undefined) await group.getByLabel(text(registers, "form.default"), { exact: true }).fill(spec.defaultValue);
  if (spec.yesNoDefault !== undefined) await group.getByLabel(text(registers, "form.default"), { exact: true }).selectOption({ label: spec.yesNoDefault });
  if (spec.required === true) await group.getByLabel(text(registers, "form.required"), { exact: true }).check();
}

const addColumn = (page: Page) => page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
const types = (key: string) => text(registers, `types.${key}`);

test.describe("D16.2-AC1 Książki of F01 from the form", () => {
  test("the symbol follows the name, the nine columns are made, and the registry is created without SQL", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await expect(page.getByRole("heading", { level: 2, name: text(registers, "form.heading") })).toBeFocused();
    await expectNoViolations(page);

    await registryName(page).fill("Książki");
    await expect(registrySymbol(page)).toHaveValue("ksiazki");
    await fillColumn(page, 1, { name: "Tytuł", required: true });
    await expect(column(page, 1).getByLabel(text(registers, "form.columnSymbol"), { exact: true })).toHaveValue("tytul");
    const more: Array<Parameters<typeof fillColumn>[2]> = [
      { name: "Autor" },
      { name: "Liczba stron", type: types("number"), decimals: "0" },
      { name: "Cena", type: types("money") },
      { name: "Data ukończenia", type: types("date") },
      { name: "Rozpoczęto", type: types("datetime") },
      { name: "Godzina przypomnienia", type: types("time") },
      { name: "Ponowne czytanie", type: types("boolean"), yesNoDefault: text(registers, "form.no") },
      { name: "Status", type: types("choice"), defaultValue: "planowane" },
    ];
    for (const [index, spec] of more.entries()) {
      await addColumn(page);
      await fillColumn(page, index + 2, spec);
    }
    await expect(column(page, 4).getByLabel(text(registers, "form.columnSymbol"), { exact: true })).toHaveValue("cena");
    await expect(column(page, 3).getByLabel(text(registers, "form.columnSymbol"), { exact: true })).toHaveValue("liczba_stron");
    // A money column has no default to type here: the conversion of an amount is not the form's job.
    await expect(column(page, 4).getByLabel(text(registers, "form.default"), { exact: true })).toHaveCount(0);
    await expectNoViolations(page);

    await create(page).click();
    await expect(page.getByRole("status")).toHaveText(text(registers, "form.created").replace("{{name}}", "Książki"));
    await expect(page.getByRole("button", { name: text(registers, "list.new") })).toBeFocused();
    const card = page.getByRole("listitem");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("ksiazki");
    await expect(card).toContainText("9 columns");

    // What the server holds is what was typed: the types, the options, the defaults and the flag.
    const response = await page.request.get(`${owner.baseUrl}${REGISTRIES_PATH}`);
    const registry = registryListSchema.parse(await response.json()).registries[0]!;
    expect(registry.columns.map((each) => [each.symbol, each.type, each.required, each.defaultValue, each.typeOptions])).toEqual([
      ["tytul", "text", true, null, {}],
      ["autor", "text", false, null, {}],
      ["liczba_stron", "number", false, null, { decimalPlaces: 0 }],
      ["cena", "money", false, null, {}],
      ["data_ukonczenia", "date", false, null, {}],
      ["rozpoczeto", "datetime", false, null, {}],
      ["godzina_przypomnienia", "time", false, null, {}],
      ["ponowne_czytanie", "boolean", false, false, {}],
      ["status", "choice", false, "planowane", {}],
    ]);
    expect(query(owner.instance, "SELECT name FROM sqlite_master WHERE name = 'reg_ksiazki'")).toHaveLength(1);
  });

  test("the symbol stops following the name once it is typed, and a taken symbol gets a number", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await registryName(page).fill("Książki");
    await registrySymbol(page).fill("moje_ksiazki");
    await registryName(page).fill("Książki i komiksy");
    await expect(registrySymbol(page)).toHaveValue("moje_ksiazki");
    await fillColumn(page, 1, { name: "Tytuł" });
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();

    await page.getByRole("button", { name: text(registers, "list.new") }).click();
    await registryName(page).fill("Moje książki");
    await expect(registrySymbol(page)).toHaveValue("moje_ksiazki_2");
  });

  test("a number with decimals and a text default are sent in the form the API takes", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await registryName(page).fill("Waga");
    await fillColumn(page, 1, { name: "Kilogramy", type: types("number"), decimals: "1", defaultValue: "70,5", required: true });
    await addColumn(page);
    await fillColumn(page, 2, { name: "Uwagi", defaultValue: "brak" });
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();
    const registry = registryListSchema.parse(await (await page.request.get(`${owner.baseUrl}${REGISTRIES_PATH}`)).json()).registries[0]!;
    expect(registry.columns.map((each) => [each.symbol, each.defaultValue, each.typeOptions, each.required])).toEqual([
      ["kilogramy", 70.5, { decimalPlaces: 1 }, true],
      ["uwagi", "brak", {}, false],
    ]);
  });
});

test.describe("D16.2-AC2 what is refused, and what is kept", () => {
  test("a symbol that is wrong is told while it is typed, and nothing is sent until it is right", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    let sent = 0;
    await page.route("**/api/v1/registries", (route) => {
      if (route.request().method() === "POST") sent += 1;
      return route.continue();
    });
    await registryName(page).fill("Test");
    await fillColumn(page, 1, { name: "Pole" });
    for (const bad of ["Ksiazki", "ksiązki", "1abc", "a b", "a__b"]) {
      await registrySymbol(page).fill(bad);
      await expect(page.getByText(issue("SYMBOL_PATTERN"))).toBeVisible();
    }
    await registrySymbol(page).fill("x".repeat(41));
    await expect(page.getByText(issue("SYMBOL_TOO_LONG"))).toBeVisible();
    await create(page).click();
    expect(sent).toBe(0);
    await registrySymbol(page).fill("test");
    await expect(page.getByText(issue("SYMBOL_PATTERN"))).toHaveCount(0);
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();
    expect(sent).toBe(1);
  });

  test("a missing name, a missing symbol and no columns are told at their fields after an attempt, and the form keeps what was typed", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await create(page).click();
    await expect(page.getByText(issue("NAME_EMPTY"))).toHaveCount(2);
    await expect(page.getByText(issue("SYMBOL_EMPTY"))).toHaveCount(2);
    await expect(registryName(page)).toHaveAttribute("aria-invalid", "true");
    await expectNoViolations(page);

    await registryName(page).fill("Tylko nazwa");
    await expect(page.getByText(issue("NAME_EMPTY"))).toHaveCount(1);
    await expect(registryName(page)).toHaveValue("Tylko nazwa");
  });

  test("a symbol that is taken comes back from the server at the field and everything typed stays", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    // The registry is made behind the back of the page: the form cannot know its symbol, and the server says so.
    const made = await page.request.post(`${owner.baseUrl}${REGISTRIES_PATH}`, { data: { symbol: "ksiazki", displayName: "Inne", columns: [{ symbol: "a", displayName: "A", type: "text" }] }, headers: { Origin: owner.baseUrl } });
    expect(made.status()).toBe(201);
    await registryName(page).fill("Książki");
    await fillColumn(page, 1, { name: "Tytuł", required: true });
    await create(page).click();
    await expect(page.getByText(issue("SYMBOL_TAKEN"))).toBeVisible();
    await expect(registrySymbol(page)).toHaveAttribute("aria-invalid", "true");
    await expect(registryName(page)).toHaveValue("Książki");
    await expect(column(page, 1).getByLabel(text(registers, "form.columnName"), { exact: true })).toHaveValue("Tytuł");

    // Typing another symbol clears the refusal, and the same form then creates the registry.
    await registrySymbol(page).fill("ksiazki_moje");
    await expect(page.getByText(issue("SYMBOL_TAKEN"))).toHaveCount(0);
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("a reserved column symbol, a repeated one and a default that does not fit are told at the column", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await registryName(page).fill("Testy");
    await fillColumn(page, 1, { name: "Id" });
    await addColumn(page);
    await fillColumn(page, 2, { name: "Pole" });
    await addColumn(page);
    await fillColumn(page, 3, { name: "Pole" });
    // The third column was given a symbol of its own by the suggestion; a repeat typed by hand is told at once.
    await column(page, 3).getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("pole");
    await expect(column(page, 3).getByText(issue("SYMBOL_TAKEN"))).toBeVisible();
    await column(page, 3).getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("pole_3");
    await addColumn(page);
    await fillColumn(page, 4, { name: "Liczba", type: types("number"), defaultValue: "abc" });
    await expect(column(page, 4).getByText(issue("DEFAULT_INVALID"))).toBeVisible();
    await column(page, 4).getByLabel(text(registers, "form.default"), { exact: true }).fill("12.5");
    await expect(column(page, 4).getByText(issue("DEFAULT_INVALID"))).toHaveCount(0);

    // `id` passes the live check and 12.5 in a number of no decimal places is a value the server refuses: both at their columns.
    await create(page).click();
    await expect(column(page, 1).getByText(issue("SYMBOL_RESERVED"))).toBeVisible();
    await expect(column(page, 4).getByText(issue("DEFAULT_INVALID"))).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await column(page, 4).getByLabel(text(registers, "form.decimalPlaces"), { exact: true }).selectOption("1");
    await expect(column(page, 4).getByText(issue("DEFAULT_INVALID"))).toHaveCount(0);
    await column(page, 1).getByLabel(text(registers, "form.columnSymbol"), { exact: true }).fill("identyfikator");
    await expect(column(page, 1).getByText(issue("SYMBOL_RESERVED"))).toHaveCount(0);
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();
  });

  test("a double click makes one registry; the form is reachable and usable from the keyboard", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await registryName(page).fill("Klawiatura");
    await fillColumn(page, 1, { name: "Pole" });
    await create(page).dblclick();
    await expect(page.getByRole("status")).toBeVisible();
    expect(query(owner.instance, "SELECT 1 FROM registry")).toHaveLength(1);

    // The keyboard: the button opens the form, Tab reaches the fields, Enter in a field submits, Escape-free cancel returns the focus.
    await page.getByRole("button", { name: text(registers, "list.new") }).press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: text(registers, "form.heading") })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(registryName(page)).toBeFocused();
    await page.keyboard.type("Druga");
    await page.keyboard.press("Tab");
    await expect(registrySymbol(page)).toBeFocused();
    await expect(registrySymbol(page)).toHaveValue("druga");
    await page.getByRole("button", { name: text(registers, "form.cancel") }).click();
    await expect(page.getByRole("button", { name: text(registers, "list.new") })).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: text(registers, "form.heading") })).toHaveCount(0);
  });

  test("a server that fails keeps the form and says why; the same form creates the registry once it works", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openRegisters(page, owner);
    await registryName(page).fill("Awaria");
    await fillColumn(page, 1, { name: "Pole", required: true });
    await page.route("**/api/v1/registries", (route) => (route.request().method() === "POST" ? route.abort("connectionreset") : route.continue()));
    await create(page).click();
    await expect(page.getByRole("alert")).toContainText(text(locale("en", "errors"), "NETWORK"));
    await expect(registryName(page)).toHaveValue("Awaria");
    await page.unroute("**/api/v1/registries");
    await create(page).click();
    await expect(page.getByRole("status")).toBeVisible();
    expect(query(owner.instance, "SELECT 1 FROM registry")).toHaveLength(1);
  });
});
