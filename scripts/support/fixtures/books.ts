// F01–F03 (DEV §8.2): the synthetic Books export, the outcomes expected from it and the record
// validation cases. The shapes are those of the export fixture (Architektura Załącznik G); this
// is a check of the test data, not the product's importer, which arrives with D45/D46.
import { z } from "zod";
import { ensure, ensureUnique, walk } from "./strict-json.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SYMBOL = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const SYMBOL_MAX = 40;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER;
const COLUMN_TYPES = ["text", "number", "money", "date", "datetime", "time", "boolean", "choice"] as const;
/** Grid width of each layout (Architektura §7.2); large stays P1. */
const GRID_COLUMNS = { phone: 1, tablet: 8, desktop: 12 } as const;
/** Fields that must never leave an instance in an export (Załącznik G). */
const PRIVATE_FIELDS = ["user_id", "userId", "session", "password", "totpSecret", "audit_log", "app_setting"];
const DST_ZONES = ["Europe/Warsaw", "America/New_York"] as const;

const id = z.string().regex(UUID_V7, "domain IDs are UUIDv7");
const symbol = z.string().max(SYMBOL_MAX).regex(SYMBOL, "invalid symbol");
const instant = z.string().regex(UTC_INSTANT, "timestamps are UTC");
const box = z.strictObject({ x: z.int().min(0), y: z.int().min(0), w: z.int().positive(), h: z.int().positive() });

const column = z.strictObject({
  id,
  symbol,
  displayName: z.string().min(1),
  type: z.enum(COLUMN_TYPES),
  typeOptions: z.record(z.string(), z.unknown()),
  defaultValue: z.unknown(),
  required: z.boolean(),
  position: z.int().min(0),
});
type Column = z.infer<typeof column>;

const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("registry"), registryId: id }),
  z.strictObject({ kind: z.literal("column"), registryId: id, columnId: id }),
  z.strictObject({ kind: z.literal("systemColumn"), registryId: id, symbol: z.string() }),
]);

const exportSchema = z.strictObject({
  format: z.literal("openlifedashboard-export"),
  formatVersion: z.literal(1),
  appVersion: z.string().min(1),
  exportedAt: instant,
  settings: z.strictObject({ timezone: z.string(), locale: z.enum(["pl", "en"]), dateFormat: z.string() }),
  configEntries: z.array(z.strictObject({ id, symbol, displayName: z.string(), value: z.string(), description: z.string() })),
  dictionaries: z.array(
    z.strictObject({
      id,
      symbol,
      displayName: z.string(),
      values: z.array(z.strictObject({ id, symbol, label: z.string(), position: z.int().min(0), hidden: z.boolean() })),
    }),
  ),
  registries: z.array(
    z.strictObject({
      id,
      symbol,
      displayName: z.string(),
      schemaRevision: z.int().positive(),
      dataRevision: z.int().min(0),
      columns: z.array(column),
      records: z.array(
        z.strictObject({ id, revision: z.int().positive(), createdAt: instant, updatedAt: instant, values: z.record(z.string(), z.unknown()) }),
      ),
    }),
  ),
  screens: z.array(
    z.strictObject({
      id,
      name: z.string(),
      theme: z.string(),
      accent: z.string(),
      widgets: z.array(
        z.strictObject({
          id,
          type: z.string(),
          // Opaque to everything but the widget type (F05: unknown types keep it as is).
          config: z.looseObject({ v: z.int().positive() }),
          layout: z.strictObject({ phone: box, tablet: box, desktop: box }),
          bindings: z.array(z.strictObject({ slot: z.string(), ordinal: z.int().min(0), path: z.string(), target })),
        }),
      ),
    }),
  ),
});
export type BooksExport = z.infer<typeof exportSchema>;

