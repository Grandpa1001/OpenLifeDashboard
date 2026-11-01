// Creating, reading, saving and deleting the dictionaries of the owner (Scope §5.8, Architektura
// §4.2, §5.2, §9.5; D24.1). A write runs in one unit of work: the access policy is read again inside
// it, the rules decide against the dictionaries as they stand in that unit, and the change, the
// columns it unpins and the audit entry commit or roll back together. A save carries the whole
// content and the revision it was built on (compare and set), so two tabs cannot both win and a
// repeat after a lost answer is a conflict, never a second change. No record is read or written:
// a record keeps its symbol whatever happens to the dictionary.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { validateDictionaryContent, validateNewDictionary, valueChanges, type DictionaryIssue, type DictionaryLimits } from "../domain/rules.js";
import type { ColumnDictionaryLinks, DictionaryStore, DictionaryUsage, StoredDictionary } from "../ports.js";

export type DictionaryPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  dictionaries: DictionaryStore;
  columnLinks: ColumnDictionaryLinks;
  audit: AppendAudit;
}>;

export type DictionaryDependencies = Readonly<{
  unit: UnitOfWork<DictionaryPorts> & ReadUnit<DictionaryPorts>;
  nowMs: () => number;
  /** A new identifier (UUIDv7) for a dictionary and for each new value. */
  newId: () => string;
  limits: DictionaryLimits;
}>;

/** A dictionary with the columns that show their values through it. */
export type DictionaryOverview = Readonly<{ dictionary: StoredDictionary; usages: readonly DictionaryUsage[] }>;

type Gate = Pick<DictionaryPorts, "sessions" | "access">;

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

/** A request that only repeats a taken symbol, or only hits the limit, is a conflict with the owner's dictionaries; anything else is invalid with all its issues. */
function refusal(issues: readonly DictionaryIssue[]): DomainFault {
  if (issues.every((issue) => issue.path === "symbol" && issue.code === "SYMBOL_TAKEN")) return new DomainFault({ code: "DICTIONARY_SYMBOL_TAKEN", fields: ["symbol"] });
  if (issues.every((issue) => issue.code === "LIMIT_DICTIONARIES")) return new DomainFault({ code: "DICTIONARY_LIMIT_EXCEEDED" });
  return new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(issues.map((issue) => issue.path))], issues: issues.map(({ path, code }) => ({ path, code })) });
}

function existing(ports: Pick<DictionaryPorts, "dictionaries">, ownerId: string, symbol: string): StoredDictionary {
  const dictionary = ports.dictionaries.find(ownerId, symbol);
  if (dictionary === null) throw new DomainFault({ code: "NOT_FOUND" });
  return dictionary;
}

const usagesOf = (all: readonly DictionaryUsage[], dictionaryId: string): DictionaryUsage[] => all.filter((usage) => usage.dictionaryId === dictionaryId);

export function createDictionary(deps: DictionaryDependencies, token: string, draft: unknown, requestId: string): Result<StoredDictionary> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<StoredDictionary> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const checked = validateNewDictionary(draft, { limits: deps.limits, takenSymbols: ports.dictionaries.takenSymbols(ownerId), count: ports.dictionaries.count(ownerId) });
    if (!checked.ok) throw refusal(checked.issues);
    const { symbol, ...content } = checked.value;
    const id = deps.newId();
    const nowIso = new Date(nowMs).toISOString();
    ports.dictionaries.insert({ id, ownerId, symbol, content, valueIds: content.values.map(() => deps.newId()), nowIso });
    ports.audit.append({ ownerId, action: "dictionary.created", entityId: id, at: nowIso, requestId, details: { symbol, values: content.values.length } });
    return { value: existing(ports, ownerId, symbol), invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/** The owner's dictionaries with the columns that use each, read in one snapshot. */
export function listDictionaries(deps: Pick<DictionaryDependencies, "unit" | "nowMs">, token: string, requestId: string): Result<readonly DictionaryOverview[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly DictionaryOverview[]> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const usages = ports.columnLinks.usages(owner.value);
    return { ok: true, value: ports.dictionaries.list(owner.value).map((dictionary) => ({ dictionary, usages: usagesOf(usages, dictionary.id) })) };
  });
}

export function getDictionary(deps: Pick<DictionaryDependencies, "unit" | "nowMs">, token: string, symbol: string, requestId: string): Result<DictionaryOverview> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<DictionaryOverview> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    const dictionary = ports.dictionaries.find(owner.value, symbol);
    return dictionary === null ? { ok: false, error: { code: "NOT_FOUND" } } : { ok: true, value: { dictionary, usages: usagesOf(ports.columnLinks.usages(owner.value), dictionary.id) } };
  });
}

export type DictionarySave = Readonly<{ symbol: string; expectedRevision: number; content: unknown }>;

/**
 * Replaces the name and the whole list of values of a dictionary on the revision the form was built
 * on. Another revision is a conflict and writes nothing; only then is the content checked.
 */
export function saveDictionary(deps: DictionaryDependencies, token: string, input: DictionarySave, requestId: string): Result<StoredDictionary> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<StoredDictionary> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const dictionary = existing(ports, ownerId, input.symbol);
    if (input.expectedRevision !== dictionary.revision) throw new DomainFault({ code: "DICTIONARY_CHANGED" });
    const checked = validateDictionaryContent(input.content, deps.limits);
    if (!checked.ok) throw refusal(checked.issues);
    const nowIso = new Date(nowMs).toISOString();
    if (!ports.dictionaries.replaceIfRevision(dictionary, checked.value, input.expectedRevision, deps.newId, nowIso)) throw new DomainFault({ code: "DICTIONARY_CHANGED" });
    const { added, removed } = valueChanges(dictionary.values, checked.value.values);
    ports.audit.append({ ownerId, action: "dictionary.updated", entityId: dictionary.id, at: nowIso, requestId, details: { symbol: dictionary.symbol, values: checked.value.values.length, added: added.join(","), removed: removed.join(",") } });
    return { value: existing(ports, ownerId, input.symbol), invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/**
 * Deletes a dictionary on the revision the owner saw. In the same unit every column that used it
 * is unpinned (it stays "choice", its values stay) and the deletion is audited with those columns.
 */
export function deleteDictionary(deps: Pick<DictionaryDependencies, "unit" | "nowMs">, token: string, input: Readonly<{ symbol: string; expectedRevision: number }>, requestId: string): Result<readonly DictionaryUsage[]> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<readonly DictionaryUsage[]> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const dictionary = existing(ports, ownerId, input.symbol);
    if (input.expectedRevision !== dictionary.revision || !ports.dictionaries.deleteIfRevision(dictionary, input.expectedRevision)) throw new DomainFault({ code: "DICTIONARY_CHANGED" });
    const nowIso = new Date(nowMs).toISOString();
    const unpinned = ports.columnLinks.unpin(ownerId, dictionary.id, nowIso);
    ports.audit.append({
      ownerId,
      action: "dictionary.deleted",
      entityId: dictionary.id,
      at: nowIso,
      requestId,
      // The audit takes scalar details: the columns as one list of `registry.column`.
      details: { symbol: dictionary.symbol, unpinnedColumns: unpinned.map((usage) => `${usage.registrySymbol}.${usage.columnSymbol}`).join(",") },
    });
    return { value: unpinned, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
