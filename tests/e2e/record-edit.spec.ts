// D23.3 — changing and deleting a record in a real browser (Scope §5.6, makieta 08, 21) on Książki
// of F01, made without SQL; two tabs are two pages of one session, as a second open tab would be.
// AC1: a record changed in the window shows its new value and is stored with revision 2; when a
//      second tab changed the same record first, the window tells when, lists only the fields that
//      differ, keeps what was typed and saves only after the newer version is loaded, and then the
//      field the other tab changed stays.
// AC2: a delete asks first, naming the record, and the list and its count shrink; a record already
//      deleted in the other tab is taken as deleted without an error; a change whose answer was lost
//      is saved once and shows no conflict; the widget on /main has no actions; keyboard and axe.
import type { Page } from "@playwright/test";
import { registryRecordPath, registryRecordsPath } from "@openlife/contracts/http/records";
import { query, type BrowserOwner } from "../support/auth-http.ts";
import { shownDateTime } from "../support/shown-date.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, deafToLiveEvents, expectNoViolations, signInFully } from "./owner-session.ts";

const registers = locale("en", "registers");
const errors = locale("en", "errors");
test.use({ locale: "en-US" });

const say = (key: string, values: Record<string, string> = {}) => Object.entries(values).reduce((each, [name, value]) => each.replace(`{{${name}}}`, value), text(registers, key));
const editDialog = (page: Page) => page.getByRole("dialog", { name: say("record.editOf", { name: "Książki" }) });
const field = (page: Page, label: string) => editDialog(page).getByLabel(label);
const save = (page: Page) => editDialog(page).getByRole("button", { name: text(registers, "record.save") });
const editButton = (page: Page, name: string) => page.getByRole("button", { name: say("record.edit", { name }) });
const deleteButton = (page: Page, name: string) => page.getByRole("button", { name: say("record.remove", { name }) });
const row = (page: Page, title: string) => page.getByRole("row").filter({ hasText: title });

type Stored = { id: string; tytul: string; autor: string | null; strony: number | null; status: string | null; revision: number };
const stored = (owner: BrowserOwner) => query<Stored>(owner.instance, "SELECT id, tytul, autor, strony, status, revision FROM reg_ksiazki ORDER BY created_at, id");

/** Książki with Diuna and Solaris, added through the API, and its page open. */
async function books(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Diuna", autor: "Frank Herbert", strony: 412 }, "d23-3-diuna");
  await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris" }, "d23-3-solaris");
  await page.goto(`${owner.baseUrl}/registers/ksiazki`);
  await expect(row(page, "Solaris")).toBeVisible();
}

