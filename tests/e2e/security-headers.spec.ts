// D60.1-AC2 — the policy of the document against the built application in a real browser (DEV §9.59): every screen of the
// application, in the light and in the dark scheme and with a dashboard that holds a register table, is drawn without one
// violation of the Content-Security-Policy (no inline script, no inline style, nothing from another origin), and the
// header is on the document the browser got.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, createScreenWith, signInFully } from "./owner-session.ts";

test.use({ locale: "en-US" });

const VIOLATIONS = "__cspViolations";
const ROUTES = ["/main", "/registers", "/registers/ksiazki", "/registers/ksiazki/columns", "/designer", "/screens", "/dictionaries", "/config", "/settings", "/security", "/account", "/diagnostics", "/app", "/updates", "/style"] as const;

async function recordViolations(page: Page): Promise<void> {
  await page.context().addInitScript(`window.${VIOLATIONS} = []; document.addEventListener("securitypolicyviolation", (event) => window.${VIOLATIONS}.push(event.violatedDirective + " " + event.blockedURI + " " + event.sourceFile + ":" + event.lineNumber));`);
}
const violations = (page: Page): Promise<string[]> => page.evaluate((key) => (globalThis as unknown as Record<string, string[]>)[key] ?? [], VIOLATIONS);

test.describe("D60.1-AC2 the screens of the application under the policy", () => {
  test("the sign-in, and every screen after it in the light and the dark scheme, have no violation of the policy", async ({ page, ownerServer }) => {
    const owner = await ownerServer("ready");
    await recordViolations(page);
    const consoleProblems: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) consoleProblems.push(message.text());
    });

    const login = await page.goto(`${owner.baseUrl}/login`);
    expect(login?.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(login?.headers()["strict-transport-security"]).toBeUndefined();
    await expect(page.locator("#root")).not.toBeEmpty();
    expect(await violations(page), "the sign-in screen").toEqual([]);

    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    for (let index = 1; index <= 3; index += 1) await addRecordByApi(page, owner, "ksiazki", { tytul: `Książka ${index}`, autor: "Autor", cena: 1000 + index }, `seed-key-00${index}`);
    await createScreenWith(page, owner, [{ id: "019a0000-0000-7000-8000-0000000060a1", title: "Moje książki", layout: { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 4, h: 8 }, desktop: { x: 0, y: 0, w: 6, h: 8 } } }]);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const route of ROUTES) {
        await page.goto(`${owner.baseUrl}${route}`);
        await expect(page.locator("#root")).not.toBeEmpty();
        await page.waitForLoadState("domcontentloaded");
        expect(await violations(page), `${route} in the ${scheme} scheme`).toEqual([]);
      }
    }

    // What opens on a click draws its own layers (a window with a locked page, a menu, a list): they are the likely places of an inline style.
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await page.getByRole("button", { name: /^add/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await violations(page), "the window that adds a record").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.goto(`${owner.baseUrl}/designer`);
    const menus = page.getByRole("combobox");
    if ((await menus.count()) > 0) await menus.first().click();
    expect(await violations(page), "the Designer with a list open").toEqual([]);
    expect(consoleProblems).toEqual([]);
  });
});
