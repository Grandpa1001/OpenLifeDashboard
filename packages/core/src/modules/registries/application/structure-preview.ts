// The preview of a change of a registry's structure and the check of its plan (Scope §5.6, S8, S9;
// Architektura §4.5, §4.6, §5.2, §13.4; D26.2). Nothing is changed here: the preview reads the
// catalog, the values of the column and the bindings in one read unit (one snapshot, no write lock,
// a scan of the column one row at a time) and answers with what the change would do and, when nothing
// blocks it, a short-lived plan. The plan states the registry and both of its revisions; its signature
// binds the owner and the change. Carrying out a change (D28–D30) checks the plan again under the
// writer before anything is written: a record or a definition written since makes it stale.
import type { Failure, ReadUnit, Result } from "../../../foundation/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import type { OwnerPreferencesStore } from "../../settings/public.js";
import type { RegistryLimits } from "../domain/limits.js";
import { isEmptyCell } from "../domain/record-rules.js";
import {
  assessChange,
  canonicalChange,
  conversionOf,
  planState,
  reportConversion,
  STRUCTURE_PLAN_TTL_MS,
  validateStructureChange,
  type ConversionReport,
  type PlanClaims,
  type StructureBlock,
  type StructureChange,
  type StructureFacts,
} from "../domain/structure-change.js";
import type { DependentWidget, DependentWidgets, DictionaryLookup, PlanSigner, RecordStore, RegistryStore, StoredRegistry } from "../ports.js";

export type StructurePorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  registries: RegistryStore;
  records: Pick<RecordStore, "count" | "columnFacts" | "columnValues">;
  dictionaryLookup: Pick<DictionaryLookup, "ids">;
  dependents: DependentWidgets;
  preferences: Pick<OwnerPreferencesStore, "read">;
}>;

export type StructureDependencies = Readonly<{
  unit: ReadUnit<StructurePorts>;
  nowMs: () => number;
  signer: PlanSigner;
  limits: RegistryLimits;
}>;

export type StructurePreviewInput = Readonly<{ symbol: string; change: unknown }>;

export type StructurePreview = Readonly<{
  registry: Readonly<{ symbol: string; schemaRevision: number; dataRevision: number }>;
  records: number;
  affected: number;
  widgets: readonly DependentWidget[];
  /** For a change of a column's type only. */
  conversion: ConversionReport | null;
  blocked: StructureBlock | null;
  /** Null when the change is blocked: a blocked plan cannot be carried out. */
  planToken: string | null;
  expiresAt: string | null;
}>;

/** A zone the owner has not chosen yet is UTC; the data gate is passed only after the setup has saved one. */
const DEFAULT_TIME_ZONE = "UTC";

/** The owner of a private read: the session must pass the data access. */
function ownerOf(ports: Pick<StructurePorts, "sessions" | "access">, token: string, nowMs: number, requestId: string): Result<string> {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
  const decision = decideAccess(access.snapshot, "data", nowMs);
  return decision.allow ? { ok: true, value: access.session.ownerId } : { ok: false, error: { code: decision.code } };
}

function activeRegistry(ports: StructurePorts, ownerId: string, symbol: string): StoredRegistry | null {
  const registry = ports.registries.find(ownerId, symbol);
  return registry === null || registry.deletedAt !== null ? null : registry;
}

/** The change a request asks for, checked against the registry as it is now. */
function checkedChange(ports: StructurePorts, deps: Pick<StructureDependencies, "limits">, registry: StoredRegistry, request: unknown): Result<StructureChange> {
  const checked = validateStructureChange(request, { registryId: registry.id, columns: registry.columns }, { limits: deps.limits, dictionaryIds: ports.dictionaryLookup.ids(registry.ownerId) });
  if (checked.ok) return { ok: true, value: checked.value };
  return { ok: false, error: { code: "VALIDATION_FAILED", fields: [...new Set(checked.issues.map((issue) => issue.path))], issues: checked.issues } };
}

const columnIdOf = (change: StructureChange): string | null => ("columnId" in change ? change.columnId : null);