test.describe("D23.3-AC1 a change in the window, and two tabs changing one record", () => {
  test("a change is shown and stored with revision 2", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await expect(page.getByRole("columnheader", { name: text(registers, "table.actions") })).toBeVisible();
    await editButton(page, "Diuna").click();
    await expect(editDialog(page)).toBeVisible();
    // The window opens on the stored values.
    await expect(field(page, "Tytuł")).toHaveValue("Diuna");
    await expect(field(page, "Liczba stron")).toHaveValue("412");
    await expect(field(page, "Status")).toHaveValue("planowane");
    await expectNoViolations(page);

    await field(page, "Liczba stron").fill("500");
    await save(page).click();
    await expect(editDialog(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(text(registers, "record.done.edit"));
    await expect(row(page, "Diuna")).toContainText("500");
    await expect(editButton(page, "Diuna")).toBeFocused();
    expect(stored(owner).find((each) => each.tytul === "Diuna")).toMatchObject({ strony: 500, autor: "Frank Herbert", revision: 2 });
  });

  test("the second tab's change comes first: the window tells when, compares the differing fields, keeps what was typed, and saves after loading the newer version without losing the other change", async ({ page, ownerServer }) => {
    await deafToLiveEvents(page);
    const owner = await ownerServer("ready");
    await books(page, owner);
    const other = await page.context().newPage();
    await other.goto(`${owner.baseUrl}/registers/ksiazki`);

    // Both tabs open Solaris on revision 1.
    await editButton(page, "Solaris").click();
    await editButton(other, "Solaris").click();
    await field(other, "Autor").fill("Stanisław Lem");
    await save(other).click();
    await expect(editDialog(other)).toHaveCount(0);

    let patches = 0;
    await page.route(`**${registryRecordsPath("ksiazki")}/*`, (route) => {
      if (route.request().method() === "PATCH") patches += 1;
      return route.continue();
    });
    await field(page, "Liczba stron").fill("300");
    await field(page, "Status").fill("czytane");
    await save(page).click();

    await expect(editDialog(page).getByText(text(registers, "record.conflict.kept"))).toBeVisible();
    await expect(editDialog(page).getByRole("button", { name: text(registers, "record.conflict.load") })).toBeVisible();
    const compare = editDialog(page).getByRole("table", { name: text(registers, "record.conflict.compare") });
    // Only the fields that differ: the author the other tab set, and this tab's pages and status.
    await expect(compare.getByRole("rowheader")).toHaveText(["Autor", "Liczba stron", "Status"]);
    await expect(compare.getByRole("row").filter({ hasText: "Autor" }).getByRole("cell")).toHaveText(["Stanisław Lem", text(registers, "table.empty")]);
    await expect(compare.getByRole("row").filter({ hasText: "Status" }).getByRole("cell")).toHaveText(["planowane", "czytane"]);
    // The time of the change, in the owner's zone, from the record on the server.
    const updatedAt = query<{ updated_at: string }>(owner.instance, "SELECT updated_at FROM reg_ksiazki WHERE tytul = 'Solaris'")[0]!.updated_at;
    const when = shownDateTime(updatedAt, "Europe/Warsaw");
    await expect(editDialog(page).getByText(say("record.conflict.changed", { when }))).toBeVisible();
    // What was typed is still in the fields, and saving waits.
    await expect(field(page, "Liczba stron")).toHaveValue("300");
    await expect(field(page, "Autor")).toHaveValue("");
    await expect(save(page)).toBeDisabled();
    await expect(editDialog(page).getByText(text(registers, "record.conflict.saveAfterLoad"))).toBeVisible();
    await expectNoViolations(page);
    expect(patches).toBe(1);
    expect(stored(owner).find((each) => each.tytul === "Solaris")).toMatchObject({ autor: "Stanisław Lem", strony: null, revision: 2 });

    await editDialog(page).getByRole("button", { name: text(registers, "record.conflict.load") }).click();
    await expect(editDialog(page).getByText(text(registers, "record.conflict.kept"))).toHaveCount(0);
    await expect(field(page, "Autor")).toHaveValue("Stanisław Lem");
    await expect(field(page, "Liczba stron")).toHaveValue("300");
    await expect(field(page, "Status")).toHaveValue("czytane");
    await expect(save(page)).toBeEnabled();
    await expect(save(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editDialog(page)).toHaveCount(0);
    expect(stored(owner).find((each) => each.tytul === "Solaris")).toMatchObject({ autor: "Stanisław Lem", strony: 300, status: "czytane", revision: 3 });
    await expect(row(page, "Solaris")).toContainText("Stanisław Lem");
    await other.close();
  });
});

test.describe("D23.3-AC2 a delete, a record gone elsewhere, a lost answer and the widget", () => {
  test("a delete asks first and names the record; Escape keeps it and gives the focus back; confirmed, the list and the count shrink", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    const question = page.getByRole("dialog", { name: say("record.delete.question", { name: "Diuna" }) });
    await deleteButton(page, "Diuna").click();
    await expect(question).toBeVisible();
    await expect(question.getByRole("button", { name: text(registers, "record.cancel") })).toBeFocused();
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(question).toHaveCount(0);
    await expect(deleteButton(page, "Diuna")).toBeFocused();
    expect(stored(owner)).toHaveLength(2);

    await deleteButton(page, "Diuna").click();
    await question.getByRole("button", { name: text(registers, "record.delete.confirm") }).click();
    await expect(question).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText(text(registers, "record.done.delete"));
    await expect(row(page, "Diuna")).toHaveCount(0);
    await expect(page.getByText("1–1 of 1")).toBeVisible();
    expect(stored(owner).map((each) => each.tytul)).toEqual(["Solaris"]);
    // The row is gone, so the focus goes to "Add".
    await expect(page.getByRole("button", { name: text(registers, "record.add"), exact: true })).toBeFocused();
  });

  test("a record deleted in the other tab is taken as deleted, without an error, and the list is read again", async ({ page, ownerServer }) => {
    await deafToLiveEvents(page);
    const owner = await ownerServer("ready");
    await books(page, owner);
    const solaris = stored(owner).find((each) => each.tytul === "Solaris")!;
    const gone = await page.request.delete(`${owner.baseUrl}${registryRecordPath("ksiazki", solaris.id)}`, { data: { expectedRevision: 1 }, headers: { Origin: owner.baseUrl } });
    expect(gone.status()).toBe(204);

    await deleteButton(page, "Solaris").click();
    await page.getByRole("dialog").getByRole("button", { name: text(registers, "record.delete.confirm") }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(row(page, "Solaris")).toHaveCount(0);
    expect(stored(owner).map((each) => each.tytul)).toEqual(["Diuna"]);
  });

  test("a change whose answer was lost after the server saved it is saved once: the repeat shows no conflict and closes the window", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    let lost = false;
    await page.route(`**${registryRecordsPath("ksiazki")}/*`, async (route) => {
      if (route.request().method() !== "PATCH" || lost) return route.continue();
      lost = true;
      // The server saves, and the answer never reaches the page.
      await route.fetch();
      return route.abort("connectionreset");
    });
    await editButton(page, "Diuna").click();
    await field(page, "Autor").fill("F. Herbert");
    await save(page).click();
    await expect(editDialog(page).getByText(text(errors, "NETWORK"))).toBeVisible();
    expect(stored(owner).find((each) => each.tytul === "Diuna")).toMatchObject({ autor: "F. Herbert", revision: 2 });

    await save(page).click();
    await expect(editDialog(page)).toHaveCount(0);
    await expect(page.getByText(text(registers, "record.conflict.kept"))).toHaveCount(0);
    expect(stored(owner).find((each) => each.tytul === "Diuna")).toMatchObject({ autor: "F. Herbert", revision: 2 });
  });

  test("the register widget on /main only adds: no actions column, no edit and no delete", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await books(page, owner);
    await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000d2303", title: "Moje książki", layout: { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 12, h: 8 } } }]);
    await page.goto(`${owner.baseUrl}/`);
    await expect(page.getByRole("cell", { name: "Diuna" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: text(registers, "table.actions") })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Edit the record|Delete the record/ })).toHaveCount(0);
  });
});
