// What the browser tests of the private screens share: the owner past the password and the second
// factor, a registry made with the session of the page, and the accessibility check.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { registryRecordsPath } from "@openlife/contracts/http/records";
import type { BrowserOwner } from "../support/auth-http.ts";
import { expect, locale, text } from "./fixtures.ts";

const auth = locale("en", "auth");

export async function expectNoViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The owner past the password and the second factor, on the private screen. */
export async function signInFully(page: Page, owner: BrowserOwner): Promise<void> {
  await page.goto(`${owner.baseUrl}/login`);
  await page.getByLabel(text(auth, "login.email"), { exact: true }).fill(owner.email);
  await page.getByLabel(text(auth, "login.password"), { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: text(auth, "login.submit") }).click();
  await page.getByLabel(text(auth, "mfa.codeLabel")).fill(await owner.code(1));
  await expect(page).toHaveURL(`${owner.baseUrl}/main`);
}

export async function createRegistry(page: Page, owner: BrowserOwner, definition: { symbol: string; displayName: string; columns: unknown[] }): Promise<void> {
  const reply = await page.request.post(`${owner.baseUrl}${REGISTRIES_PATH}`, { data: definition, headers: { Origin: owner.baseUrl } });
  expect(reply.status()).toBe(201);
}

/** A record added with the session of the page, under a key of its own. */
export async function addRecordByApi(page: Page, owner: BrowserOwner, symbol: string, values: Record<string, unknown>, key: string): Promise<void> {
  const reply = await page.request.post(`${owner.baseUrl}${registryRecordsPath(symbol)}`, { data: { schemaRevision: 1, values }, headers: { Origin: owner.baseUrl, "Idempotency-Key": key } });
  expect(reply.status()).toBe(201);
}

/** Książki as F01 defines it, in the form a client sends. */
export const BOOKS_DEFINITION = {
  symbol: "ksiazki",
  displayName: "Książki",
  columns: [
    { symbol: "tytul", displayName: "Tytuł", type: "text", required: true },
    { symbol: "autor", displayName: "Autor", type: "text" },
    { symbol: "strony", displayName: "Liczba stron", type: "number", typeOptions: { decimalPlaces: 0 } },
    { symbol: "cena", displayName: "Cena", type: "money" },
    { symbol: "data_ukonczenia", displayName: "Data ukończenia", type: "date" },
    { symbol: "rozpoczeto", displayName: "Rozpoczęto", type: "datetime" },
    { symbol: "przypomnienie", displayName: "Godzina przypomnienia", type: "time" },
    { symbol: "ponowne_czytanie", displayName: "Ponowne czytanie", type: "boolean", defaultValue: false },
    { symbol: "status", displayName: "Status", type: "choice", defaultValue: "planowane" },
  ],
};

/** A widget layout as the contract writes it. */
export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type WidgetPlan = Readonly<{
  id: string;
  title?: string;
  columns?: string[];
  pageSize?: number;
  allowAdd?: boolean;
  layout: Readonly<{ phone: Rect; tablet: Rect; desktop: Rect }>;
  /** No bindings at all: a draft. */
  draft?: boolean;
}>;

/**
 * The first screen of the owner with register tables of Książki, made through the API with the
 * session of the page (as the Designer of D18.2 will): the registry must exist already.
 */
export async function createScreenWith(page: Page, owner: BrowserOwner, plans: readonly WidgetPlan[], name = "Test MVP"): Promise<string> {
  const base = owner.baseUrl;
  const headers = { Origin: base };
  const registries = (await (await page.request.get(`${base}${REGISTRIES_PATH}`)).json()) as { registries: Array<{ id: string; symbol: string; columns: Array<{ id: string; symbol: string }> }> };
  const registry = registries.registries.find((candidate) => candidate.symbol === "ksiazki");
  if (registry === undefined) throw new Error("create Książki first");
  const created = await page.request.post(`${base}/api/v1/screens`, { data: { name }, headers });
  expect(created.status()).toBe(201);
  const screenId = ((await created.json()) as { id: string }).id;
  const widgets = plans.map((plan) => {
    const symbols = plan.columns ?? ["tytul", "autor"];
    const bindings = plan.draft
      ? []
      : [
          { slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: registry.id } },
          ...symbols.map((symbol, ordinal) => ({ slot: "columns", ordinal, path: `Field.Register.ksiazki.${symbol}`, target: { kind: "column", registryId: registry.id, columnId: registry.columns.find((column) => column.symbol === symbol)!.id } })),
          { slot: "sortColumn", ordinal: 0, path: "Field.Register.ksiazki.created_at", target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
        ];
    return {
      id: plan.id,
      type: "register-table",
      config: { v: 1, title: plan.title ?? "", pageSize: plan.pageSize ?? 10, sortDirection: "desc", allowAdd: plan.allowAdd ?? true },
      layout: plan.layout,
      bindings,
    };
  });
  const saved = await page.request.put(`${base}/api/v1/screens/${screenId}/design`, { data: { name, theme: "dark", accent: "blue", widgets }, headers });
  expect(saved.status()).toBe(200);
  return screenId;
}