function parseWith<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const result = schema.safeParse(value);
  ensure(result.success, `${name}: ${result.error?.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return result.data;
}

function realDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function validCell(columnDefinition: Column, value: unknown): boolean {
  if (value === null) return !columnDefinition.required;
  switch (columnDefinition.type) {
    case "text":
    case "choice":
      return typeof value === "string" && (value.trim() !== "" || !columnDefinition.required);
    case "boolean":
      return typeof value === "boolean";
    case "money":
      // Minor units ×100 as an integer (Architektura §4.3).
      return Number.isInteger(value) && Math.abs(Number(value)) <= MAX_SAFE_MONEY;
    case "number":
      return typeof value === "number" && Number.isFinite(value) && (columnDefinition.typeOptions["decimalPlaces"] !== 0 || Number.isInteger(value));
    case "date":
      return typeof value === "string" && realDate(value);
    case "datetime":
      return typeof value === "string" && UTC_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
    case "time":
      return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  }
}

const count = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> =>
  items.reduce<Record<string, number>>((counts, item) => ({ ...counts, [key(item)]: (counts[key(item)] ?? 0) + 1 }), {});
const sameCounts = (left: Record<string, number>, right: Record<string, number>): boolean =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

/** F01: shape, IDs, private fields, types of every cell, references, bindings and layouts. */
export function checkBooksExport(value: unknown): BooksExport {
  const data = parseWith(exportSchema, value, "F01");
  const ids = [...walk(data)].flatMap((node) => (typeof node === "object" && node !== null && !Array.isArray(node) && "id" in node ? [node.id] : []));
  ensureUnique(ids, "F01: repeated domain ID");
  ensure(
    [...walk(data)].every((node) => typeof node !== "object" || node === null || Array.isArray(node) || PRIVATE_FIELDS.every((field) => !(field in node))),
    "F01: a private field (owner, session, password, TOTP, audit or settings table) in the export",
  );
  ensure(data.registries.length === 1 && data.screens.length === 1 && data.dictionaries.length === 1 && data.configEntries.length === 1, "F01: one registry, screen, dictionary and ConfigTable entry");
  for (const symbols of [data.registries, data.dictionaries, data.configEntries, ...data.dictionaries.map((dictionary) => dictionary.values)]) {
    ensureUnique(symbols.map((item) => item.symbol), "F01: repeated symbol in one namespace");
  }
  const [registry] = data.registries;
  const [screen] = data.screens;
  ensure(registry !== undefined && screen !== undefined, "F01: registry and screen");
  const { columns, records } = registry;
  ensure(columns.length === 9 && records.length === 25, "F01: 9 columns and 25 records");
  ensure(JSON.stringify([...new Set(columns.map((item) => item.type))].sort()) === JSON.stringify([...COLUMN_TYPES].sort()), "F01: the 8 column types");
  ensureUnique(columns.map((item) => item.symbol), "F01: repeated column symbol");
  ensureUnique(columns.map((item) => item.position), "F01: repeated column position");
  const dictionaryIds = new Set(data.dictionaries.map((dictionary) => dictionary.id));
  for (const item of columns.filter((candidate) => candidate.type === "choice")) {
    ensure(dictionaryIds.has(String(item.typeOptions["dictionaryId"])), `F01: column ${item.symbol} refers to a missing dictionary`);
  }
  const bySymbol = new Map(columns.map((item) => [item.symbol, item]));
  for (const record of records) {
    const keys = Object.keys(record.values).sort();
    ensure(JSON.stringify(keys) === JSON.stringify([...bySymbol.keys()].sort()), `F01: record ${record.id} values do not match the columns`);
    for (const [key, cell] of Object.entries(record.values)) {
      const definition = bySymbol.get(key);
      ensure(definition !== undefined && validCell(definition, cell), `F01: record ${record.id} cell ${key} does not match its column`);
    }
    ensure(Date.parse(record.updatedAt) >= Date.parse(record.createdAt), `F01: record ${record.id} updated before created`);
  }

  ensure(sameCounts(count(screen.widgets, (widget) => widget.type), { "register-table": 1, clock: 2 }), "F01: one table and two clocks");
  const byId = new Map(columns.map((item) => [item.id, item]));
  for (const widget of screen.widgets) {
    ensure(widget.config.v === 1 && !("columns" in widget.config) && !("type_version" in widget), `F01: widget ${widget.id} duplicates binding state in config`);
    for (const [name, width] of Object.entries(GRID_COLUMNS)) {
      const placed = widget.layout[name as keyof typeof GRID_COLUMNS];
      ensure(placed.x + placed.w <= width, `F01: widget ${widget.id} lies outside the ${name} grid`);
    }
    ensureUnique(widget.bindings.map((binding) => [binding.slot, binding.ordinal]), `F01: widget ${widget.id} repeats a slot ordinal`);
    if (widget.type === "clock") {
      ensure(widget.bindings.length === 0, "F01: a clock has no register bindings");
      const zone = widget.config["timezone"] === "owner" ? data.settings.timezone : String(widget.config["timezone"]);
      ensure(isTimeZone(zone), `F01: clock ${widget.id} has an unknown time zone ${zone}`);
      continue;
    }
    ensure(sameCounts(count(widget.bindings, (binding) => binding.slot), { registry: 1, columns: 3, sortColumn: 1 }), "F01: table slot cardinalities");
    const ordinals = widget.bindings.filter((binding) => binding.slot === "columns").map((binding) => binding.ordinal).sort();
    ensure(JSON.stringify(ordinals) === "[0,1,2]", "F01: column slot ordinals are 0, 1, 2");
    for (const binding of widget.bindings) {
      ensure(binding.target.registryId === registry.id, "F01: a binding refers to another registry");
      let expectedPath = `Field.Register.${registry.symbol}`;
      if (binding.target.kind === "column") {
        const bound = byId.get(binding.target.columnId);
        ensure(bound !== undefined, `F01: binding ${binding.path} targets a missing column`);
        expectedPath += `.${bound.symbol}`;
      } else if (binding.target.kind === "systemColumn") {
        ensure(binding.target.symbol === "created_at", "F01: the sort column is created_at");
        expectedPath += `.${binding.target.symbol}`;
      }
      ensure(binding.path === expectedPath, `F01: binding path ${binding.path} disagrees with its target`);
    }
  }
  return data;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const expectedSchema = z.strictObject({
  datasetId: z.string(),
  synthetic: z.literal(true),
  sourceFile: z.literal("books-v1.export.json"),
  recordCount: z.int(),
  columnCount: z.int(),
  widgetCount: z.int(),
  pageSize: z.int().positive(),
  sort: z.strictObject({ symbol: z.literal("created_at"), direction: z.literal("desc"), tieBreaker: z.literal("id desc") }),
  pageRecordIds: z.array(z.array(id)),
  pageTitles: z.array(z.array(z.string())),
  statusCounts: z.record(z.string(), z.int()),
  hiddenLabel: z.string(),
  unknownValueDisplayedAs: z.string(),
  priceExample: z.strictObject({ recordId: id, minorUnits: z.int(), plDisplay: z.string() }),
  fixedClockCases: z.array(z.strictObject({ nowIso: instant, "Europe/Warsaw": z.string(), "America/New_York": z.string() })),
  derivedCases: z.array(z.looseObject({ id: z.string(), transform: z.string() })),
});

const wallClock = (iso: string, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** F02: counts, pages 10/10/5 with the tie-breaker, dictionary, price, DST and derived IDs. */
export function checkBooksExpectations(data: BooksExport, value: unknown): void {
  const expected = parseWith(expectedSchema, value, "F02");
  const [registry] = data.registries;
  const widgets = data.screens[0]?.widgets ?? [];
  ensure(registry !== undefined, "F02: F01 has a registry");
  const records = registry.records;
  ensure(
    JSON.stringify([expected.recordCount, expected.columnCount, expected.widgetCount]) === JSON.stringify([records.length, registry.columns.length, widgets.length]),
    "F02: counts disagree with F01",
  );
  const table = widgets.find((widget) => widget.type === "register-table");
  ensure(expected.pageSize === 10 && table?.config["pageSize"] === expected.pageSize, "F02: page size differs from the table widget");
  // created_at desc, then id desc (the tie-breaker); IDs of equal length compare as text.
  const ordered = [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const pages: (typeof records)[] = [];
  for (let start = 0; start < ordered.length; start += expected.pageSize) pages.push(ordered.slice(start, start + expected.pageSize));
  ensure(JSON.stringify(pages.map((page) => page.length)) === "[10,10,5]", "F02: pages are 10/10/5");
  ensure(JSON.stringify(expected.pageRecordIds) === JSON.stringify(pages.map((page) => page.map((row) => row.id))), "F02: page ID order differs");
  ensure(JSON.stringify(expected.pageTitles) === JSON.stringify(pages.map((page) => page.map((row) => row.values["tytul"]))), "F02: page titles differ");
  ensure(new Set(records.map((row) => row.createdAt)).size < records.length, "F02: no equal createdAt exercises the tie-breaker");
  ensure(sameCounts(expected.statusCounts, count(records, (row) => String(row.values["status"]))), "F02: status counts differ");
  const values = data.dictionaries[0]?.values ?? [];
  ensure(values.some((item) => item.hidden && item.label === expected.hiddenLabel), "F02: no hidden dictionary label");
  ensure(
    !values.some((item) => item.symbol === expected.unknownValueDisplayedAs) && expected.unknownValueDisplayedAs in expected.statusCounts,
    "F02: no unknown dictionary symbol exercise",
  );
  const price = records.find((row) => row.id === expected.priceExample.recordId)?.values["cena"];
  ensure(
    price === expected.priceExample.minorUnits && typeof price === "number" && `${Math.trunc(price / 100)},${String(price % 100).padStart(2, "0")}` === expected.priceExample.plDisplay,
    "F02: price example differs",
  );
  ensure(expected.fixedClockCases.length === 2, "F02: two DST moments");
  for (const moment of expected.fixedClockCases) {
    for (const zone of DST_ZONES) {
      ensure(wallClock(moment.nowIso, zone) === moment[zone], `F02: ${moment.nowIso} in ${zone} is ${wallClock(moment.nowIso, zone)}, not ${moment[zone]}`);
    }
  }
  const derived = new Map(expected.derivedCases.map((item) => [item.id, item]));
  const author = registry.columns.find((item) => item.symbol === "autor");
  ensure(author !== undefined && derived.get("broken-author-binding")?.["columnId"] === author.id, "F02: the derived author binding targets another column");
  const allIds = new Set([...walk(data)].flatMap((node) => (typeof node === "object" && node !== null && "id" in node ? [String(node.id)] : [])));
  ensure(!allIds.has(String(derived.get("same-symbol-new-column")?.["newColumnId"])), "F02: the replacement column ID is not new");
}

const casesSchema = z.strictObject({
  synthetic: z.literal(true),
  baseFixture: z.literal("books-v1.export.json"),
  registrySymbol: z.string(),
  cases: z.array(
    z.strictObject({
      id: z.string().min(1),
      values: z.record(z.string(), z.unknown()),
      expectedHttpStatus: z.union([z.literal(201), z.literal(422)]),
      expectedCode: z.string().optional(),
      assertion: z.string().optional(),
    }),
  ),
});

/** F03: 8 declarations against F01's registry; the HTTP outcomes are run by D15/D22. */
export function checkRecordCases(data: BooksExport, value: unknown): void {
  const cases = parseWith(casesSchema, value, "F03");
  ensure(cases.registrySymbol === data.registries[0]?.symbol, "F03: cases refer to another registry");
  ensure(cases.cases.length === 8, "F03: 8 validation cases");
  ensureUnique(cases.cases.map((item) => item.id), "F03: repeated case ID");
  for (const item of cases.cases) {
    ensure(item.expectedHttpStatus === 201 || item.expectedCode === "VALIDATION_FAILED", `F03: case ${item.id} rejected without VALIDATION_FAILED`);
  }
}
