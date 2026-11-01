// Książki of F01 made through the real API of the built server, with its 25 records and the screen
// of F01 with its table widget bound to the server's identifiers: the starting point of the tests of a
// change of the structure over HTTP (D26.2, D28.2).
import { readFileSync } from "node:fs";
import path from "node:path";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, type RegistryDto } from "@openlife/contracts/http/registries";
import { SCREENS_PATH, screenDesignPath, screenSchema } from "@openlife/contracts/http/screens";
import { installation, post, query, readyOwner, send, type Installation } from "./auth-http.ts";
import { withoutDictionary } from "./books-fixture.ts";
import { repoRoot } from "./server-process.ts";

type FixtureColumn = { id: string; symbol: string; displayName: string; type: string; typeOptions: unknown; defaultValue: unknown; required: boolean };
type FixtureBinding = { slot: string; ordinal: number; path: string; target: { kind: string; registryId?: string; columnId?: string; symbol?: string } };
export type FixtureWidget = { id: string; type: string; config: Record<string, unknown>; layout: unknown; bindings: FixtureBinding[] };
const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/books/books-v1.export.json"), "utf8")) as {
  registries: Array<{ id: string; symbol: string; displayName: string; columns: FixtureColumn[]; records: Array<{ values: Record<string, unknown> }> }>;
  screens: Array<{ name: string; widgets: FixtureWidget[] }>;
};
export const BOOKS = fixture.registries[0]!;
export const SCREEN = fixture.screens[0]!;
export const TABLE = SCREEN.widgets.find((widget) => widget.type === "register-table")!;

/** A definition as a client sends it, without the dictionary the fixture names (see books-fixture.ts). */
export const definitionOf = (symbol: string, displayName: string, columns: ReadonlyArray<Omit<FixtureColumn, "id">>) => ({
  symbol,
  displayName,
  columns: columns.map(({ symbol: column, displayName: name, type, typeOptions, defaultValue, required }) => ({ symbol: column, displayName: name, type, typeOptions: withoutDictionary(typeOptions), defaultValue, required })),
});

/** Everything a change of the structure could touch, as one text. */
export function stored(setup: Installation): string {
  const tables = ["registry", "registry_column", "screen", "widget", "binding", "idempotency_entry", "audit_log", ...query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1").map((row) => row.name)];
  return JSON.stringify(tables.map((table) => query(setup.instance, `SELECT * FROM "${table}" ORDER BY 1`)));
}

export const registryOf = async (setup: Installation, cookie: string, symbol: string): Promise<RegistryDto> => {
  const found = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries.find((registry) => registry.symbol === symbol);
  if (found === undefined) throw new Error(`no registry ${symbol}`);
  return found;
};

export const columnId = (registry: RegistryDto, symbol: string): string => registry.columns.find((column) => column.symbol === symbol)!.id;

/** The table widget of F01 bound to the server's identifiers of Książki. */
export function tableWidget(registry: RegistryDto): FixtureWidget {
  const columnIdOf = (fixtureId: string): string => columnId(registry, BOOKS.columns.find((each) => each.id === fixtureId)!.symbol);
  return {
    ...TABLE,
    bindings: TABLE.bindings.map((binding) => ({ ...binding, target: { ...binding.target, registryId: registry.id, ...(binding.target.columnId === undefined ? {} : { columnId: columnIdOf(binding.target.columnId) }) } })),
  };
}

/** Książki with the 25 records of F01 and the screen of F01 with its table widget; `keyPrefix` keeps the idempotency keys of a test its own. */
export async function booksOverApi(keyPrefix: string): Promise<{ setup: Installation; cookie: string; registry: RegistryDto; screenId: string }> {
  const setup = await installation();
  const cookie = (await readyOwner(setup)).sessionCookie;
  const created = await post(setup.server, REGISTRIES_PATH, definitionOf(BOOKS.symbol, BOOKS.displayName, BOOKS.columns), { cookie });
  if (created.status !== 201) throw new Error(`Książki was not created: ${created.status}`);
  for (const [index, record] of BOOKS.records.entries()) {
    const added = await post(setup.server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: record.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `${keyPrefix}-add-${index}` } });
    if (added.status !== 201) throw new Error(`a record of F01 was not added: ${added.status}`);
  }
  const registry = await registryOf(setup, cookie, BOOKS.symbol);
  const screenId = screenSchema.parse((await post(setup.server, SCREENS_PATH, { name: SCREEN.name }, { cookie })).json()).id;
  const design = await send(setup.server, "PUT", screenDesignPath(screenId), { name: SCREEN.name, theme: "dark", accent: "blue", widgets: [tableWidget(registry)] }, { cookie });
  if (design.status !== 200) throw new Error(`the screen of F01 was not saved: ${design.status}`);
  return { setup, cookie, registry, screenId };
}
