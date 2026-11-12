// The parser of the export file (Architektura Załącznik G; D45.1): everything that can be decided about a file
// before anything is written. The order is the cheap checks first: size, JSON, the format and its version (a
// newer or unknown one is refused, an older one is migrated by the chain), then the shape by the schema of the
// contract, then the rules of the catalogs by the same functions the routes apply (symbols, names, types and
// options of columns, defaults, the values of every record by the type of its column, dictionaries, entries of
// ConfigTable, limits), the uniqueness of every identifier in the file, and the references between sections.
// Every problem has the path in the file (`registries[2].columns[1].type`) and a stable code; nothing is
// repaired and nothing is written. A binding of a screen may point at what the file does not hold: the state
// of the widget is worked out after an import, and the identifiers are kept.
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, exportFileSchema, type ExportFile } from "@openlife/contracts/export/format";
import { DESIGN_LIMITS } from "@openlife/contracts/http/screens";
import { validateNewConfigEntry, type ConfigLimits } from "@openlife/core/configuration";
import { isValidScreenName, SCREENS_PER_OWNER } from "@openlife/core/dashboard";
import { validateNewDictionary, type DictionaryLimits } from "@openlife/core/dictionaries";
import { checkColumn, checkDisplayName, checkSymbol, validateRecordValues, type RecordColumn, type RecordIssue, type RegistryIssue, type RegistryLimits } from "@openlife/core/registries";
import type { z } from "zod";
import { EXPORT_ISSUES_MAX } from "./limits.js";
import { EXPORT_MIGRATIONS, migrationSteps, type ExportMigrations } from "./migrations.js";

export type ExportIssue = Readonly<{ path: string; code: string }>;

export type ExportFailureCode = "EXPORT_TOO_LARGE" | "EXPORT_NOT_JSON" | "EXPORT_FORMAT_UNKNOWN" | "EXPORT_VERSION_NEWER" | "EXPORT_VERSION_UNSUPPORTED" | "EXPORT_INVALID";

export type ParseExportResult =
  | Readonly<{ ok: true; file: ExportFile; migratedFrom: number | null }>
  | Readonly<{ ok: false; code: ExportFailureCode; issues: readonly ExportIssue[] }>;

/** The limits the file must meet: those of the installation that imports it, passed in, never read here. */
export type ParseExportOptions = Readonly<{
  maxBytes: number;
  registry: RegistryLimits;
  dictionary: DictionaryLimits;
  config: ConfigLimits;
  /** The largest record, in bytes of its JSON (`limits.recordMaxKiB`). */
  recordMaxBytes: number;
  /** Replaces the chain of the product; tests use it to try a file of an older format. */
  migrations?: ExportMigrations;
}>;

const fail = (code: ExportFailureCode, issues: readonly ExportIssue[]): ParseExportResult => ({ ok: false, code, issues });

/** The path of a position in the file: `registries[2].columns[1].type`. */
function pathOf(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((path, segment) => (typeof segment === "number" ? `${path}[${segment}]` : path === "" ? String(segment) : `${path}.${String(segment)}`), "");
}

const SHAPE_CODES: Readonly<Record<string, string>> = {
  invalid_type: "SHAPE_TYPE",
  unrecognized_keys: "SHAPE_UNKNOWN_FIELD",
  too_small: "SHAPE_RANGE",
  too_big: "SHAPE_RANGE",
  invalid_format: "SHAPE_FORMAT",
  invalid_value: "SHAPE_VALUE",
  invalid_union: "SHAPE_UNION",
};

function shapeIssues(error: z.ZodError): ExportIssue[] {
  const issues: ExportIssue[] = [];
  for (const issue of error.issues) {
    const code = SHAPE_CODES[issue.code] ?? "SHAPE_INVALID";
    if (issue.code === "unrecognized_keys") {
      // The refused field is named in the path, so the owner sees which one it is.
      for (const key of issue.keys) issues.push({ path: pathOf([...issue.path, key]), code });
    } else {
      issues.push({ path: pathOf(issue.path), code });
    }
  }
  return issues;
}

/** Collects issues up to the bound, so a file full of errors costs a bounded answer. */
class Issues {
  readonly list: ExportIssue[] = [];
  add(path: string, code: string): void {
    if (this.list.length < EXPORT_ISSUES_MAX) this.list.push({ path, code });
  }
  /** An issue of a rule of a catalog, whose path is relative to the element it was applied to. */
  addWithin(prefix: string, issue: Readonly<{ path: string; code: string }>): void {
    // The rules name the element itself "dictionary" or "entry" (its limit): in the file that is the element's own path.
    this.add(issue.path === "" || issue.path === "dictionary" || issue.path === "entry" ? prefix : `${prefix}.${issue.path}`, issue.code);
  }
}

