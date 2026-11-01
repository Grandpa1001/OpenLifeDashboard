// A change of the structure of a registry and what it would do (Scope §5.6, S8, S9; Architektura
// §4.6, §5.2; D26.1), before anything is changed. One request is one change; a column is named by its
// permanent identifier and its symbol never changes. The rules decide whether the change can be
// made at all; the assessment counts the records it would touch and says whether a required column
// blocks it. A plan is the change, the registry and both of its revisions at the moment of the
// preview: any record or definition written since makes it stale, and it lasts a short time.
import { isColumnType, isValidCellValue, normalizeTypeOptions, type CellValue, type ColumnType, type ColumnTypeOptions } from "./column-rules.js";
import { convertCell, isConversionSupported, type Conversion, type ConversionContext } from "./convert.js";
import { checkColumn, checkDisplayName, type NewColumn, type RegistryIssue, type RegistryIssueCode } from "./definition.js";
import type { RegistryLimits } from "./limits.js";
import { canonicalJson } from "./record-rules.js";

/** A column of the registry as the rules of a change see it: active columns only. */
export type StructureColumn = Readonly<{ id: string; symbol: string; displayName: string; type: ColumnType; typeOptions: ColumnTypeOptions; required: boolean; defaultValue: CellValue }>;
export type StructureSchema = Readonly<{ registryId: string; columns: readonly StructureColumn[] }>;
export type StructureContext = Readonly<{ limits: RegistryLimits; dictionaryIds: ReadonlySet<string> }>;

export const STRUCTURE_CHANGE_KINDS = ["addColumn", "renameColumn", "removeColumn", "changeType", "setRequired", "deleteRegistry"] as const;
export type StructureChangeKind = (typeof STRUCTURE_CHANGE_KINDS)[number];

/** A change that passed its rules, with everything the plan binds. */
export type StructureChange =
  | Readonly<{ kind: "addColumn"; column: NewColumn }>
  | Readonly<{ kind: "renameColumn"; columnId: string; displayName: string }>
  | Readonly<{ kind: "removeColumn"; columnId: string }>
  | Readonly<{ kind: "changeType"; columnId: string; type: ColumnType; typeOptions: ColumnTypeOptions; required: boolean; replacement: CellValue }>
  | Readonly<{ kind: "setRequired"; columnId: string; required: boolean; replacement: CellValue }>
  | Readonly<{ kind: "deleteRegistry" }>;

export type StructureIssueCode = RegistryIssueCode | "CHANGE_UNKNOWN" | "COLUMN_UNKNOWN" | "COLUMN_LAST" | "TYPE_CHANGE_UNSUPPORTED" | "CHANGE_EMPTY" | "REPLACEMENT_INVALID";
export type StructureIssue = Readonly<{ path: string; code: StructureIssueCode }>;
export type StructureChangeResult = Readonly<{ ok: true; value: StructureChange }> | Readonly<{ ok: false; issues: readonly StructureIssue[] }>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const sameOptions = (a: ColumnTypeOptions, b: ColumnTypeOptions): boolean => canonicalJson(a) === canonicalJson(b);

/** A value that fills the empty or unconvertible cells of a required column: a real value of its type, never null. */
function replacementOf(draft: Readonly<Record<string, unknown>>, type: ColumnType, options: ColumnTypeOptions, context: StructureContext, issues: StructureIssue[]): CellValue {
  const replacement = draft["replacement"] ?? null;
  if (replacement === null) return null;
  if (!isValidCellValue(type, options, replacement, context.limits.textMaxChars)) {
    issues.push({ path: "replacement", code: "REPLACEMENT_INVALID" });
    return null;
  }
  return replacement;
}

