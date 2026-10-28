// D20.1 — the whole vertical path of the owner in a real browser, on the built app and the built
// server over a file SQLite (gate G1, Scope S1–S6): the owner exactly as the installer leaves it
// (a password, no second factor) signs in, enrols the authenticator from the key the page shows,
// acknowledges the recovery codes, starts empty, makes the registry Książki from its form, adds 25
// records through the production route under idempotency keys, puts the register table on the
// screen in the Designer, reads it in pages of 10, 10 and 5, and finds everything unchanged after
// two restarts of the server. No SQL and no test API: nothing here skips a step of the owner.
// AC1: the path passes step by step; the pages are 10/10/5; two restarts change nothing.
// AC2: the same key adds once, the same key with another body and a record without its title
//      store nothing, and nothing private is open before the enrollment is finished.
import type { APIResponse, Page } from "@playwright/test";
import { codeOf, secretOf, type BrowserOwner } from "../support/auth-http.ts";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath, type RecordDto } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { expect, locale, test, text } from "./fixtures.ts";
import { expectNoViolations } from "./owner-session.ts";

const auth = locale("en", "auth");
const setup = locale("en", "setup");
const registers = locale("en", "registers");
const designer = locale("en", "designer");
const widgets = locale("en", "widgets");

test.use({ locale: "en-US", viewport: { width: 1600, height: 1000 } });

const BOOKS = 25;
const RECORDS = registryRecordsPath("ksiazki");
const PAGE_SIZE = 10;

type RecordPage = Readonly<{ records: RecordDto[]; total: number }>;

/** Every record of the registry, read page by page the way the widget reads them. */
async function allRecords(page: Page, owner: BrowserOwner): Promise<RecordDto[]> {
  const found: RecordDto[] = [];
  for (let number = 1; ; number += 1) {
    const reply = await page.request.get(`${owner.baseUrl}${RECORDS}?page=${number}&pageSize=${PAGE_SIZE}&sort=created_at&direction=asc`);
    expect(reply.status()).toBe(200);
    const body = (await reply.json()) as RecordPage;
    found.push(...body.records);
    if (found.length >= body.total || body.records.length === 0) return found;
  }
}

const post = (page: Page, owner: BrowserOwner, key: string, values: Record<string, unknown>): Promise<APIResponse> =>
  page.request.post(`${owner.baseUrl}${RECORDS}`, { data: { schemaRevision: 1, values }, headers: { Origin: owner.baseUrl, [IDEMPOTENCY_KEY_HEADER]: key } });

const codeOfError = async (reply: APIResponse): Promise<string> => ((await reply.json()) as { code: string }).code;