/** Every identifier of the file must be used once: the first place and the later ones are both known. */
class UniqueIds {
  private readonly seen = new Set<string>();
  check(id: string, path: string, issues: Issues): void {
    if (this.seen.has(id)) issues.add(path, "ID_DUPLICATE");
    else this.seen.add(id);
  }
}

/** Moment of an instant in ms; the shape has checked its format. */
const instantMs = (iso: string): number => Date.parse(iso);

function checkConfigEntries(file: ExportFile, options: ParseExportOptions, ids: UniqueIds, issues: Issues): void {
  const taken = new Set<string>();
  file.configEntries.forEach((entry, index) => {
    const at = `configEntries[${index}]`;
    ids.check(entry.id, `${at}.id`, issues);
    const result = validateNewConfigEntry(entry, { limits: options.config, takenSymbols: taken, count: index });
    if (!result.ok) for (const issue of result.issues) issues.addWithin(at, issue);
    taken.add(entry.symbol);
  });
}

function checkDictionaries(file: ExportFile, options: ParseExportOptions, ids: UniqueIds, issues: Issues): void {
  const taken = new Set<string>();
  file.dictionaries.forEach((dictionary, index) => {
    const at = `dictionaries[${index}]`;
    ids.check(dictionary.id, `${at}.id`, issues);
    const result = validateNewDictionary(
      { symbol: dictionary.symbol, displayName: dictionary.displayName, values: dictionary.values.map(({ symbol, label, hidden }) => ({ symbol, label, hidden })) },
      { limits: options.dictionary, takenSymbols: taken, count: index },
    );
    if (!result.ok) for (const issue of result.issues) issues.addWithin(at, issue);
    taken.add(dictionary.symbol);
    dictionary.values.forEach((value, position) => {
      ids.check(value.id, `${at}.values[${position}].id`, issues);
      // The order of the array is the order of the values: the positions are 0, 1, 2 … without a gap.
      if (value.position !== position) issues.add(`${at}.values[${position}].position`, "POSITION_INVALID");
    });
  });
}

function checkRegistries(file: ExportFile, options: ParseExportOptions, ids: UniqueIds, issues: Issues): void {
  const dictionaryIds = new Set(file.dictionaries.map((dictionary) => dictionary.id));
  const takenRegistrySymbols = new Set<string>();
  file.registries.forEach((registry, index) => {
    const at = `registries[${index}]`;
    ids.check(registry.id, `${at}.id`, issues);
    if (index >= options.registry.maxRegistries) issues.add(at, "LIMIT_REGISTRIES");
    const symbolIssue = checkSymbol(registry.symbol, "registry", takenRegistrySymbols);
    if (symbolIssue !== null) issues.add(`${at}.symbol`, symbolIssue);
    takenRegistrySymbols.add(registry.symbol);
    const name = checkDisplayName(registry.displayName);
    if (!name.ok) issues.add(`${at}.displayName`, name.issue);
    if (registry.columns.length === 0) issues.add(`${at}.columns`, "COLUMNS_MISSING");
    if (registry.columns.length > options.registry.maxColumns) issues.add(`${at}.columns`, "LIMIT_COLUMNS");

    const columnIssues: RegistryIssue[] = [];
    const takenColumns = new Set<string>();
    const recordColumns: RecordColumn[] = [];
    registry.columns.forEach((column, position) => {
      const columnAt = `${at}.columns[${position}]`;
      ids.check(column.id, `${columnAt}.id`, issues);
      if (column.position !== position) issues.add(`${columnAt}.position`, "POSITION_INVALID");
      const checked = checkColumn(column, columnAt, position, takenColumns, { limits: options.registry, dictionaryIds }, columnIssues);
      if (checked !== null) recordColumns.push({ symbol: checked.symbol, type: checked.type, typeOptions: checked.typeOptions, defaultValue: checked.defaultValue, required: checked.required });
    });
    for (const issue of columnIssues) issues.add(issue.path, issue.code);

    // The identifiers of the records are unique in the file whatever else is wrong with the registry.
    registry.records.forEach((record, recordIndex) => ids.check(record.id, `${at}.records[${recordIndex}].id`, issues));
    // The values are checked against the columns only when every column is sound: against a broken one every value would be an issue.
    if (columnIssues.length > 0 || recordColumns.length !== registry.columns.length) return;
    const schema = { schemaRevision: registry.schemaRevision, columns: recordColumns };
    const policy = { maxTextCodePoints: options.registry.textMaxChars, maxRecordBytes: options.recordMaxBytes };
    registry.records.forEach((record, recordIndex) => {
      const recordAt = `${at}.records[${recordIndex}]`;
      if (instantMs(record.updatedAt) < instantMs(record.createdAt)) issues.add(`${recordAt}.updatedAt`, "TIMESTAMPS_ORDER");
      // An export holds every column of the registry, an empty one as null: a missing one is a file that was cut or made by hand.
      for (const column of recordColumns) if (!Object.hasOwn(record.values, column.symbol)) issues.add(`${recordAt}.values.${column.symbol}`, "VALUE_MISSING");
      const checked = validateRecordValues(schema, record.values, policy);
      if (!checked.ok) for (const issue of checked.issues as readonly RecordIssue[]) issues.addWithin(recordAt, issue);
    });
  });
}

