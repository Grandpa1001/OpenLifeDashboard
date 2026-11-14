// D47.3 — the template of a screen in the Designer, in a real browser (Scope §5.4; Architektura Załącznik G;
// DEV §9.44) on Książki of F01 and register tables.
// AC1: the layout is downloaded as a file without one identifier; the file chosen again replaces the layout after
//      the window has said what goes, the widgets have new identifiers and the data of the registry, the bar
//      "Undo" brings the older layout back and saves it, and Redo is not there.
// AC2: a file with a path that is no path of a field is refused with the path of the defect and its code and the
//      layout stays; a path that names nothing in this installation gives a widget that needs its binding updated;
//      keyboard, axe, and no menu on a phone.
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000047a1";
const B = "019a0000-0000-7000-8000-0000000047b1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
type Saved = Array<{ id: string; config: Record<string, unknown> }>;

const tile = (page: Page, title: string): Locator => page.getByRole("button", { name: `Select widget: ${title}` });
const open = (page: Page): Locator => page.getByRole("button", { name: text(designer, "template.open"), exact: true });
const windowOf = (page: Page): Locator => page.getByRole("dialog", { name: text(designer, "template.heading") });
const undoButton = (page: Page): Locator => page.getByRole("button", { name: text(designer, "toolbar.undo"), exact: true });
const redoButton = (page: Page): Locator => page.getByRole("button", { name: text(designer, "toolbar.redo"), exact: true });

async function onTheServer(page: Page, owner: BrowserOwner): Promise<Saved> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Saved }).widgets;
}

async function openWith(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", columns: ["tytul", "autor"], layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  await expect(tile(page, "Moje")).toBeVisible();
}

/** A template file the window can be given, with the widgets as the test wants them. */
const fileOf = (widgets: unknown[], name = "Z pliku") => ({
  name: "template.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ format: "openlifedashboard-screen-template", formatVersion: 1, appVersion: "0.0.0", exportedAt: "2026-11-14T10:00:00.000Z", screen: { name, theme: "dark", accent: "teal", widgets } })),
});
const tableOf = (title: string, bindings: unknown[]) => ({ type: "register-table", config: { v: 1, title, pageSize: 10, sortDirection: "desc", allowAdd: true }, layout: LAYOUT, bindings });