export function previewStructureChange(deps: StructureDependencies, token: string, input: StructurePreviewInput, requestId: string): Result<StructurePreview> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<StructurePreview> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const registry = activeRegistry(ports, owner.value, input.symbol);
    if (registry === null) return { ok: false, error: { code: "NOT_FOUND" } };
    const checked = checkedChange(ports, deps, registry, input.change);
    if (!checked.ok) return checked;
    const change = checked.value;

    const columnId = columnIdOf(change);
    const column = columnId === null ? null : (registry.columns.find((each) => each.id === columnId) ?? null);
    let conversion: ConversionReport | null = null;
    let facts: StructureFacts = { records: ports.records.count(registry) };
    if (change.kind === "changeType" && column !== null) {
      const timeZone = ports.preferences.read(registry.ownerId)?.timezone ?? DEFAULT_TIME_ZONE;
      // The scan is consumed whole here, before any other statement of the unit.
      conversion = reportConversion(ports.records.columnValues(registry, column.symbol), conversionOf(column, change, { timeZone, textMaxCodePoints: deps.limits.textMaxChars }));
      facts = { ...facts, conversion };
    } else if (change.kind === "setRequired" && column !== null) {
      // Empty by the rule of a record (white space alone is empty text), not by NULL alone: the cells D28 fills.
      let empty = 0;
      for (const value of ports.records.columnValues(registry, column.symbol)) if (isEmptyCell(column.type, value)) empty += 1;
      facts = { ...facts, column: { values: facts.records - empty, empty } };
    } else if (column !== null) {
      facts = { ...facts, column: ports.records.columnFacts(registry, column.symbol) };
    }
    const { affected, blocked } = assessChange(change, facts);
    // A new column has no widget yet; any other change touches the widgets of its column, or of the registry.
    const widgets = change.kind === "addColumn" ? [] : ports.dependents.of(registry.ownerId, registry.id, columnId);

    const claims: PlanClaims = { registryId: registry.id, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision, expiresAtMs: nowMs + STRUCTURE_PLAN_TTL_MS };
    const planToken = blocked === null ? deps.signer.issue(claims, { ownerId: registry.ownerId, change: canonicalChange(input.change) }) : null;
    return {
      ok: true,
      value: {
        registry: { symbol: registry.symbol, schemaRevision: registry.schemaRevision, dataRevision: registry.dataRevision },
        records: facts.records,
        affected,
        widgets,
        conversion,
        blocked,
        planToken,
        expiresAt: planToken === null ? null : new Date(claims.expiresAtMs).toISOString(),
      },
    };
  });
}

export type StructurePlanInput = Readonly<{ symbol: string; change: unknown; planToken: string }>;

/**
 * Whether a plan may still be carried out, for the owner and the registry as they are now. A token
 * not issued here for this owner and this change, or for another registry, is invalid; one past its
 * time has expired; one of other revisions is stale. Each asks for a new preview, and none writes.
 */
export function planFailure(signer: PlanSigner, input: Readonly<{ planToken: string; ownerId: string; change: unknown; registry: StoredRegistry }>, nowMs: number): Failure | null {
  const claims = signer.open(input.planToken, { ownerId: input.ownerId, change: canonicalChange(input.change) });
  if (claims === null || claims.registryId !== input.registry.id) return { code: "PLAN_INVALID" };
  const state = planState(claims, input.registry, nowMs);
  return state === "current" ? null : { code: state === "expired" ? "PLAN_EXPIRED" : "PLAN_STALE" };
}

/** The check of a plan in a read unit, with the change checked again against the registry as it is (D28–D30 make the same check under the writer). */
export function checkStructurePlan(deps: StructureDependencies, token: string, input: StructurePlanInput, requestId: string): Result<StructureChange> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<StructureChange> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const registry = activeRegistry(ports, owner.value, input.symbol);
    if (registry === null) return { ok: false, error: { code: "NOT_FOUND" } };
    const failure = planFailure(deps.signer, { planToken: input.planToken, ownerId: owner.value, change: input.change, registry }, nowMs);
    if (failure !== null) return { ok: false, error: failure };
    return checkedChange(ports, deps, registry, input.change);
  });
}

/** The owner a session may change the structure for, read before an operation of the gate begins; the writer reads it again at the commit. */
export function structureOwner(deps: Readonly<{ unit: ReadUnit<Pick<StructurePorts, "sessions" | "access">>; nowMs: () => number }>, token: string, requestId: string): Result<string> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports) => ownerOf(ports, token, nowMs, requestId));
}