function checkScreens(file: ExportFile, ids: UniqueIds, issues: Issues): void {
  if (file.screens.length > SCREENS_PER_OWNER) issues.add("screens", "LIMIT_SCREENS");
  file.screens.forEach((screen, index) => {
    const at = `screens[${index}]`;
    ids.check(screen.id, `${at}.id`, issues);
    if (!isValidScreenName(screen.name, { nameMaxChars: DESIGN_LIMITS.nameMaxChars })) issues.add(`${at}.name`, "NAME_INVALID");
    if (screen.widgets.length > DESIGN_LIMITS.widgetsPerScreen) issues.add(`${at}.widgets`, "LIMIT_WIDGETS");
    screen.widgets.forEach((widget, widgetIndex) => {
      const widgetAt = `${at}.widgets[${widgetIndex}]`;
      ids.check(widget.id, `${widgetAt}.id`, issues);
      // The ordinal of a binding is its place in its slot: two bindings may not claim the same one.
      const places = new Set<string>();
      widget.bindings.forEach((binding, bindingIndex) => {
        const place = `${binding.slot}#${binding.ordinal}`;
        if (places.has(place)) issues.add(`${widgetAt}.bindings[${bindingIndex}].ordinal`, "ORDINAL_DUPLICATE");
        places.add(place);
      });
    });
  });
}

export function parseExportFile(input: string | Uint8Array, options: ParseExportOptions): ParseExportResult {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > options.maxBytes) return fail("EXPORT_TOO_LARGE", [{ path: "", code: "EXPORT_TOO_LARGE" }]);

  let parsed: unknown;
  try {
    // A byte order mark in front of the text is not part of it.
    parsed = JSON.parse((typeof input === "string" ? input : Buffer.from(input).toString("utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fail("EXPORT_NOT_JSON", [{ path: "", code: "EXPORT_NOT_JSON" }]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Reflect.get(parsed, "format") !== EXPORT_FORMAT) {
    return fail("EXPORT_FORMAT_UNKNOWN", [{ path: "format", code: "EXPORT_FORMAT_UNKNOWN" }]);
  }

  const version: unknown = Reflect.get(parsed, "formatVersion");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return fail("EXPORT_VERSION_UNSUPPORTED", [{ path: "formatVersion", code: "EXPORT_VERSION_UNSUPPORTED" }]);
  if (version > EXPORT_FORMAT_VERSION) return fail("EXPORT_VERSION_NEWER", [{ path: "formatVersion", code: "EXPORT_VERSION_NEWER" }]);
  let document: Record<string, unknown> = { ...parsed };
  if (version < EXPORT_FORMAT_VERSION) {
    const steps = migrationSteps(version, options.migrations ?? EXPORT_MIGRATIONS);
    if (steps === null) return fail("EXPORT_VERSION_UNSUPPORTED", [{ path: "formatVersion", code: "EXPORT_VERSION_UNSUPPORTED" }]);
    for (const step of steps) document = step(document);
  }

  const shape = exportFileSchema.safeParse(document);
  if (!shape.success) return fail("EXPORT_INVALID", shapeIssues(shape.error).slice(0, EXPORT_ISSUES_MAX));

  const file = shape.data;
  const issues = new Issues();
  const ids = new UniqueIds();
  checkConfigEntries(file, options, ids, issues);
  checkDictionaries(file, options, ids, issues);
  checkRegistries(file, options, ids, issues);
  checkScreens(file, ids, issues);
  if (issues.list.length > 0) return fail("EXPORT_INVALID", issues.list);
  return { ok: true, file, migratedFrom: version < EXPORT_FORMAT_VERSION ? version : null };
}
