// D24.3 — dictionaries in a real browser (Scope §5.5, §5.8, §6.2, makieta 22, S7) on the dictionary
// of F01 (`status_czytania`: four values, `archiwalne` hidden) and a Książki that shows its Status
// through it. Two tabs are two pages of one session, as a second open tab would be.
// AC1: S7 without SQL: the dictionary is made on /dictionaries, the registry with a column that uses
//      it in the kreator, and a record chosen from the list in its window; the table and the widget
//      show "Planowane"; after the dictionary is deleted both show the raw `planowane` and the
//      records are byte for byte the same; a hidden value is not offered for a new record but is
//      shown by its label.
// AC2: the order changed with the keyboard and by dragging is saved; removing a value asks first
//      and tells what the records will show; a save from a second tab is a conflict that loses
//      nothing typed; editing a record whose value is hidden or unknown keeps it; on a phone the page
//      does not scroll sideways; keyboard; axe.
import type { Page } from "@playwright/test";
import { DICTIONARIES_PATH, dictionaryListSchema } from "@openlife/contracts/http/dictionaries";
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replace(`{{${name}}}`, String(value)), text(registers, key));
const F01_VALUES = [
  { symbol: "planowane", label: "Planowane", hidden: false },
  { symbol: "w_trakcie", label: "W trakcie", hidden: false },
  { symbol: "ukonczone", label: "Ukończone", hidden: false },
  { symbol: "archiwalne", label: "Archiwalne", hidden: true },
];
const WIDGET_LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } };

const row = (page: Page, title: string) => page.getByRole("row").filter({ hasText: title });
const editor = (page: Page) => page.getByRole("region", { name: "Status czytania" });
const handle = (page: Page, name: string) => editor(page).getByRole("button", { name: new RegExp(`^${say("dictionaries.editor.move", { name, position: "X", count: "Y" }).split(" (")[0]} \\(`) });
const labelsInEditor = async (page: Page) => editor(page).getByRole("textbox", { name: /^Label of item / }).evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value));
const saveButton = (page: Page) => editor(page).getByRole("button", { name: text(registers, "dictionaries.editor.save") });
const recordDialog = (page: Page, key: "record.addTo" | "record.editOf") => page.getByRole("dialog", { name: say(key, { name: "Książki" }) });

type Stored = { id: string; tytul: string; status: string | null; revision: number; updated_at: string };
const stored = (owner: BrowserOwner) => query<Stored>(owner.instance, "SELECT id, tytul, status, revision, updated_at FROM reg_ksiazki ORDER BY created_at, id");

async function dictionaries(page: Page, owner: BrowserOwner) {
  return dictionaryListSchema.parse(await (await page.request.get(`${owner.baseUrl}${DICTIONARIES_PATH}`)).json()).dictionaries;
}

/** The dictionary of F01 and Książki whose Status uses it, through the API, with three records: one of each kind the dictionary knows of. */
async function booksWithDictionary(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  const made = await page.request.post(`${owner.baseUrl}${DICTIONARIES_PATH}`, { data: { symbol: "status_czytania", displayName: "Status czytania", values: F01_VALUES }, headers: { Origin: owner.baseUrl } });
  expect(made.status()).toBe(201);
  const id = ((await made.json()) as { id: string }).id;
  await createRegistry(page, owner, { ...BOOKS_DEFINITION, columns: BOOKS_DEFINITION.columns.map((column) => (column.symbol === "status" ? { ...column, typeOptions: { dictionaryId: id } } : column)) });
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Diuna", status: "w_trakcie" }, "d24-3-diuna");
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris", status: "archiwalne" }, "d24-3-solaris");
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Lalka", status: "spoza_slownika" }, "d24-3-lalka");
}

