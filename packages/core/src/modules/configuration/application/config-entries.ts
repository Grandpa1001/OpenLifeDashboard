// Creating, reading, saving and deleting the entries of ConfigTable (Scope §5.7, S17, Architektura
// §4.2, §9.5; D25.1). A write runs in one unit of work: the access policy is read again inside it,
// the rules decide against the entries as they stand in that unit, and the change and its audit
// entry commit or roll back together. The audit of the database is the one place the value of an
// entry is written besides its own table (§9.5): the old and the new value of every change. A save
// carries the whole content and the revision it was built on, so two tabs cannot both win.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { validateConfigContent, validateNewConfigEntry, type ConfigIssue, type ConfigLimits } from "../domain/rules.js";
import type { ConfigBindingCounts, ConfigStore, StoredConfigEntry } from "../ports.js";

export type ConfigPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  config: ConfigStore;
  configBindings: ConfigBindingCounts;
  audit: AppendAudit;
}>;

export type ConfigDependencies = Readonly<{
  unit: UnitOfWork<ConfigPorts> & ReadUnit<ConfigPorts>;
  nowMs: () => number;
  /** A new identifier (UUIDv7) for an entry. */
  newId: () => string;
  limits: ConfigLimits;
}>;

/** An entry with the number of bindings that point at it. */
export type ConfigEntryOverview = Readonly<{ entry: StoredConfigEntry; bindings: number }>;

type Gate = Pick<ConfigPorts, "sessions" | "access">;

/** The owner of a request past the data access, or the failure that stops it. */
function ownerOf(ports: Gate, token: string, nowMs: number, requestId: string): Result<string> {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
  const decision = decideAccess(access.snapshot, "data", nowMs);
  return decision.allow ? { ok: true, value: access.session.ownerId } : { ok: false, error: { code: decision.code } };
}

function writerOf(ports: Gate, token: string, nowMs: number, requestId: string): string {
  const owner = ownerOf(ports, token, nowMs, requestId);
  if (!owner.ok) throw new DomainFault(owner.error);
  return owner.value;
}

/** A request that only repeats a taken symbol, or only hits the limit, is a conflict with the owner's entries; anything else is invalid with all its issues (paths and codes, never a value). */
function refusal(issues: readonly ConfigIssue[]): DomainFault {
  if (issues.every((issue) => issue.path === "symbol" && issue.code === "SYMBOL_TAKEN")) return new DomainFault({ code: "CONFIG_SYMBOL_TAKEN", fields: ["symbol"] });
  if (issues.every((issue) => issue.code === "LIMIT_ENTRIES")) return new DomainFault({ code: "CONFIG_LIMIT_EXCEEDED" });
  return new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(issues.map((issue) => issue.path))], issues: issues.map(({ path, code }) => ({ path, code })) });
}

function existing(ports: Pick<ConfigPorts, "config">, ownerId: string, symbol: string): StoredConfigEntry {
  const entry = ports.config.find(ownerId, symbol);
  if (entry === null) throw new DomainFault({ code: "NOT_FOUND" });
  return entry;
}

export function createConfigEntry(deps: ConfigDependencies, token: string, draft: unknown, requestId: string): Result<StoredConfigEntry> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<StoredConfigEntry> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const checked = validateNewConfigEntry(draft, { limits: deps.limits, takenSymbols: ports.config.takenSymbols(ownerId), count: ports.config.count(ownerId) });
    if (!checked.ok) throw refusal(checked.issues);
    const { symbol, ...content } = checked.value;
    const id = deps.newId();
    const nowIso = new Date(nowMs).toISOString();
    ports.config.insert({ id, ownerId, symbol, content, nowIso });
    ports.audit.append({ ownerId, action: "config.created", entityId: id, at: nowIso, requestId, details: { symbol, value: content.value } });
    return { value: existing(ports, ownerId, symbol), invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/** The owner's entries with the number of bindings of each, read in one snapshot. */
export function listConfigEntries(deps: Pick<ConfigDependencies, "unit" | "nowMs">, token: string, requestId: string): Result<readonly ConfigEntryOverview[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly ConfigEntryOverview[]> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const counts = ports.configBindings.counts(owner.value);
    return { ok: true, value: ports.config.list(owner.value).map((entry) => ({ entry, bindings: counts.get(entry.id) ?? 0 })) };
  });
}

export function getConfigEntry(deps: Pick<ConfigDependencies, "unit" | "nowMs">, token: string, symbol: string, requestId: string): Result<ConfigEntryOverview> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<ConfigEntryOverview> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const entry = ports.config.find(owner.value, symbol);
    return entry === null ? { ok: false, error: { code: "NOT_FOUND" } } : { ok: true, value: { entry, bindings: ports.configBindings.counts(owner.value).get(entry.id) ?? 0 } };
  });
}

export type ConfigSave = Readonly<{ symbol: string; expectedRevision: number; content: unknown }>;

/**
 * Replaces the name, the value and the description of an entry on the revision the form was built
 * on. Another revision is a conflict and writes nothing; only then is the content checked. The audit
 * keeps the old and the new value, also when only the name or the description changed.
 */
export function saveConfigEntry(deps: ConfigDependencies, token: string, input: ConfigSave, requestId: string): Result<StoredConfigEntry> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<StoredConfigEntry> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const entry = existing(ports, ownerId, input.symbol);
    if (input.expectedRevision !== entry.revision) throw new DomainFault({ code: "CONFIG_CHANGED" });
    const checked = validateConfigContent(input.content, deps.limits);
    if (!checked.ok) throw refusal(checked.issues);
    const nowIso = new Date(nowMs).toISOString();
    if (!ports.config.replaceIfRevision(entry, checked.value, input.expectedRevision, nowIso)) throw new DomainFault({ code: "CONFIG_CHANGED" });
    ports.audit.append({ ownerId, action: "config.updated", entityId: entry.id, at: nowIso, requestId, details: { symbol: entry.symbol, oldValue: entry.value, newValue: checked.value.value } });
    return { value: existing(ports, ownerId, input.symbol), invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/**
 * Deletes an entry on the revision the owner saw; its symbol is free again. The bindings that point
 * at it stay and are broken from now on. The audit keeps the last value and how many bindings there were.
 */
export function deleteConfigEntry(deps: Pick<ConfigDependencies, "unit" | "nowMs">, token: string, input: Readonly<{ symbol: string; expectedRevision: number }>, requestId: string): Result<Readonly<{ bindings: number }>> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<Readonly<{ bindings: number }>> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const entry = existing(ports, ownerId, input.symbol);
    if (input.expectedRevision !== entry.revision || !ports.config.deleteIfRevision(entry, input.expectedRevision)) throw new DomainFault({ code: "CONFIG_CHANGED" });
    const bindings = ports.configBindings.counts(ownerId).get(entry.id) ?? 0;
    const nowIso = new Date(nowMs).toISOString();
    ports.audit.append({ ownerId, action: "config.deleted", entityId: entry.id, at: nowIso, requestId, details: { symbol: entry.symbol, oldValue: entry.value, bindings } });
    return { value: { bindings }, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
