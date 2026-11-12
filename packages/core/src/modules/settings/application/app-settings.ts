// Reading, changing and resetting the application options (Architektura §14.1, §14.3; D41.2). A change
// runs in one unit of work: the access policy is read again inside it, every option of the request is
// checked against the catalog and against the others (a record must fit its body), and the stored
// values and their audit entries commit or roll back together. The request carries the whole set it
// wants or nothing is written.
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import type { AppendAudit } from "../../audit/public.js";
import { decideAccess, resolveSessionAccess, type AccessOperation, type IdentityAccessReader, type SessionStore } from "../../identity/public.js";
import { acceptsSettingValue, resolveSettings } from "../domain/resolve-settings.js";
import type { EffectiveSetting, SettingDefinition, SettingOverrides } from "../domain/types.js";
import type { AppSettingStore } from "../ports.js";

export type AppSettingsPorts = Readonly<{
  sessions: Pick<SessionStore, "findActive">;
  access: IdentityAccessReader;
  appSettings: AppSettingStore;
  audit: AppendAudit;
}>;

export type AppSettingsDependencies = Readonly<{
  unit: UnitOfWork<AppSettingsPorts> & ReadUnit<AppSettingsPorts>;
  nowMs: () => number;
  catalog: readonly SettingDefinition[];
  /** The environment overrides parsed at start: they lock the options they name. */
  environment: SettingOverrides["environment"];
}>;

type Gate = Pick<AppSettingsPorts, "sessions" | "access">;

function ownerOf(ports: Gate, token: string, nowMs: number, requestId: string, operation: AccessOperation = "data"): Result<string> {
  const access = resolveSessionAccess(ports, token, nowMs, requestId);
  if (access === null) return { ok: false, error: { code: "AUTH_REQUIRED" } };
  const decision = decideAccess(access.snapshot, operation, nowMs);
  return decision.allow ? { ok: true, value: access.session.ownerId } : { ok: false, error: { code: decision.code } };
}

function writerOf(ports: Gate, token: string, nowMs: number, requestId: string, operation: AccessOperation = "data"): string {
  const owner = ownerOf(ports, token, nowMs, requestId, operation);
  if (!owner.ok) throw new DomainFault(owner.error);
  return owner.value;
}

/** The effective options for the stored values; stored values that no longer fit the catalog are a fault of the installation, not of the request. */
function effective(deps: Pick<AppSettingsDependencies, "catalog" | "environment">, stored: Readonly<Record<string, unknown>>): readonly EffectiveSetting[] {
  const resolution = resolveSettings(deps.catalog, { database: stored, environment: deps.environment });
  if (!resolution.ok) throw new Error(`the stored application options do not fit the catalog: ${resolution.fields.join(", ")}`);
  return resolution.settings;
}

/** The effective options with the source of each. */
export function readAppSettings(deps: AppSettingsDependencies, token: string, requestId: string): Result<readonly EffectiveSetting[]> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<readonly EffectiveSetting[]> => {
    const owner = ownerOf(ports, token, nowMs, requestId);
    if (!owner.ok) return owner;
    return { ok: true, value: effective(deps, ports.appSettings.readAll()) };
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Where the option is refused: its own path, and why. */
const issue = (key: string, code: string) => ({ path: `values.${key}`, code });

/**
 * Changes one or more options at once. Unknown keys, a value of the wrong type or outside the range,
 * an option the owner may not change and one locked by the environment are all reported with their
 * paths and codes and nothing is written. A set that breaks a rule between options (the record limit
 * and the body limit) is refused as a whole. An option that asks for a fresh second factor changes only
 * for a session that has one (the policy's `step_up`, D43.4): any other session is refused with the
 * policy's code, `STEP_UP_REQUIRED`, and nothing is written. The audit keeps the old and the new value.
 */
export function patchAppSettings(deps: AppSettingsDependencies, token: string, input: unknown, requestId: string): Result<readonly EffectiveSetting[]> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<readonly EffectiveSetting[]> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    if (!isPlainObject(input) || !isPlainObject(input["values"]) || Object.keys(input["values"]).length === 0) {
      throw new DomainFault({ code: "VALIDATION_FAILED", fields: ["values"], issues: [{ path: "values", code: "VALUES_REQUIRED" }] });
    }
    const values = input["values"];
    const byKey = new Map(deps.catalog.map((definition) => [definition.key, definition]));
    const issues: Array<{ path: string; code: string }> = [];
    for (const [key, value] of Object.entries(values)) {
      const definition = byKey.get(key);
      if (definition === undefined) issues.push(issue(key, "SETTING_UNKNOWN"));
      else if (!definition.editable) issues.push(issue(key, "SETTING_READ_ONLY"));
      else if (Object.hasOwn(deps.environment, key)) issues.push(issue(key, "SETTING_LOCKED_BY_ENV"));
      else if (!acceptsSettingValue(definition, value)) issues.push(issue(key, "SETTING_INVALID"));
    }
    if (issues.length > 0) throw new DomainFault({ code: "VALIDATION_FAILED", fields: [...new Set(issues.map((each) => each.path))], issues });

    const stored = ports.appSettings.readAll();
    const before = effective(deps, stored);
    const after = resolveSettings(deps.catalog, { database: { ...stored, ...values }, environment: deps.environment });
    if (!after.ok) {
      const fields = after.fields.filter((field) => Object.hasOwn(values, field));
      const named = fields.length > 0 ? fields : Object.keys(values);
      throw new DomainFault({ code: "VALIDATION_FAILED", fields: named.map((key) => `values.${key}`), issues: named.map((key) => issue(key, "SETTING_CONFLICT")) });
    }
    if (Object.keys(values).some((key) => byKey.get(key)?.stepUp === true)) writerOf(ports, token, nowMs, requestId, "step_up");

    const nowIso = new Date(nowMs).toISOString();
    ports.appSettings.writeMany(values, nowMs);
    for (const key of Object.keys(values)) {
      const old = before.find((setting) => setting.key === key)?.value ?? null;
      ports.audit.append({ ownerId, action: "setting.changed", entityId: key, at: nowIso, requestId, details: { key, oldValue: old, newValue: after.settings.find((setting) => setting.key === key)?.value ?? null } });
    }
    return { value: after.settings, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}

/**
 * Takes the stored value of an option away, so it is the default again. An option locked by the
 * environment stays at the value of the environment: the reset removes the stored override and does
 * not get round the lock, and the answer shows the lock. An option that asks for a fresh second factor
 * is reset only with the same fresh second factor as its change.
 */
export function resetAppSetting(deps: AppSettingsDependencies, token: string, key: string, requestId: string): Result<EffectiveSetting> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports): Commit<EffectiveSetting> => {
    const ownerId = writerOf(ports, token, nowMs, requestId);
    const definition = deps.catalog.find((candidate) => candidate.key === key);
    if (definition === undefined) throw new DomainFault({ code: "NOT_FOUND" });
    if (definition.stepUp === true) writerOf(ports, token, nowMs, requestId, "step_up");
    const before = effective(deps, ports.appSettings.readAll()).find((setting) => setting.key === key);
    if (ports.appSettings.remove(key)) {
      ports.audit.append({ ownerId, action: "setting.reset", entityId: key, at: new Date(nowMs).toISOString(), requestId, details: { key, oldValue: before?.value ?? null } });
    }
    const after = effective(deps, ports.appSettings.readAll()).find((setting) => setting.key === key);
    if (after === undefined) throw new Error(`the option ${key} is missing from the effective options`);
    return { value: after, invalidations: [] };
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
