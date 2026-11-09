// D38.2 — the changes of another tab and the message of a lost connection, in a real browser on the built
// server (Scope §5.3, §5.4 S11; Architektura §7.6, §10).
// AC1: a record added in tab A is on the screen of tab B within a second, without a reload.
// AC2: a stream lost for longer than a moment says "no connection"; its return hides the message and the
//      screen shows what changed meanwhile.
import { STREAM_PATH } from "@openlife/contracts/http/stream";
import { expect, locale, test, text } from "./fixtures.ts";
import { addRecordByApi, BOOKS_DEFINITION, createRegistry, signInFully } from "./owner-session.ts";

const common = locale("en");
test.use({ locale: "en-US", viewport: { width: 1280, height: 800 } });

/** The time a change of tab A has to reach tab B (Scope §5.4 S11). */
const REACHES_WITHIN_MS = 1000;

test.describe("D38.2-AC1 a change of another tab, without a reload", () => {
  test("a record added in tab A appears in the table of tab B within a second", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await addRecordByApi(page, owner, "ksiazki", { tytul: "Pierwsza książka" }, "d38-2-first");
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect(page.getByRole("cell", { name: "Pierwsza książka", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate("document.documentElement.dataset.liveStream ?? null")).toBe("live");

    const tabA = await context.newPage();
    await tabA.goto(`${owner.baseUrl}/registers/ksiazki`);
    await addRecordByApi(tabA, owner, "ksiazki", { tytul: "Książka z karty A" }, "d38-2-from-a");
    await expect(page.getByRole("cell", { name: "Książka z karty A", exact: true })).toBeVisible({ timeout: REACHES_WITHIN_MS });
  });
});

test.describe("D38.2-AC2 the message of a lost connection", () => {
  test("a stream lost for longer than a moment shows the message, and its return hides it and reads what changed", async ({ page, context, ownerServer }) => {
    const owner = await ownerServer("ready");
    await signInFully(page, owner);
    await createRegistry(page, owner, BOOKS_DEFINITION);
    await page.goto(`${owner.baseUrl}/registers/ksiazki`);
    await expect.poll(() => page.evaluate("document.documentElement.dataset.liveStream ?? null")).toBe("live");
    const message = page.getByRole("status").filter({ hasText: text(common, "connection.lost") });
    await expect(message).toHaveCount(0);

    // The server returns, but the way to the stream stays cut: the tab stays offline.
    await page.route(`**${STREAM_PATH}`, (route) => route.abort("connectionfailed"));
    await owner.restart();
    await expect(message).toBeVisible({ timeout: 30_000 });

    // Meanwhile another tab writes; this one has heard nothing.
    const tabA = await context.newPage();
    await addRecordByApi(tabA, owner, "ksiazki", { tytul: "Zapisana w czasie przerwy" }, "d38-2-meanwhile");
    await expect(page.getByRole("cell", { name: "Zapisana w czasie przerwy", exact: true })).toHaveCount(0);

    await page.unroute(`**${STREAM_PATH}`);
    await page.evaluate('window.dispatchEvent(new Event("focus"))');
    await expect(message).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Zapisana w czasie przerwy", exact: true })).toBeVisible();
  });
});