/** The change a request asks for, checked against the registry as it is; every problem with the path of its field. */
export function validateStructureChange(draft: unknown, schema: StructureSchema, context: StructureContext): StructureChangeResult {
  const fields = isObject(draft) ? draft : {};
  const issues: StructureIssue[] = [];
  const requested = fields["kind"];
  if (typeof requested !== "string" || !(STRUCTURE_CHANGE_KINDS as readonly string[]).includes(requested)) return { ok: false, issues: [{ path: "kind", code: "CHANGE_UNKNOWN" }] };
  const kind = requested as StructureChangeKind;
  if (kind === "deleteRegistry") return { ok: true, value: { kind } };

  if (kind === "addColumn") {
    if (schema.columns.length >= context.limits.maxColumns) issues.push({ path: "column", code: "LIMIT_COLUMNS" });
    const columnIssues: RegistryIssue[] = [];
    const column = checkColumn(fields["column"], "column", schema.columns.length, new Set(schema.columns.map((each) => each.symbol)), context, columnIssues);
    issues.push(...columnIssues);
    return issues.length === 0 && column !== null ? { ok: true, value: { kind, column } } : { ok: false, issues };
  }

  const column = schema.columns.find((each) => each.id === fields["columnId"]);
  if (column === undefined) return { ok: false, issues: [{ path: "columnId", code: "COLUMN_UNKNOWN" }] };
  const columnId = column.id;
  switch (kind) {
    case "renameColumn": {
      const name = checkDisplayName(fields["displayName"]);
      if (!name.ok) return { ok: false, issues: [{ path: "displayName", code: name.issue }] };
      return name.name === column.displayName ? { ok: false, issues: [{ path: "displayName", code: "CHANGE_EMPTY" }] } : { ok: true, value: { kind, columnId, displayName: name.name } };
    }
    case "removeColumn":
      return schema.columns.length <= 1 ? { ok: false, issues: [{ path: "columnId", code: "COLUMN_LAST" }] } : { ok: true, value: { kind, columnId } };
    case "setRequired": {
      const required = fields["required"];
      if (typeof required !== "boolean") return { ok: false, issues: [{ path: "required", code: "REQUIRED_FLAG_INVALID" }] };
      if (required === column.required) return { ok: false, issues: [{ path: "required", code: "CHANGE_EMPTY" }] };
      const replacement = required ? replacementOf(fields, column.type, column.typeOptions, context, issues) : null;
      return issues.length === 0 ? { ok: true, value: { kind, columnId, required, replacement } } : { ok: false, issues };
    }
    case "changeType": {
      const type = fields["type"];
      if (!isColumnType(type)) return { ok: false, issues: [{ path: "type", code: "TYPE_UNKNOWN" }] };
      const options = normalizeTypeOptions(type, fields["typeOptions"] ?? {});
      if (options === null) issues.push({ path: "typeOptions", code: "TYPE_OPTIONS_INVALID" });
      else if (options.dictionaryId !== undefined && !context.dictionaryIds.has(options.dictionaryId)) issues.push({ path: "typeOptions.dictionaryId", code: "DICTIONARY_UNKNOWN" });
      if (!isConversionSupported(column.type, type)) issues.push({ path: "type", code: "TYPE_CHANGE_UNSUPPORTED" });
      const required = fields["required"] ?? column.required;
      if (typeof required !== "boolean") issues.push({ path: "required", code: "REQUIRED_FLAG_INVALID" });
      if (issues.length > 0 || options === null || typeof required !== "boolean") return { ok: false, issues };
      if (type === column.type && sameOptions(options, column.typeOptions)) return { ok: false, issues: [{ path: "type", code: "CHANGE_EMPTY" }] };
      const replacement = replacementOf(fields, type, options, context, issues);
      return issues.length === 0 ? { ok: true, value: { kind, columnId, type, typeOptions: options, required, replacement } } : { ok: false, issues };
    }
  }
}

/** The text the signature of a plan binds a change by: equal for equal changes, whatever the order of the fields. */
export const canonicalChange = (change: StructureChange): string => canonicalJson(change);

/** What converting the values of a column would do: how many would change, stay, are empty or fail, and the most frequent failures. */
export type ConversionReport = Readonly<{ converted: number; unchanged: number; empty: number; failed: number; samples: readonly Readonly<{ value: CellValue; count: number }>[] }>;

export const CONVERSION_SAMPLES_MAX = 20;