test.describe("D20.1 the owner's vertical path on a file SQLite", () => {
  test("AC1+AC2 installer-state owner → authenticator → registry → 25 records → widget → pages 10/10/5 → two restarts", async ({ page, ownerServer }) => {
    const owner = await ownerServer("password_only");

    // The sign-in with the password only leads to the enrollment, and nothing private answers yet.
    await page.goto(`${owner.baseUrl}/login`);
    await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
    await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
    await page.getByRole("button", { name: text(auth, "login.submit") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    for (const path of ["/main", "/registers", "/designer"]) {
      await page.goto(`${owner.baseUrl}${path}`);
      await expect(page).toHaveURL(`${owner.baseUrl}/setup`);
    }
    for (const path of [REGISTRIES_PATH, "/api/v1/screens", RECORDS]) {
      const reply = await page.request.get(`${owner.baseUrl}${path}`);
      expect([401, 403], `GET ${path} before the second factor`).toContain(reply.status());
    }
    expect((await post(page, owner, "before-the-second-factor", { tytul: "Za wcześnie" })).status()).toBeGreaterThanOrEqual(401);

    // The authenticator from the key the page shows, the recovery codes, the empty start, the preferences.
    const key = (await page.locator(".manual-key").innerText()).replaceAll(/\s/g, "");
    await page.getByLabel(text(setup, "enrollment.codeLabel")).fill(await codeOf(secretOf(`otpauth://totp/x?secret=${key}`)));
    await page.getByRole("button", { name: text(setup, "enrollment.submit") }).click();
    await page.getByLabel(text(setup, "recovery.saved")).check();
    await page.getByRole("button", { name: text(setup, "recovery.continue") }).click();
    await page.getByRole("button", { name: text(setup, "data.chooseEmpty") }).click();
    await page.getByLabel(text(setup, "preferences.timezoneLabel")).fill("Europe/Warsaw");
    await page.getByRole("button", { name: text(setup, "preferences.save") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);

    // The registry Książki from its form.
    await page.goto(`${owner.baseUrl}/registers`);
    await page.getByRole("button", { name: text(registers, "list.new") }).click();
    await page.getByLabel(text(registers, "form.name"), { exact: true }).fill("Książki");
    const first = page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "1") });
    await first.getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Tytuł");
    await first.getByLabel(text(registers, "form.required"), { exact: true }).check();
    await page.getByRole("button", { name: text(registers, "form.addColumn") }).click();
    await page.getByRole("group", { name: text(registers, "form.column").replace("{{position}}", "2") }).getByLabel(text(registers, "form.columnName"), { exact: true }).fill("Autor");
    await page.getByRole("button", { name: text(registers, "form.create") }).click();
    await expect(page.getByRole("status")).toHaveText(text(registers, "form.created").replace("{{name}}", "Książki"));

    // 25 records through the production route, each under a key of its own.
    for (let number = 1; number <= BOOKS; number += 1) {
      const reply = await post(page, owner, `seed-${String(number).padStart(2, "0")}-g1-path`, { tytul: `Książka ${String(number).padStart(2, "0")}`, autor: "Autor" });
      expect(reply.status(), `record ${number}`).toBe(201);
    }

    // The widget in the Designer, bound to the registry and its two columns.
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await page.getByRole("button", { name: "Add: Register table" }).click();
    await page.getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Książki (ksiazki)" });
    await page.getByRole("checkbox", { name: "Tytuł" }).check();
    await page.getByRole("checkbox", { name: "Autor" }).check();
    await page.getByRole("button", { name: text(designer, "toolbar.save"), exact: true }).click();
    // The whole text: "Unsaved changes" holds "saved" too, and a Finish pressed while the save is in flight asks to discard.
    await expect(page.getByRole("status")).toHaveText(text(designer, "toolbar.saved"));
    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);

    // The pages of 10, 10 and 5.
    const card = page.locator("section.widget").first();
    await expect(card.getByRole("columnheader")).toHaveText(["Tytuł", "Autor"]);
    await expect(card.getByText("Page 1 of 3")).toBeVisible();
    await expect(card.getByText("25 records in total")).toBeVisible();
    await expect(card.getByRole("row")).toHaveCount(11);
    await card.getByRole("button", { name: text(widgets, "registerTable.next") }).click();
    await expect(card.getByText("Page 2 of 3")).toBeVisible();
    await expect(card.getByRole("row")).toHaveCount(11);
    await card.getByRole("button", { name: text(widgets, "registerTable.next") }).click();
    await expect(card.getByText("Page 3 of 3")).toBeVisible();
    await expect(card.getByRole("row")).toHaveCount(6);
    await expectNoViolations(page);

    // AC2: the same key adds once (the replay answers 200 with the same record); the same key with another body and a record without its title store nothing.
    const before = await allRecords(page, owner);
    expect(before).toHaveLength(BOOKS);
    const added = await post(page, owner, "same-key-g1-path", { tytul: "Solaris", autor: "Lem" });
    expect(added.status()).toBe(201);
    const again = await post(page, owner, "same-key-g1-path", { tytul: "Solaris", autor: "Lem" });
    expect(again.status()).toBe(200);
    expect(((await again.json()) as RecordDto).id).toBe(((await added.json()) as RecordDto).id);
    const changed = await post(page, owner, "same-key-g1-path", { tytul: "Solaris", autor: "Stanisław Lem" });
    expect([changed.status(), await codeOfError(changed)]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    const untitled = await post(page, owner, "untitled-g1-path", { autor: "Nikt" });
    expect([untitled.status(), await codeOfError(untitled)]).toEqual([422, "VALIDATION_FAILED"]);
    const stored = await allRecords(page, owner);
    expect(stored).toHaveLength(BOOKS + 1);
    expect(stored.filter((record) => record.values["tytul"] === "Solaris")).toHaveLength(1);

    // AC1: two restarts of the server change nothing the owner has.
    const screen = async (): Promise<unknown> => {
      const list = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
      expect(list.screens).toHaveLength(1);
      return (await page.request.get(`${owner.baseUrl}/api/v1/screens/${list.screens[0]?.id ?? ""}`)).json();
    };
    const screenBefore = await screen();
    await page.waitForLoadState("networkidle");
    for (let restart = 1; restart <= 2; restart += 1) {
      await owner.restart();
      expect(await allRecords(page, owner), `records after restart ${restart}`).toEqual(stored);
      expect(await screen(), `screen after restart ${restart}`).toEqual(screenBefore);
    }
    await page.goto(`${owner.baseUrl}/main`);
    const reopened = page.locator("section.widget").first();
    await expect(reopened.getByText("26 records in total")).toBeVisible();
    await expect(reopened.getByRole("cell", { name: "Solaris" })).toBeVisible();
  });
});
