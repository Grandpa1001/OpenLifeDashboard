// D36.1 — the clocks of F01 on the screen in a real browser (Scope §5.3, §6.3) at the first moment of
// F02 set on the clock of the browser: Dom in the zone of the owner (Europe/Warsaw), Nowy Jork in
// its own with seconds, each with its date and caption; the minute moves the time; axe.
import type { Page } from "@playwright/test";
import { SCREENS_PATH, screenDesignPath } from "@openlife/contracts/http/screens";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../support/server-process.ts";
import { expect, test } from "./fixtures.ts";
import { expectNoViolations, signInFully } from "./owner-session.ts";

test.use({ locale: "en-US", viewport: { width: 1440, height: 900 } });

type Widget = { id: string; type: string; config: Record<string, unknown>; layout: unknown; bindings: unknown[] };
const F01 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { screens: Array<{ name: string; widgets: Widget[] }> };
const F02 = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.expected.json"), "utf8")) as { fixedClockCases: Array<{ nowIso: string; "Europe/Warsaw": string; "America/New_York": string }> };
const CLOCKS = F01.screens[0]!.widgets.filter((widget) => widget.type === "clock");

const clockOf = (page: Page, label: string) => page.getByRole("region", { name: `Clock: ${label}` });

test.describe("D36.1-AC1 the clocks of F01 on the screen", () => {
  test("Dom shows the owner's zone and Nowy Jork its own with seconds, with dates and captions, and the next minute moves them", async ({ page, ownerServer }) => {
    const moment = F02.fixedClockCases[0]!;
    // The clock of the page starts at the moment and runs: a paused clock would hold the timers of the page too.
    await page.clock.install({ time: new Date(moment.nowIso) });
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    const created = await page.request.post(`${owner.baseUrl}${SCREENS_PATH}`, { data: { name: F01.screens[0]!.name }, headers: { Origin: owner.baseUrl } });
    const screenId = ((await created.json()) as { id: string }).id;
    expect((await page.request.put(`${owner.baseUrl}${screenDesignPath(screenId)}`, { data: { name: F01.screens[0]!.name, theme: "dark", accent: "blue", widgets: CLOCKS }, headers: { Origin: owner.baseUrl } })).status()).toBe(200);
    await page.goto(`${owner.baseUrl}/`);

    const home = clockOf(page, "Dom");
    const away = clockOf(page, "Nowy Jork");
    await expect(home.locator("time")).toHaveText(moment["Europe/Warsaw"]);
    await expect(away.locator("time")).toHaveText(new RegExp(`^${moment["America/New_York"]}:[0-5]\\d$`));
    await expect(home).toContainText("Dom · Europe/Warsaw");
    await expect(away).toContainText("Nowy Jork · America/New_York");
    await expect(home).toContainText("Sunday, 29.03.2026");
    await expect(away).toContainText("Saturday, 28.03.2026");
    await expect(home.locator("time")).toHaveAttribute("datetime", /^2026-03-29T00:3\d:/);
    await expectNoViolations(page);

    // A minute later both have moved; New York shows its seconds.
    await page.clock.fastForward(60_000);
    await expect(home.locator("time")).toHaveText("01:31");
    await expect(away.locator("time")).toHaveText(/^20:31:[0-5]\d$/);
  });
});
