// D18.2 — the Designer in a real browser (Scope §5.4): a first screen, a widget added, bound to a
// registry and two columns and saved; a drag and a resize with the mouse that change only the layout
// being arranged; a refused or lost save that keeps every change; unsaved changes that ask first.
// AC1: the Designer adds a register table, binds it and saves it, and a real drag changes one layout.
// AC2: a refused save (422) shows the error and keeps the state; a lost connection keeps the changes
//      and the save can be repeated; leaving asks while changes are unsaved; axe.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
const errors = locale("en", "errors");

test.use({ locale: "en-US" });

const A = "019a0000-0000-7000-8000-0000000001aa";
const SCREEN_PATH = /\/api\/v1\/screens\/[^/]+\/design$/;
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 6 }, tablet: { x: 0, y: 0, w: 4, h: 6 }, desktop: { x: 0, y: 0, w: 4, h: 6 } };

type Placed = { x: number; y: number; w: number; h: number };
type Saved = { widgets: Array<{ id: string; layout: Record<"phone" | "tablet" | "desktop", Placed>; bindings: Array<{ slot: string; path: string }>; config: Record<string, unknown> }> };

async function ready(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
}

/** The first screen as the server holds it. */
async function savedScreen(page: Page, owner: BrowserOwner): Promise<Saved> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  const id = listed.screens[0]?.id;
  if (id === undefined) throw new Error("no screen");
  return (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${id}`)).json()) as Saved;
}

const toolbarButton = (page: Page, key: string): Locator => page.getByRole("button", { name: text(designer, key), exact: true });
const status = (page: Page): Locator => page.getByRole("status").filter({ hasText: /changes|Saved|Saving/ });

/** Press on a point, move there in steps and let go: what a hand does, so the library sees real mouse events. */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 6 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
  await page.mouse.up();
}

const centre = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** The cell of the desktop grid: 12 columns in 1200 px with a gap of 16 px, rows of 32 px and the same gap. */
const COLUMN_PX = (1200 - 11 * 16) / 12 + 16;
const ROW_PX = 32 + 16;

test.describe("D18.2-AC1 the Designer arranges and saves", () => {
  test("creates the first screen, adds a register table, binds a registry and two columns, saves, and the screen shows it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Solaris", autor: "Lem" }, "seed-key-001");

    await page.getByRole("link", { name: text(locale("en"), "main.designer"), exact: true }).click();
    await expect(page.getByRole("heading", { name: text(designer, "create.heading") })).toBeVisible();
    await expectNoViolations(page);
    await page.getByRole("button", { name: text(designer, "create.submit") }).click();
    await expect(page.getByRole("heading", { level: 1, name: text(designer, "title") })).toBeVisible();
    await expect(status(page)).toHaveText(text(designer, "toolbar.clean"));
    await expect(toolbarButton(page, "toolbar.save")).toBeDisabled();

    await page.getByRole("button", { name: "Add: Register table" }).click();
    const handle = page.getByRole("button", { name: "Select widget: Register table" });
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));
    await expect(page.getByText(text(designer, "canvas.unbound"))).toBeVisible();

    await page.getByLabel(text(designer, "panel.registry"), { exact: true }).selectOption({ label: "Książki (ksiazki)" });
    await page.getByRole("checkbox", { name: "Tytuł" }).check();
    await page.getByRole("checkbox", { name: "Autor" }).check();
    await expect(page.getByText("Registry ksiazki, columns: 2")).toBeVisible();
    await expectNoViolations(page);

    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    await expect(toolbarButton(page, "toolbar.save")).toBeDisabled();

    const saved = await savedScreen(page, owner);
    expect(saved.widgets).toHaveLength(1);
    expect(saved.widgets[0]?.bindings.map((binding) => binding.path)).toEqual(["Field.Register.ksiazki", "Field.Register.ksiazki.tytul", "Field.Register.ksiazki.autor"]);
    // The first free place of each layout: the top left corner, as wide as the layout allows.
    expect(saved.widgets[0]?.layout).toEqual({ phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } });

    await toolbarButton(page, "toolbar.finish").click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    const card = page.locator("section.widget").first();
    await expect(card.getByRole("columnheader")).toHaveText(["Tytuł", "Autor"]);
    await expect(card.getByRole("cell", { name: "Solaris" })).toBeVisible();
  });

  test("a second widget goes to the first free place of each layout", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Pierwsza", layout: { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 4, h: 8 }, desktop: { x: 0, y: 0, w: 4, h: 8 } } }]);
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: "Add: Register table" }).click();
    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    const added = (await savedScreen(page, owner)).widgets.find((widget) => widget.id !== A);
    // Phone: below the first. Tablet: beside it would need 8 columns, so below. Desktop: beside it, in the 8 columns that are left.
    expect(added?.layout).toEqual({ phone: { x: 0, y: 8, w: 1, h: 8 }, tablet: { x: 0, y: 8, w: 8, h: 8 }, desktop: { x: 4, y: 0, w: 8, h: 8 } });
  });

  test("a drag with the mouse and a resize change the layout being arranged and no other", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    await expect(page.getByRole("button", { name: "Select widget: Moja tabela" })).toBeVisible();

    const corner = page.locator(".react-resizable-handle-se");
    await dragBy(page, await centre(corner), Math.round(COLUMN_PX), 2 * ROW_PX);
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));

    const handle = page.getByRole("button", { name: "Select widget: Moja tabela" });
    await dragBy(page, await centre(handle), Math.round(2 * COLUMN_PX), 3 * ROW_PX);

    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    const layout = (await savedScreen(page, owner)).widgets[0]?.layout;
    expect(layout?.desktop).toEqual({ x: 2, y: 3, w: 5, h: 8 });
    expect(layout?.phone).toEqual(LAYOUT.phone);
    expect(layout?.tablet).toEqual(LAYOUT.tablet);

    // The other layouts still show the widget where it was.
    await page.getByRole("button", { name: text(designer, "toolbar.tablet"), exact: true }).click();
    const frame = page.getByRole("group", { name: "Screen layout: Tablet" });
    const cardOnTablet = page.locator(".designer-widget");
    // The library slides a card to its new place, so the place is read once it has settled.
    await expect(async () => {
      const inFrame = await frame.boundingBox();
      const moved = await cardOnTablet.boundingBox();
      expect(Math.abs((moved?.x ?? -999) - (inFrame?.x ?? 0))).toBeLessThanOrEqual(2);
      expect(Math.abs((moved?.y ?? -999) - (inFrame?.y ?? 0))).toBeLessThanOrEqual(2);
    }).toPass();

    // After a reload the desktop layout is where it was saved.
    await page.reload();
    await expect(page.getByRole("button", { name: "Select widget: Moja tabela" })).toBeVisible();
    await expect(async () => {
      const again = await page.getByRole("group", { name: "Screen layout: Desktop" }).boundingBox();
      const place = await page.locator(".designer-widget").boundingBox();
      expect(Math.abs((place?.x ?? 0) - ((again?.x ?? 0) + 2 * COLUMN_PX))).toBeLessThanOrEqual(2);
      expect(Math.abs((place?.y ?? 0) - ((again?.y ?? 0) + 3 * ROW_PX))).toBeLessThanOrEqual(2);
    }).toPass();
    await expectNoViolations(page);
  });
});

test.describe("D18.3-AC2 the grid on a collision", () => {
  test("a widget dropped on another is never saved overlapping it, and the other layouts stay as they were", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    const B = "019a0000-0000-7000-8000-0000000001bb";
    await createScreenWith(page, owner, [
      { id: A, title: "Pierwsza", layout: { phone: { x: 0, y: 0, w: 1, h: 6 }, tablet: { x: 0, y: 0, w: 4, h: 6 }, desktop: { x: 0, y: 0, w: 4, h: 6 } } },
      { id: B, title: "Druga", layout: { phone: { x: 0, y: 6, w: 1, h: 6 }, tablet: { x: 4, y: 0, w: 4, h: 6 }, desktop: { x: 4, y: 0, w: 4, h: 6 } } },
    ]);
    await page.goto(`${owner.baseUrl}/designer`);
    await dragBy(page, await centre(page.getByRole("button", { name: "Select widget: Druga" })), -Math.round(4 * COLUMN_PX), 0);
    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    const saved = (await savedScreen(page, owner)).widgets;
    const first = saved.find((widget) => widget.id === A)?.layout.desktop;
    const second = saved.find((widget) => widget.id === B)?.layout.desktop;
    if (first === undefined || second === undefined) throw new Error("a widget is missing");
    const overlap = first.x < second.x + second.w && second.x < first.x + first.w && first.y < second.y + second.h && second.y < first.y + first.h;
    expect(overlap, `${JSON.stringify(first)} and ${JSON.stringify(second)}`).toBe(false);
    for (const layout of ["phone", "tablet"] as const) {
      expect(saved.find((widget) => widget.id === B)?.layout[layout]).toEqual(layout === "phone" ? { x: 0, y: 6, w: 1, h: 6 } : { x: 4, y: 0, w: 4, h: 6 });
    }
    // The widget that was dropped takes the place and the one it landed on is pushed below it.
    expect({ first, second }).toEqual({ first: { x: 0, y: 6, w: 4, h: 6 }, second: { x: 0, y: 0, w: 4, h: 6 } });
  });
});

test.describe("D18.2-AC2 a save that fails, and leaving with unsaved changes", () => {
  test("a refused save shows the error and keeps every change, and the same save works once the server accepts it", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: "Add: Register table" }).click();

    await page.route(SCREEN_PATH, (route) => route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "VALIDATION_FAILED", message: "refused", details: null, requestId: "req-refused-1" }) }));
    await toolbarButton(page, "toolbar.save").click();
    await expect(page.getByRole("alert").filter({ hasText: text(errors, "VALIDATION_FAILED") })).toBeVisible();
    await expect(page.getByText("req-refused-1")).toBeVisible();
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(2);
    await expect(toolbarButton(page, "toolbar.save")).toBeEnabled();
    await expect(savedScreenWidgets(page, owner)).resolves.toBe(1);

    await page.unroute(SCREEN_PATH);
    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(savedScreenWidgets(page, owner)).resolves.toBe(2);
  });

  test("a lost connection keeps the changes and the save can be repeated", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    const handle = page.getByRole("button", { name: "Select widget: Moja tabela" });
    await dragBy(page, await centre(handle), Math.round(COLUMN_PX), ROW_PX);

    await page.route(SCREEN_PATH, (route) => route.abort("connectionfailed"));
    await toolbarButton(page, "toolbar.save").click();
    await expect(page.getByRole("alert").filter({ hasText: text(errors, "NETWORK") })).toBeVisible();
    await expect(status(page)).toHaveText(text(designer, "toolbar.dirty"));

    await page.unroute(SCREEN_PATH);
    await toolbarButton(page, "toolbar.save").click();
    await expect(status(page)).toHaveText(text(designer, "toolbar.saved"));
    expect((await savedScreen(page, owner)).widgets[0]?.layout.desktop).toEqual({ x: 1, y: 1, w: 4, h: 6 });
  });

  test("leaving with unsaved changes asks first: staying keeps them, leaving drops them, and nothing was saved", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    await page.getByRole("button", { name: "Add: Register table" }).click();

    await toolbarButton(page, "toolbar.finish").click();
    const ask = page.getByRole("alertdialog", { name: text(designer, "leave.heading") });
    await expect(ask).toBeVisible();
    await expectNoViolations(page);
    await ask.getByRole("button", { name: text(designer, "leave.stay") }).click();
    await expect(ask).toHaveCount(0);
    await expect(page).toHaveURL(`${owner.baseUrl}/designer`);
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(2);

    await toolbarButton(page, "toolbar.finish").click();
    await page.getByRole("alertdialog").getByRole("button", { name: text(designer, "leave.discard") }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/main`);
    await expect(savedScreenWidgets(page, owner)).resolves.toBe(1);
  });

  test("closing the page with unsaved changes asks the browser to confirm, and a clean design does not", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.goto(`${owner.baseUrl}/designer`);
    const kinds: string[] = [];
    page.on("dialog", (dialog) => {
      kinds.push(dialog.type());
      void dialog.accept();
    });

    await page.reload();
    expect(kinds).toEqual([]);
    await page.getByRole("button", { name: "Add: Register table" }).click();
    await page.reload();
    expect(kinds).toEqual(["beforeunload"]);
    // The reload dropped what was not saved.
    await expect(page.getByRole("button", { name: /^Select widget: / })).toHaveCount(1);
    await expect(savedScreenWidgets(page, owner)).resolves.toBe(1);
  });

  test("the widget types and the registries have a message and a way to try again when they cannot be read", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await ready(page, owner);
    await createScreenWith(page, owner, [{ id: A, title: "Moja tabela", layout: LAYOUT }]);
    await page.route("**/api/v1/widget-types", (route) => route.abort("connectionfailed"));
    await page.goto(`${owner.baseUrl}/designer`);
    await expect(page.getByText(text(designer, "palette.failed"))).toBeVisible();
    await page.unroute("**/api/v1/widget-types");
    await page.getByRole("button", { name: text(designer, "retry") }).click();
    await expect(page.getByRole("button", { name: "Add: Register table" })).toBeVisible();
    await expect(page.getByText(text(widgets, "types.register-table")).first()).toBeVisible();
  });
});

async function savedScreenWidgets(page: Page, owner: BrowserOwner): Promise<number> {
  return (await savedScreen(page, owner)).widgets.length;
}
