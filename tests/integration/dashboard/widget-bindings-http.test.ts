// D34.2 — the bindings of the register table over real HTTP on the built server (Scope §6.2,
// Architektura §8.1, §18.5): on Książki of F01 and its table widget made through the API.
// AC1: the columns saved in another order with a sort column come back in that order, and the data of
//      the widget has its columns in that order and its rows sorted by that column.
// AC2: an unknown slot, a target of a kind the slot does not take, a registry of nobody and an unknown
//      type are refused with 422 at their paths, and the screen is as it was.
import { screenDesignPath, screenPath, screenSchema, widgetDataPath, widgetDataSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { send, stopServers } from "../../support/auth-http.ts";
import { booksOverApi, columnId, SCREEN, tableWidget } from "../../support/books-http.ts";

afterEach(stopServers);

type Binding = { slot: string; ordinal: number; path: string; target: Record<string, unknown> };

describe("D34.2-AC1 the order of the columns and the sort column", () => {
  it("columns saved as Status, Autor, Tytuł sorted by Tytuł ascending come back in that order, and the data reads in it", async () => {
    const { setup, cookie, registry, screenId } = await booksOverApi("d34-2-order");
    const table = tableWidget(registry);
    const column = (symbol: string, slot: string, ordinal: number): Binding => ({ slot, ordinal, path: `Field.Register.ksiazki.${symbol}`, target: { kind: "column", registryId: registry.id, columnId: columnId(registry, symbol) } });
    const bindings: Binding[] = [
      { slot: "registry", ordinal: 0, path: "Field.Register.ksiazki", target: { kind: "registry", registryId: registry.id } },
      column("status", "columns", 0),
      column("autor", "columns", 1),
      column("tytul", "columns", 2),
      column("tytul", "sortColumn", 0),
    ];
    const reply = await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [{ ...table, config: { ...table.config, sortDirection: "asc" }, bindings }] }, { cookie });
    expect(reply.status).toBe(200);

    const screen = screenSchema.parse((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json());
    expect(screen.widgets[0]!.bindings.map(({ slot, ordinal, path }) => `${slot}.${ordinal}:${path}`)).toEqual([
      "registry.0:Field.Register.ksiazki",
      "columns.0:Field.Register.ksiazki.status",
      "columns.1:Field.Register.ksiazki.autor",
      "columns.2:Field.Register.ksiazki.tytul",
      "sortColumn.0:Field.Register.ksiazki.tytul",
    ]);
    const data = widgetDataSchema.parse((await send(setup.server, "GET", widgetDataPath(table.id), undefined, { cookie })).json());
    expect(data.columns.map((each) => each.displayName)).toEqual(["Status", "Autor", "Tytuł"]);
    const key = data.columns[2]!.key;
    const titles = data.rows.map((row) => String(row.values[key]));
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, "pl")));
  });
});

describe("D34.2-AC2 what the API refuses", () => {
  it("an unknown slot, a kind the slot does not take, a registry of nobody and an unknown type are 422 at their paths, and the screen is as it was", async () => {
    const { setup, cookie, registry, screenId } = await booksOverApi("d34-2-refuse");
    const table = tableWidget(registry);
    const before = (await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json();
    const put = (widget: unknown) => send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [widget] }, { cookie });
    const issuesOf = (reply: { json: () => unknown }): string[] => ((reply.json() as { details: { issues: Array<{ path: string; code: string }> } }).details.issues ?? []).map((issue) => `${issue.path}:${issue.code}`);
    const registryBinding = table.bindings.find((binding) => binding.slot === "registry")!;
    const attempts: Array<[string, unknown, string]> = [
      ["an unknown slot", { ...table, bindings: [...table.bindings, { ...registryBinding, slot: "filter" }] }, "widgets.0.bindings:SLOT_UNKNOWN"],
      ["a registry under the slot of the columns", { ...table, bindings: [...table.bindings.filter((binding) => binding.slot !== "columns"), { ...registryBinding, slot: "columns" }] }, "widgets.0.bindings:TARGET_KIND_NOT_ACCEPTED"],
      ["a registry of nobody", { ...table, bindings: [{ ...registryBinding, target: { kind: "registry", registryId: "019a0000-0000-7000-8000-0000000034ff" } }] }, "widgets.0.bindings.0.target:TARGET_UNKNOWN"],
      ["an unknown type", { ...table, type: "weather" }, "widgets.0.type:WIDGET_TYPE_UNKNOWN"],
    ];
    for (const [name, widget, issue] of attempts) {
      const reply = await put(widget);
      expect([name, reply.status]).toEqual([name, 422]);
      expect(issuesOf(reply), name).toContain(issue);
      expect((await send(setup.server, "GET", screenPath(screenId), undefined, { cookie })).json(), name).toEqual(before);
    }
  });
});
