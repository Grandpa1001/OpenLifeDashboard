// D47.1 — the template of a screen over HTTP (Architektura Załącznik G; DEV §9.44).
// AC1: the template of the screen of F01 holds no identifier and no data, its bindings are paths, a broken binding
//      keeps its path, and a widget of a type this build lacks is kept as it was stored.
// AC2: 401, 403 before the gate, 404 for a screen that is not the owner's, and a file that is strict.
import { readFileSync } from "node:fs";
import path from "node:path";
import { screenTemplateSchema } from "@openlife/contracts/export/screen-template";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenSchema, screenTemplatePath } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { withoutDictionary } from "../../support/books-fixture.ts";
import { repoRoot } from "../../support/server-process.ts";
import { createSignedInHarness } from "../../support/signed-in-harness.ts";

afterEach(() => closeHarnesses());

type FixtureColumn = { symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as { registries: Array<{ symbol: string; displayName: string; columns: FixtureColumn[] }> };
const BOOKS = fixture.registries[0]!;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const WIDGET = "019a0000-0000-7000-8000-00000000019a";
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };
const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;

async function ready() {
  const { h, cookie } = await createSignedInHarness();
  const booksRequest = {
    symbol: BOOKS.symbol,
    displayName: BOOKS.displayName,
    columns: BOOKS.columns.map(({ symbol, displayName, type, typeOptions, defaultValue, required }) => ({ symbol, displayName, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })),
  };
  expect((await h.request("POST", REGISTRIES_PATH, booksRequest, { cookie })).status).toBe(201);
  const registry = registryListSchema.parse((await h.request("GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
  const screen = screenSchema.parse((await h.request("POST", SCREENS_PATH, { name: "Ekran książek" }, { cookie })).json());
  const column = (symbol: string) => registry.columns.find((candidate) => candidate.symbol === symbol)!;
  const table = {
    id: WIDGET,
    type: "register-table",
    config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true },
    layout: LAYOUT,
    bindings: [
      { slot: "registry", ordinal: 0, path: `Field.Register.${registry.symbol}`, target: { kind: "registry", registryId: registry.id } },
      { slot: "columns", ordinal: 0, path: `Field.Register.${registry.symbol}.tytul`, target: { kind: "column", registryId: registry.id, columnId: column("tytul").id } },
      { slot: "columns", ordinal: 1, path: `Field.Register.${registry.symbol}.autor`, target: { kind: "column", registryId: registry.id, columnId: column("autor").id } },
      { slot: "sortColumn", ordinal: 0, path: `Field.Register.${registry.symbol}.created_at`, target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
    ],
  };
  const saved = await h.request("PUT", screenDesignPath(screen.id), { name: "Ekran książek", theme: "dark", accent: "green", widgets: [table] }, { cookie });
  expect(saved.status).toBe(200);
  return { h, cookie, registry, screen, table };
}

describe("D47.1-AC1 the template of a screen", () => {
  it("is the design without any identifier or data: the type, the configuration, the layouts and the bindings as paths", async () => {
    const { h, cookie, screen } = await ready();
    const response = await h.open(screenTemplatePath(screen.id), { cookie });
    expect(response.status).toBe(200);
    const text = await response.text();
    const reply = { headers: response.headers, text, json: () => JSON.parse(text) as unknown };
    expect(reply.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("content-disposition")).toMatch(/^attachment; filename="openlifedashboard-screen-\d{4}-\d{2}-\d{2}\.json"$/);
    const file = screenTemplateSchema.parse(reply.json());
    expect(file).toMatchObject({ format: "openlifedashboard-screen-template", formatVersion: 1, appVersion: "0.0.0" });
    expect(file.screen).toEqual({
      name: "Ekran książek",
      theme: "dark",
      accent: "green",
      widgets: [
        {
          type: "register-table",
          config: { v: 1, title: "Moje książki", pageSize: 10, sortDirection: "desc", allowAdd: true },
          layout: LAYOUT,
          bindings: [
            { slot: "registry", ordinal: 0, path: "Field.Register.ksiazki" },
            { slot: "columns", ordinal: 0, path: "Field.Register.ksiazki.tytul" },
            { slot: "columns", ordinal: 1, path: "Field.Register.ksiazki.autor" },
            { slot: "sortColumn", ordinal: 0, path: "Field.Register.ksiazki.created_at" },
          ],
        },
      ],
    });
    // Nothing that names a thing of this installation, and no record.
    expect(reply.text).not.toMatch(UUID);
    expect(reply.text).not.toMatch(/ownerId|user_id|target|registryId|columnId|Książka/);
  });

  it("keeps the path of a binding that broke since it was saved", async () => {
    const { h, cookie, screen } = await ready();
    h.sql("UPDATE registry_column SET deleted_at = '2026-10-28T12:00:00.000Z' WHERE symbol = 'autor'");
    const view = screenSchema.parse((await h.request("GET", `${SCREENS_PATH}/${screen.id}`, undefined, { cookie })).json());
    expect(view.widgets[0]!.state).toBe("needs_rebinding");
    const file = screenTemplateSchema.parse((await h.request("GET", screenTemplatePath(screen.id), undefined, { cookie })).json());
    expect(file.screen.widgets[0]!.bindings.map((binding) => binding.path)).toContain("Field.Register.ksiazki.autor");
  });
});

describe("D47.1-AC2 who may read it", () => {
  it("is 401 without a session, 404 for a screen that does not exist, and no template is cached", async () => {
    const { h, cookie, screen } = await ready();
    const anonymous = await h.request("GET", screenTemplatePath(screen.id), undefined, { cookie: null });
    expect([anonymous.status, code(anonymous)]).toEqual([401, "AUTH_REQUIRED"]);
    for (const id of ["019a0000-0000-7000-8000-0000000009ff", "nope"]) {
      const missing = await h.request("GET", screenTemplatePath(id), undefined, { cookie });
      expect([id, missing.status, code(missing)]).toEqual([id, 404, "NOT_FOUND"]);
    }
  });

  it("is refused before the gate of the data: a session of the password alone has not passed the second factor", async () => {
    const h = await createAppHarness();
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const reply = await h.request("GET", screenTemplatePath("019a0000-0000-7000-8000-0000000009ff"), undefined, { cookie: password });
    expect([reply.status, code(reply)]).toEqual([403, "MFA_REQUIRED"]);
  });
});
