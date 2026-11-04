// D35.2 — undo, redo and the bar of a deletion in a real browser (Scope §5.4; Architektura AR17;
// makiety 29, 44) on Książki of F01 and one register table.
// AC1: undo and redo by the buttons and by Ctrl/⌘+Z of a move, a size, a title typed as one step and a
//      new widget; a deletion saved and then undone by the bar is the same widget id with its
//      configuration and bindings on the server, also after a restart; the bar takes the focus.
// AC2: nothing to undo or redo leaves the buttons inactive; Ctrl+Z in a field of text is the field's;
//      Escape closes the bar on the grid and the bar goes by itself after 10 s; Duplicate gives the
//      focus to the copy; axe.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRegisterTable, BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000035d1";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };
type Saved = Array<{ id: string; config: Record<string, unknown>; layout: typeof LAYOUT; bindings: unknown[] }>;
/** Ctrl on Windows and Linux, ⌘ on macOS, as the browser's system has it. */
const UNDO = "ControlOrMeta+z";
const REDO = "ControlOrMeta+Shift+z";

const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const undoButton = (page: Page): Locator => page.getByRole("button", { name: text(designer, "toolbar.undo"), exact: true });
const redoButton = (page: Page): Locator => page.getByRole("button", { name: text(designer, "toolbar.redo"), exact: true });
const tile = (page: Page, title = "Moje"): Locator => page.getByRole("button", { name: `Select widget: ${title}` });
const titleField = (page: Page): Locator => bar(page).getByLabel(text(designer, "bar.title"), { exact: true });
const undoBar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "undoBar.label") });

async function onTheServer(page: Page, owner: BrowserOwner): Promise<Saved> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Saved }).widgets;
}

async function tableOpen(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", columns: ["tytul", "autor"], layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  await expect(tile(page)).toBeVisible();
}

test.describe("D35.2-AC1 undo and redo of every kind of change, and of a saved deletion", () => {
  test("a move, a title typed as one step and a new widget go back and forth by the buttons and the keys", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableOpen(page, owner);
    await expect(undoButton(page)).toBeDisabled();
    await expect(redoButton(page)).toBeDisabled();

    // A move by the keyboard, then the title typed letter by letter: two steps.
    await tile(page).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await tile(page).click();
    await titleField(page).selectText();
    await titleField(page).pressSequentially("Półka", { delay: 30 });
    await titleField(page).blur();
    await designerSaved(page);
    expect((await onTheServer(page, owner))[0]!.config["title"]).toBe("Półka");

    await undoButton(page).click();
    await expect(titleField(page)).toHaveValue("Moje");
    await undoButton(page).click();
    await expect(undoButton(page)).toBeDisabled();
    await designerSaved(page);
    expect((await onTheServer(page, owner))[0]!.layout.desktop).toEqual(LAYOUT.desktop);

    // Redo by the keys, outside a field of text.
    await tile(page).focus();
    await page.keyboard.press(REDO);
    await page.keyboard.press(REDO);
    await expect(redoButton(page)).toBeDisabled();
    await expect(titleField(page)).toHaveValue("Półka");
    await designerSaved(page);
    const redone = (await onTheServer(page, owner))[0]!;
    expect(redone.layout.desktop).toEqual({ ...LAYOUT.desktop, x: 1 });
    expect(redone.config["title"]).toBe("Półka");

    // A new widget is a step too.
    await addRegisterTable(page);
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(2);
    await page.locator(".designer-frame").focus();
    await page.keyboard.press(UNDO);
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(1);
    await expectNoViolations(page);
  });

  test("a deletion saved and undone by the bar is the same widget with its configuration and bindings, also after a restart", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableOpen(page, owner);
    const before = (await onTheServer(page, owner))[0]!;
    await tile(page).click();
    await bar(page).getByRole("button", { name: text(designer, "bar.delete") }).click();
    await expect(undoBar(page)).toContainText(text(designer, "undoBar.removed").replace("{{name}}", "Moje"));
    const undo = undoBar(page).getByRole("button", { name: text(designer, "undoBar.undo") });
    await expect(undo).toBeFocused();
    await expectNoViolations(page);
    await designerSaved(page);
    expect(await onTheServer(page, owner)).toEqual([]);

    await page.keyboard.press("Enter");
    await expect(undoBar(page)).toHaveCount(0);
    await expect(tile(page)).toBeFocused();
    await designerSaved(page);
    const back = (await onTheServer(page, owner))[0]!;
    expect(back).toEqual(before);

    await owner.restart();
    expect((await onTheServer(page, owner))[0]).toEqual(before);
  });
});

test.describe("D35.2-AC2 the keys in a field, the bar of a deletion and the focus of a copy", () => {
  test("Ctrl+Z in a field is the field's; Escape closes the bar on the grid, and the bar goes by itself after 10 s; Duplicate gives the focus to the copy", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableOpen(page, owner);
    await tile(page).click();
    await titleField(page).fill("Nowy");
    // In the field the keys undo its text, as the browser does, and not a step of the design: the field and the design say Moje.
    await titleField(page).press(UNDO);
    await expect(titleField(page)).toHaveValue("Moje");
    await expect(tile(page)).toBeVisible();
    await titleField(page).fill("Nowy");
    await titleField(page).blur();
    await designerSaved(page);

    await bar(page).getByRole("button", { name: text(designer, "bar.duplicate") }).click();
    await expect(tile(page, `Nowy ${text(designer, "bar.copySuffix")}`)).toBeFocused();

    await bar(page).getByRole("button", { name: text(designer, "bar.delete") }).click();
    await expect(undoBar(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(undoBar(page)).toHaveCount(0);
    await expect(undoBar(page)).toHaveCount(0);
    await expect(page.locator(".designer-frame")).toBeFocused();
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(1);

    await tile(page, "Nowy").click();
    await bar(page).getByRole("button", { name: text(designer, "bar.delete") }).click();
    await expect(undoBar(page)).toBeVisible();
    await expect(undoBar(page)).toHaveCount(0, { timeout: 12_000 });
    // After the bar the history still takes the deletion back.
    await page.locator(".designer-frame").focus();
    await page.keyboard.press(UNDO);
    await expect(tile(page, "Nowy")).toBeVisible();
  });
});