test.describe("D47.3-AC1 the layout out as a file and in again", () => {
  test("the file has no identifier; the same file replaces a changed layout after the window says what goes, new ids, Undo brings the older one back, no Redo", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openWith(page, owner);

    await open(page).click();
    const downloading = page.waitForEvent("download");
    await windowOf(page).getByRole("button", { name: text(designer, "template.exportButton"), exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^openlifedashboard-screen-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const content = readFileSync(path, "utf8");
    expect(content).not.toMatch(UUID);
    const parsed = JSON.parse(content) as { format: string; screen: { widgets: Array<{ bindings: Array<{ path: string }> }> } };
    expect(parsed.format).toBe("openlifedashboard-screen-template");
    expect(parsed.screen.widgets[0]!.bindings.map((binding) => binding.path)).toContain("Field.Register.ksiazki.tytul");
    await page.keyboard.press("Escape");
    await expect(windowOf(page)).toBeHidden();
    await expect(open(page)).toBeFocused();

    // The layout is changed meanwhile: a second table.
    const screens = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
    const current = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${screens.screens[0]!.id}`)).json()) as { name: string; theme: string; accent: string; widgets: Array<Record<string, unknown>> };
    const second = { ...current.widgets[0]!, id: B, config: { v: 1, title: "Druga", pageSize: 10, sortDirection: "desc", allowAdd: true }, layout: { ...LAYOUT, desktop: { x: 4, y: 0, w: 4, h: 6 } } };
    const { state: _state, ...secondDesign } = second as Record<string, unknown> & { state?: unknown };
    void _state;
    const put = await page.request.put(`${owner.baseUrl}/api/v1/screens/${screens.screens[0]!.id}/design`, { data: { name: current.name, theme: current.theme, accent: current.accent, widgets: [...current.widgets.map(({ state, ...rest }) => (void state, rest)), secondDesign] }, headers: { Origin: owner.baseUrl } });
    expect(put.status()).toBe(200);
    await page.reload();
    await expect(tile(page, "Druga")).toBeVisible();

    await open(page).click();
    await windowOf(page).getByLabel(text(designer, "template.fileLabel")).setInputFiles({ name: "mine.json", mimeType: "application/json", buffer: readFileSync(path) });
    await expect(windowOf(page).getByRole("note")).toContainText("2 widgets go");
    await windowOf(page).getByRole("button", { name: text(designer, "template.replace"), exact: true }).click();
    await expect(windowOf(page)).toBeHidden();
    await expect(tile(page, "Moje")).toBeVisible();
    await expect(tile(page, "Druga")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: text(designer, "template.applied") })).toBeVisible();
    const replaced = await onTheServer(page, owner);
    expect(replaced).toHaveLength(1);
    expect([A, B]).not.toContain(replaced[0]!.id);
    await expect(page.locator(".designer-widget").first()).toHaveAttribute("data-state", "ok");
    await expect(open(page)).toBeFocused();
    await expect(undoButton(page)).toBeEnabled();

    // Undo takes the older layout back and saves it under its own ids; the import cannot be redone.
    await undoButton(page).click();
    await expect(tile(page, "Druga")).toBeVisible();
    await designerSaved(page);
    expect((await onTheServer(page, owner)).map((widget) => widget.id).sort()).toEqual([A, B]);
    await expect(redoButton(page)).toBeDisabled();
  });
});

test.describe("D47.3-AC2 refusals, a path that names nothing, keyboard, axe and the phone", () => {
  test("a path that is no path of a field is refused with where and why and the layout stays; a path that names nothing here needs the binding updated; axe", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openWith(page, owner);
    await open(page).click();
    const input = windowOf(page).getByLabel(text(designer, "template.fileLabel"));
    await input.setInputFiles(fileOf([tableOf("Zły", [{ slot: "registry", ordinal: 0, path: "Field.Nothing.here" }])]));
    await windowOf(page).getByRole("button", { name: text(designer, "template.replace"), exact: true }).click();
    const issues = windowOf(page).getByRole("list", { name: text(designer, "template.issuesLabel") });
    await expect(issues).toContainText("widgets.0.bindings.0.path");
    await expect(issues).toContainText("PATH_INVALID");
    await expect(windowOf(page)).not.toContainText("Nothing");
    await expectNoViolations(page);
    await page.keyboard.press("Escape");
    await expect(tile(page, "Moje")).toBeVisible();
    expect((await onTheServer(page, owner)).map((widget) => widget.id)).toEqual([A]);

    await open(page).click();
    await windowOf(page).getByLabel(text(designer, "template.fileLabel")).setInputFiles(
      fileOf([tableOf("Bez kolumny", [{ slot: "registry", ordinal: 0, path: "Field.Register.ksiazki" }, { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.nie_ma_takiej", }])]),
    );
    await windowOf(page).getByRole("button", { name: text(designer, "template.replace"), exact: true }).click();
    await expect(windowOf(page)).toBeHidden();
    await expect(tile(page, "Bez kolumny")).toBeVisible();
    await expect(page.locator(".designer-widget").first()).toHaveAttribute("data-state", "needs_rebinding");
    await expect(page.getByText(text(designer, "canvas.needsRebinding")).first()).toBeVisible();
    // The server saved the import itself; the Designer has nothing left to save.
    await expect(page.locator(".designer-status")).toHaveAttribute("data-save", "clean");
    expect((await onTheServer(page, owner))[0]!.config["title"]).toBe("Bez kolumny");
    await expectNoViolations(page);
  });

  test("the window is reached and left by the keyboard, and a phone has no menu of templates", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await openWith(page, owner);
    await open(page).focus();
    await page.keyboard.press("Enter");
    await expect(windowOf(page)).toBeVisible();
    await expect(windowOf(page).getByRole("button", { name: text(designer, "template.exportButton"), exact: true })).toBeEnabled();
    await expect(windowOf(page).getByRole("button", { name: text(designer, "template.replace"), exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(windowOf(page)).toBeHidden();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.reload();
    await expect(page.getByRole("button", { name: text(designer, "template.open"), exact: true })).toHaveCount(0);
  });
});
