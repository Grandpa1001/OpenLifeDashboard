// D36.2 — the clock in the Designer in a real browser (Scope §5.4, §6.3; makiety 27, 34): added from the
// window Add widget with its defaults and a place in the three layouts, set up in the one row of its bar
// (the zone found by a fragment, 12 hours, a caption, seconds, no date) and shown so on the screen; its
// copy carries "(copy)" in its caption.
// AC1: the clock from the window, its defaults saved, Europe/London, 12 h, Londyn, seconds and no date on
//      the screen. AC2: an unknown zone stays in the field and out of the design; the owner's zone is the
//      first of the list; undo takes a change of the clock back; Escape back on the tile; axe.
import type { Locator, Page } from "@playwright/test";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, test, text } from "./fixtures.ts";
import { designerSaved, expectNoViolations, signInFully } from "./owner-session.ts";

const designer = locale("en", "designer");
const widgets = locale("en", "widgets");
test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

type Saved = Array<{ id: string; type: string; config: Record<string, unknown>; layout: Record<string, { x: number; y: number; w: number; h: number }> }>;
const bar = (page: Page): Locator => page.getByRole("region", { name: text(designer, "bar.label") });
const zoneField = (page: Page): Locator => bar(page).getByLabel(text(designer, "clock.zone"), { exact: true });

async function onTheServer(page: Page, owner: BrowserOwner): Promise<Saved> {
  const listed = (await (await page.request.get(`${owner.baseUrl}/api/v1/screens`)).json()) as { screens: Array<{ id: string }> };
  return ((await (await page.request.get(`${owner.baseUrl}/api/v1/screens/${listed.screens[0]!.id}`)).json()) as { widgets: Saved }).widgets;
}

async function clockAdded(page: Page, owner: BrowserOwner): Promise<void> {
  await signInFully(page, owner);
  await page.goto(`${owner.baseUrl}/designer`);
  await page.getByRole("button", { name: text(designer, "create.submit") }).click();
  await bar(page).getByRole("button", { name: text(designer, "bar.addWidget"), exact: true }).click();
  const catalog = page.getByRole("dialog", { name: text(designer, "palette.heading") });
  const type = catalog.getByRole("button", { name: `Add: ${text(widgets, "types.clock")}` });
  await expect(type).toHaveAccessibleDescription(text(widgets, "typeDescriptions.clock"));
  await type.click();
  await expect(zoneField(page)).toHaveValue(text(designer, "clock.ownerZone"));
}

test.describe("D36.2-AC1 a clock from the window, set up in its bar", () => {
  test("the clock has its defaults and a place in the three layouts; Europe/London, 12 h, Londyn, seconds and no date are on the screen", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await clockAdded(page, owner);
    // One row: no bindings, the time first.
    await expect(bar(page).getByRole("region", { name: text(designer, "panel.heading") })).toHaveCount(0);
    await designerSaved(page);
    const [added] = await onTheServer(page, owner);
    expect(added!.type).toBe("clock");
    expect(added!.config).toEqual({ v: 1, timezone: "owner", label: "", format: "24h", showSeconds: false, showDate: true });
    expect(added!.layout).toEqual({ phone: { x: 0, y: 0, w: 1, h: 3 }, tablet: { x: 0, y: 0, w: 4, h: 3 }, desktop: { x: 0, y: 0, w: 4, h: 3 } });
    await expect(page.getByRole("button", { name: `Select widget: ${text(widgets, "types.clock")}` })).toContainText(text(widgets, "types.clock"));
    await expectNoViolations(page);

    await zoneField(page).fill("Europe/London");
    await bar(page).getByRole("radio", { name: text(designer, "clock.12h") }).check();
    const caption = bar(page).getByLabel(text(designer, "clock.label"), { exact: true });
    await caption.fill("Londyn");
    await caption.blur();
    await bar(page).getByRole("switch", { name: text(designer, "clock.seconds") }).check();
    await bar(page).getByRole("switch", { name: text(designer, "clock.date") }).uncheck();
    await designerSaved(page);
    expect((await onTheServer(page, owner))[0]!.config).toEqual({ v: 1, timezone: "Europe/London", label: "Londyn", format: "12h", showSeconds: true, showDate: false });
    // The tile is named by the caption and says its zone.
    await expect(page.locator(".designer-widget").filter({ has: page.getByRole("button", { name: "Select widget: Londyn" }) })).toContainText("Europe/London");

    // A copy of a clock carries "(copy)" in its caption, which its schema has, and saves.
    await bar(page).getByRole("button", { name: text(designer, "bar.duplicate") }).click();
    await designerSaved(page);
    expect((await onTheServer(page, owner)).map((widget) => widget.config["label"])).toEqual(["Londyn", `Londyn ${text(designer, "bar.copySuffix")}`]);
    await page.getByRole("button", { name: text(designer, "toolbar.undo"), exact: true }).click();
    await designerSaved(page);

    await page.getByRole("button", { name: text(designer, "toolbar.finish"), exact: true }).click();
    const clock = page.getByRole("region", { name: `${text(widgets, "types.clock")}: Londyn` });
    await expect(clock.locator("time")).toHaveText(/^\d{2}:\d{2}:\d{2} [AP]M$/);
    await expect(clock).toContainText("Londyn · Europe/London");
    await expect(clock.locator(".clock-date")).toHaveCount(0);
  });
});

test.describe("D36.2-AC2 what the bar of a clock refuses and how it is used", () => {
  test("an unknown zone stays in the field and out of the design; the owner's zone leads the list; undo takes the format back; Escape goes back to the tile", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await clockAdded(page, owner);
    await designerSaved(page);
    const options = await page.locator(`datalist#${await zoneField(page).getAttribute("list")} option`).evaluateAll((all) => all.slice(0, 2).map((option) => (option as unknown as { value: string }).value));
    expect(options[0]).toBe(text(designer, "clock.ownerZone"));
    expect(options[1]).toMatch(/^[A-Z][a-z]+\//);

    await zoneField(page).fill("Mars/Olympus");
    await expect(zoneField(page)).toHaveAttribute("aria-invalid", "true");
    await expect(bar(page).getByText(text(designer, "clock.zoneUnknown"))).toBeVisible();
    await expect(page.locator(".designer-status")).toHaveAttribute("data-dirty", "false");
    await expectNoViolations(page);
    await zoneField(page).fill("America/New_York");
    await expect(zoneField(page)).not.toHaveAttribute("aria-invalid", "true");

    await bar(page).getByRole("radio", { name: text(designer, "clock.12h") }).check();
    await page.getByRole("button", { name: text(designer, "toolbar.undo"), exact: true }).click();
    await expect(bar(page).getByRole("radio", { name: text(designer, "clock.24h") })).toBeChecked();
    await designerSaved(page);
    expect((await onTheServer(page, owner))[0]!.config).toMatchObject({ timezone: "America/New_York", format: "24h" });

    await bar(page).getByRole("radio", { name: text(designer, "clock.24h") }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: `Select widget: ${text(widgets, "types.clock")}` })).toBeFocused();
  });
});
