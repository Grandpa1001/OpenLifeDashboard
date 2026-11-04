// D35.1 — the autosave of the Designer in a real browser (Scope §5.4; Architektura §18.5; makieta 29)
// on Książki of F01 and one register table.
// AC1: a change saves itself with "Saving…" and "Saved HH:MM"; two changes within a second are one PUT
//      with both; a change made while a save is in flight stays and goes with the next PUT; Finish
//      right after a change saves and leaves without asking.
// AC2: a 503 says "trying again" and the next try saves; a 422 is not tried in a loop; "Saved" never
//      shows before the server answered.
import type { Locator, Page, Route } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { BOOKS_DEFINITION, createRegistry, createScreenWith, designerSaved, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

const A = "019a0000-0000-7000-8000-0000000035a1";
const DESIGN = /\/api\/v1\/screens\/[^/]+\/design$/;
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };
const status = (page: Page): Locator => page.locator(".designer-status");
const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const titleField = (page: Page): Locator => bar(page).getByLabel(text(designer, "bar.title"), { exact: true });
const pageSizeField = (page: Page): Locator => bar(page).getByLabel(text(designer, "bar.pageSizeWithRange").replace("{{min}}", "1").replace("{{max}}", "100"), { exact: true });
/** "Saved" and the time in the owner's language: 14:32, or 2:32 PM in English. */
const SAVED_AT = new RegExp(`^${text(designer, "toolbar.savedAt").replace("{{time}}", "\\d{1,2}:\\d{2}( [AP]M)?")}$`);

async function onTheServer(page: Page, owner: BrowserOwner): Promise<Record<string, unknown>> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  const screen = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Array<{ config: Record<string, unknown> }> };
  return screen.widgets[0]!.config;
}

async function tableSelected(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await createRegistry(page, owner, BOOKS_DEFINITION);
  await createScreenWith(page, owner, [{ id: A, title: "Moje", layout: LAYOUT }]);
  await page.goto(`${owner.baseUrl}/designer`);
  await page.getByRole("button", { name: "Select widget: Moje" }).click();
  await expect(titleField(page)).toBeEnabled();
}

/** Counts the PUTs of the design; `hold` keeps each one waiting until it is let go. */
function watchSaves(page: Page): { count: () => number; hold: (on: boolean) => void; release: () => void } {
  let count = 0;
  let holding = false;
  const held: Route[] = [];
  void page.route(DESIGN, async (route) => {
    count += 1;
    if (holding) held.push(route);
    else await route.continue();
  });
  return {
    count: () => count,
    hold: (on) => {
      holding = on;
    },
    release: () => {
      for (const route of held.splice(0)) void route.continue();
    },
  };
}

test.describe("D35.1-AC1 every change saves itself", () => {
  test("a change shows Saving… and then Saved HH:MM with no button; two changes within a second are one save with both", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableSelected(page, owner);
    await expect(status(page)).toHaveText(text(designer, "toolbar.clean"));
    const saves = watchSaves(page);
    await titleField(page).fill("Półka");
    await pageSizeField(page).fill("25");
    await expect(status(page)).toHaveText(text(designer, "toolbar.saving"));
    await designerSaved(page);
    await expect(status(page)).toHaveText(SAVED_AT);
    expect(saves.count()).toBe(1);
    expect(await onTheServer(page, owner)).toMatchObject({ title: "Półka", pageSize: 25 });
    await expectNoViolations(page);
  });

  test("a change made while a save is in flight stays and goes with the next save; Saved shows only after the answer", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableSelected(page, owner);
    const saves = watchSaves(page);
    saves.hold(true);
    await titleField(page).fill("Pierwszy");
    await expect.poll(saves.count).toBe(1);
    // The first save waits for its answer: the bar still says Saving…, never Saved.
    await titleField(page).fill("Drugi");
    await page.waitForTimeout(1500);
    await expect(status(page)).toHaveText(text(designer, "toolbar.saving"));
    expect(saves.count()).toBe(1);
    saves.hold(false);
    saves.release();
    await designerSaved(page);
    expect(saves.count()).toBe(2);
    await expect(titleField(page)).toHaveValue("Drugi");
    expect(await onTheServer(page, owner)).toMatchObject({ title: "Drugi" });
  });

  test("Finish right after a change saves it and leaves without asking", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableSelected(page, owner);
    await titleField(page).fill("Na koniec");
    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    await expect(page).toHaveURL(`${owner.baseUrl}/`);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await onTheServer(page, owner)).toMatchObject({ title: "Na koniec" });
  });
});

test.describe("D35.1-AC2 a server that fails or refuses", () => {
  test("a 503 says it tries again and the next try saves; a 422 is told once and not tried in a loop", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await tableSelected(page, owner);
    let unavailable = 1;
    let puts = 0;
    await page.route(DESIGN, async (route) => {
      puts += 1;
      if (unavailable > 0) {
        unavailable -= 1;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "MAINTENANCE", message: "x", details: null, requestId: "req-503" }) });
      } else await route.continue();
    });
    await titleField(page).fill("Po przerwie");
    await expect(status(page)).toHaveText(text(designer, "toolbar.retrying"));
    await designerSaved(page);
    expect(puts).toBe(2);
    expect(await onTheServer(page, owner)).toMatchObject({ title: "Po przerwie" });

    await page.unroute(DESIGN);
    let refused = 0;
    await page.route(DESIGN, async (route) => {
      refused += 1;
      await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ code: "VALIDATION_FAILED", message: "x", details: null, requestId: "req-422" }) });
    });
    await titleField(page).fill("Odrzucony");
    await expect(status(page)).toHaveText(text(designer, "toolbar.refused"));
    await page.waitForTimeout(4000);
    expect(refused).toBe(1);
    await expect(titleField(page)).toHaveValue("Odrzucony");
  });
});