test.describe("D24.3-AC1 S7 in the browser without SQL", () => {
  test("a dictionary made on /dictionaries labels the table and the widget; deleted, both show the raw symbol and the records stay the same; a hidden value is not offered but is shown", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);

    // From the registers to the dictionaries, as makieta 06 has it.
    await page.goto(`${owner.baseUrl}/registers`);
    await expect(page.getByRole("heading", { name: text(registers, "list.config") })).toBeVisible();
    await page.getByRole("link", { name: text(registers, "dictionaries.title") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/dictionaries`);
    await expect(page.getByText(text(registers, "dictionaries.empty"))).toBeVisible();

    // The dictionary of F01: the name offers the symbol; the values are added and one is hidden.
    await page.getByRole("button", { name: text(registers, "dictionaries.new.open") }).click();
    await expect(page.getByRole("heading", { name: text(registers, "dictionaries.new.heading") })).toBeFocused();
    await page.getByLabel(text(registers, "dictionaries.new.name"), { exact: true }).fill("Status czytania");
    await expect(page.getByLabel(text(registers, "form.symbol"), { exact: true })).toHaveValue("status_czytania");
    await page.getByRole("button", { name: text(registers, "dictionaries.new.create") }).click();
    await expect(page.getByRole("status")).toHaveText(say("dictionaries.done.created", { name: "Status czytania" }));
    await expect(page).toHaveURL(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    for (const [index, value] of F01_VALUES.entries()) {
      await editor(page).getByRole("button", { name: text(registers, "dictionaries.editor.add") }).click();
      const label = editor(page).getByLabel(say("dictionaries.editor.labelOf", { position: index + 1 }), { exact: true });
      await expect(label).toBeFocused();
      await label.fill(value.label);
      await expect(editor(page).getByLabel(say("dictionaries.editor.symbolOf", { position: index + 1 }), { exact: true })).toHaveValue(value.symbol);
    }
    await editor(page).getByLabel(say("dictionaries.editor.hiddenOf", { name: "Archiwalne" }), { exact: true }).check();
    await expectNoViolations(page);
    await saveButton(page).click();
    await expect(page.getByRole("status")).toHaveText(say("dictionaries.done.saved", { name: "Status czytania" }));
    // Saved, the symbols are fixed: no field for them any more.
    await expect(editor(page).getByRole("textbox", { name: /^Symbol of item / })).toHaveCount(0);
    const [dictionary] = await dictionaries(page, owner);
    expect(dictionary).toMatchObject({ symbol: "status_czytania", revision: 2, values: F01_VALUES, usages: [] });
    await expect(page.getByRole("link", { name: /Status czytania/ })).toContainText("4 values");

    // Książki in the kreator, its Status shown through the dictionary.
    await page.goto(`${owner.baseUrl}/registers`);
    await page.getByRole("button", { name: text(registers, "list.new") }).click();
    await page.getByLabel(text(registers, "form.name"), { exact: true }).fill("Książki");
    const first = page.getByRole("group", { name: say("form.column", { position: 1 }) });
    await first.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Tytuł");
    await first.getByLabel(text(registers, "form.required"), { exact: true }).check();
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    const second = page.getByRole("group", { name: say("form.column", { position: 2 }) });
    await second.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Status");
    await expect(second.getByLabel(say("form.dictionaryOf", { position: 2 }), { exact: true })).toHaveCount(0);
    await second.getByLabel(text(registers, "form.type"), { exact: true }).selectOption({ label: text(registers, "types.choice") });
    await second.getByLabel(say("form.dictionaryOf", { position: 2 }), { exact: true }).selectOption({ label: "Status czytania" });
    await page.getByRole("button", { name: text(registers, "form.create") }).click();
    await expect(page.getByRole("status")).toHaveText(say("form.created", { name: "Książki" }));
    const registry = registryListSchema.parse(await (await page.request.get(`${owner.baseUrl}${REGISTRIES_PATH}`)).json()).registries[0]!;
    expect(registry.columns.map((column) => [column.symbol, column.type, column.typeOptions])).toEqual([
      ["tytul", "text", {}],
      ["status", "choice", { dictionaryId: dictionary!.id }],
    ]);

    // A record from the window: the list offers the visible values in order, not the hidden one.
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await page.getByRole("button", { name: text(registers, "record.add"), exact: true }).click();
    const status = recordDialog(page, "record.addTo").getByLabel("Status");
    await expect(status.getByRole("option")).toHaveText([text(registers, "record.none"), "Planowane", "W trakcie", "Ukończone"]);
    await recordDialog(page, "record.addTo").getByLabel(/^Tytuł/).fill("Diuna");
    await status.selectOption({ label: "Planowane" });
    await recordDialog(page, "record.addTo").getByRole("button", { name: text(registers, "record.save") }).click();
    await expect(recordDialog(page, "record.addTo")).toHaveCount(0);
    await expect(row(page, "Diuna")).toContainText("Planowane");
    expect(stored(owner).map((each) => [each.tytul, each.status])).toEqual([["Diuna", "planowane"]]);

    // The hidden value of a record is still shown by its label, in the table and in the widget.
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris", status: "archiwalne" }, "d24-3-solaris");
    await page.reload();
    await expect(row(page, "Solaris")).toContainText("Archiwalne");
    await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000d2431", title: "Moje książki", columns: ["tytul", "status"], layout: WIDGET_LAYOUT }]);
    await page.goto(`${owner.baseUrl}/main`);
    await expect(row(page, "Diuna")).toContainText("Planowane");
    await expect(row(page, "Solaris")).toContainText("Archiwalne");
    const before = stored(owner);

    // Deleting the dictionary names the column it unpins; the records keep their values.
    await page.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    await expect(page.getByRole("link", { name: /Status czytania/ })).toContainText("1 column");
    await editor(page).getByRole("button", { name: text(registers, "dictionaries.delete.open") }).click();
    const question = page.getByRole("dialog", { name: say("dictionaries.delete.question", { name: "Status czytania" }) });
    await expect(question.getByRole("list", { name: text(registers, "dictionaries.delete.columns") })).toHaveText("Książki · Status");
    await expectNoViolations(page);
    await question.getByRole("button", { name: text(registers, "dictionaries.delete.confirm") }).click();
    await expect(page.getByRole("status")).toHaveText(`${say("dictionaries.done.deleted", { name: "Status czytania" })} ${say("dictionaries.done.unpinned", { columns: "Książki · Status" })}`);
    await expect(page.getByText(text(registers, "dictionaries.empty"))).toBeVisible();
    await expect(page).toHaveURL(`${owner.baseUrl}/dictionaries`);

    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect(row(page, "Diuna")).toContainText("planowane");
    await expect(row(page, "Diuna")).not.toContainText("Planowane");
    await expect(row(page, "Solaris")).toContainText("archiwalne");
    await page.goto(`${owner.baseUrl}/main`);
    await expect(row(page, "Diuna")).toContainText("planowane");
    await expect(row(page, "Diuna")).not.toContainText("Planowane");
    expect(stored(owner)).toEqual(before);
  });
});

test.describe("D24.3-AC2 the editor, a second tab and the records", () => {
  test("the order changed with the keyboard and by dragging is saved, and the window of a record offers that order", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithDictionary(page, owner);
    await page.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    await expect(handle(page, "Ukończone")).toBeVisible();

    // The keyboard: the arrows on the handle move the value one place, and the handle keeps the focus.
    await handle(page, "Ukończone").focus();
    await page.keyboard.press("ArrowUp");
    await expect(handle(page, "Ukończone")).toBeFocused();
    await expect(handle(page, "Ukończone")).toHaveAccessibleName(say("dictionaries.editor.move", { name: "Ukończone", position: 2, count: 4 }));
    await expect.poll(() => labelsInEditor(page)).toEqual(["Planowane", "Ukończone", "W trakcie", "Archiwalne"]);
    await page.keyboard.press("Home");
    await expect.poll(() => labelsInEditor(page)).toEqual(["Ukończone", "Planowane", "W trakcie", "Archiwalne"]);
    await expect(page.getByText(say("dictionaries.editor.movedTo", { label: "Ukończone", position: 1, count: 4 }))).toBeAttached();

    // Dragging: the handle of Archiwalne dropped on the second row takes its place.
    await handle(page, "Archiwalne").dragTo(editor(page).locator("[data-value-row]").nth(1));
    await expect.poll(() => labelsInEditor(page)).toEqual(["Ukończone", "Archiwalne", "Planowane", "W trakcie"]);
    await saveButton(page).click();
    await expect(page.getByRole("status")).toHaveText(say("dictionaries.done.saved", { name: "Status czytania" }));
    const [saved] = await dictionaries(page, owner);
    expect(saved!.values.map((value) => value.symbol)).toEqual(["ukonczone", "archiwalne", "planowane", "w_trakcie"]);
    expect(saved!.revision).toBe(2);

    // A reload reads the saved order.
    await page.reload();
    await expect.poll(() => labelsInEditor(page)).toEqual(["Ukończone", "Archiwalne", "Planowane", "W trakcie"]);
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await page.getByRole("button", { name: text(registers, "record.add"), exact: true }).click();
    await expect(recordDialog(page, "record.addTo").getByLabel("Status").getByRole("option")).toHaveText([text(registers, "record.none"), "Ukończone", "Planowane", "W trakcie"]);
  });

  test("removing a value asks first and tells what the records will show; saved, the records keep the value and show its symbol", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithDictionary(page, owner);
    await page.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    const remove = editor(page).getByRole("button", { name: say("dictionaries.editor.remove", { name: "W trakcie" }) });
    const question = page.getByRole("dialog", { name: say("dictionaries.removeValue.question", { label: "W trakcie" }) });

    await remove.click();
    await expect(question).toContainText(say("dictionaries.removeValue.effect", { symbol: "w_trakcie" }));
    await expect(question.getByRole("button", { name: text(registers, "record.cancel") })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(handle(page, "W trakcie")).toBeFocused();
    await expect.poll(() => labelsInEditor(page)).toEqual(["Planowane", "W trakcie", "Ukończone", "Archiwalne"]);

    await remove.click();
    await question.getByRole("button", { name: text(registers, "dictionaries.removeValue.confirm") }).click();
    await expect.poll(() => labelsInEditor(page)).toEqual(["Planowane", "Ukończone", "Archiwalne"]);
    // Nothing is stored before the save.
    expect((await dictionaries(page, owner))[0]!.values).toHaveLength(4);
    await saveButton(page).click();
    await expect(page.getByRole("status")).toHaveText(say("dictionaries.done.saved", { name: "Status czytania" }));
    expect((await dictionaries(page, owner))[0]!.values.map((value) => value.symbol)).toEqual(["planowane", "ukonczone", "archiwalne"]);

    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect(row(page, "Diuna")).toContainText("w_trakcie");
    expect(stored(owner).find((each) => each.tytul === "Diuna")).toMatchObject({ status: "w_trakcie", revision: 1 });
  });

  test("a save from a second tab first: the editor tells it, keeps what was typed, and saves it only when the owner says so", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithDictionary(page, owner);
    await page.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    const other = await page.context().newPage();
    await other.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);

    await editor(other).getByLabel(say("dictionaries.editor.labelOf", { position: 1 }), { exact: true }).fill("W planie");
    await saveButton(other).click();
    await expect(other.getByRole("status")).toHaveText(say("dictionaries.done.saved", { name: "Status czytania" }));

    const mine = editor(page).getByLabel(say("dictionaries.editor.labelOf", { position: 2 }), { exact: true });
    await mine.fill("Czytam");
    await saveButton(page).click();
    const conflict = editor(page).getByRole("alert").filter({ hasText: text(registers, "dictionaries.conflict.changed") });
    await expect(conflict).toContainText(text(registers, "dictionaries.conflict.kept"));
    await expect(mine).toHaveValue("Czytam");
    await expect(saveButton(page)).toBeDisabled();
    // Nothing of this tab was written.
    expect((await dictionaries(page, owner))[0]).toMatchObject({ revision: 2, values: [{ label: "W planie" }, { label: "W trakcie" }, {}, {}] });

    await conflict.getByRole("button", { name: text(registers, "dictionaries.conflict.overwrite") }).click();
    await expect(page.getByRole("status")).toHaveText(say("dictionaries.done.saved", { name: "Status czytania" }));
    expect((await dictionaries(page, owner))[0]).toMatchObject({ revision: 3, values: [{ label: "Planowane" }, { label: "Czytam" }, {}, {}] });

    // The other tab, saving again on its old revision, is told and can load the stored version.
    await editor(other).getByLabel(say("dictionaries.editor.labelOf", { position: 3 }), { exact: true }).fill("Skończone");
    await saveButton(other).click();
    const theirs = editor(other).getByRole("alert").filter({ hasText: text(registers, "dictionaries.conflict.changed") });
    await theirs.getByRole("button", { name: text(registers, "dictionaries.conflict.load") }).click();
    await expect(theirs).toHaveCount(0);
    await expect.poll(() => labelsInEditor(other)).toEqual(["Planowane", "Czytam", "Ukończone", "Archiwalne"]);
  });

  test("editing a record whose value is hidden or unknown to the dictionary keeps that value", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithDictionary(page, owner);
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect(row(page, "Solaris")).toContainText("Archiwalne");
    await expect(row(page, "Lalka")).toContainText("spoza_slownika");
    await expect(row(page, "Diuna")).toContainText("W trakcie");

    for (const [title, kept, shown] of [
      ["Solaris", "archiwalne", "Archiwalne"],
      ["Lalka", "spoza_slownika", "spoza_slownika"],
    ] as const) {
      await page.getByRole("button", { name: say("record.edit", { name: title }) }).click();
      const dialog = recordDialog(page, "record.editOf");
      const status = dialog.getByLabel("Status");
      await expect(status).toHaveValue(kept);
      await expect(status.getByRole("option", { selected: true })).toHaveText(shown);
      await dialog.getByLabel(/^Autor/).fill("Ktoś");
      await dialog.getByRole("button", { name: text(registers, "record.save") }).click();
      await expect(dialog).toHaveCount(0);
      expect(stored(owner).find((each) => each.tytul === title)).toMatchObject({ status: kept, revision: 2 });
    }
  });

  test("on a phone the page does not scroll sideways; the keyboard reaches the editor; axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await booksWithDictionary(page, owner);
    await page.goto(`${owner.baseUrl}/dictionaries?symbol=status_czytania`);
    await expect(handle(page, "Planowane")).toBeVisible();
    await expectNoViolations(page);

    // From the label of the first value the keyboard goes through the row to the next handle.
    await editor(page).getByLabel(say("dictionaries.editor.labelOf", { position: 1 }), { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(editor(page).getByLabel(say("dictionaries.editor.hiddenOf", { name: "Planowane" }), { exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(editor(page).getByLabel(say("dictionaries.editor.hiddenOf", { name: "Planowane" }), { exact: true })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(editor(page).getByRole("button", { name: say("dictionaries.editor.remove", { name: "Planowane" }) })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(handle(page, "W trakcie")).toBeFocused();
    await expect(saveButton(page)).toBeEnabled();

    await page.setViewportSize({ width: 390, height: 844 });
    const widths = (await page.evaluate("({ page: document.documentElement.scrollWidth, view: window.innerWidth })")) as { page: number; view: number };
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await expect(handle(page, "Planowane")).toBeInViewport();
    await expectNoViolations(page);
  });
});