/** Goes once over the values of a column, in any order; only the failures are kept, counted by value. */
export function reportConversion(values: Iterable<CellValue>, convert: (value: CellValue) => Conversion, samplesMax: number = CONVERSION_SAMPLES_MAX): ConversionReport {
  let converted = 0;
  let unchanged = 0;
  let empty = 0;
  let failed = 0;
  const failures = new Map<string, { value: CellValue; count: number }>();
  for (const value of values) {
    if (value === null) {
      empty += 1;
      continue;
    }
    const result = convert(value);
    if (!result.ok) {
      failed += 1;
      const key = canonicalJson(value);
      const seen = failures.get(key);
      if (seen === undefined) failures.set(key, { value, count: 1 });
      else seen.count += 1;
    } else if (canonicalJson(result.value) === canonicalJson(value)) unchanged += 1;
    else converted += 1;
  }
  // The most frequent first; among equals, in the order of their canonical text.
  const samples = [...failures.entries()].sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0)).slice(0, samplesMax).map(([, sample]) => sample);
  return { converted, unchanged, empty, failed, samples };
}

/** The conversion of one column's values for a change of its type. */
export const conversionOf = (column: StructureColumn, change: Extract<StructureChange, { kind: "changeType" }>, context: ConversionContext) => (value: CellValue): Conversion =>
  convertCell(value, column, { type: change.type, typeOptions: change.typeOptions }, context);

export type StructureBlock = "REQUIRED_VALUES_LOST" | "REQUIRED_EMPTY";

/** What the preview counted: the records of the registry and, for a change of one column, its values. */
export type StructureFacts = Readonly<{ records: number; column?: Readonly<{ values: number; empty: number }>; conversion?: ConversionReport }>;

/**
 * The records a change would touch and whether it is blocked. A required column may not be left
 * with empty cells: a type change that would lose values or a column that has empty cells needs a
 * replacement, and a new required column of a registry with records needs a default.
 */
export function assessChange(change: StructureChange, facts: StructureFacts): Readonly<{ affected: number; blocked: StructureBlock | null }> {
  switch (change.kind) {
    case "addColumn": {
      const filled = change.column.defaultValue !== null;
      return { affected: filled ? facts.records : 0, blocked: change.column.required && !filled && facts.records > 0 ? "REQUIRED_EMPTY" : null };
    }
    case "renameColumn":
      return { affected: 0, blocked: null };
    case "removeColumn":
      return { affected: facts.column?.values ?? 0, blocked: null };
    case "setRequired": {
      const empty = facts.column?.empty ?? 0;
      if (!change.required) return { affected: 0, blocked: null };
      if (empty > 0 && change.replacement === null) return { affected: 0, blocked: "REQUIRED_EMPTY" };
      return { affected: empty, blocked: null };
    }
    case "changeType": {
      const report = facts.conversion ?? { converted: 0, unchanged: 0, empty: 0, failed: 0, samples: [] };
      const touched = report.converted + report.failed;
      if (!change.required || report.empty + report.failed === 0) return { affected: touched, blocked: null };
      if (change.replacement === null) return { affected: touched, blocked: report.failed > 0 ? "REQUIRED_VALUES_LOST" : "REQUIRED_EMPTY" };
      return { affected: touched + report.empty, blocked: null };
    }
    case "deleteRegistry":
      return { affected: facts.records, blocked: null };
  }
}

/** How long a plan may be carried out after its preview (Architektura §5.2, §14.4). */
export const STRUCTURE_PLAN_TTL_MS = 10 * 60 * 1000;

/** What a plan states about the registry when it was previewed; the owner and the change are bound by its signature. */
export type PlanClaims = Readonly<{ registryId: string; schemaRevision: number; dataRevision: number; expiresAtMs: number }>;
export type PlanState = "current" | "stale" | "expired";

/** A plan is used only while it lasts and while the registry has not been written since: otherwise a new preview is needed. */
export function planState(claims: PlanClaims, current: Readonly<{ schemaRevision: number; dataRevision: number }> | null, nowMs: number): PlanState {
  if (nowMs >= claims.expiresAtMs) return "expired";
  if (current === null || current.schemaRevision !== claims.schemaRevision || current.dataRevision !== claims.dataRevision) return "stale";
  return "current";
}
