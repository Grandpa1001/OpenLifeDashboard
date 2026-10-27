// The first setup after the gate (Architektura §9.7, §18.7; D11.4): where it stands, and the
// owner's preferences. Access is the identity module's policy, read again inside the unit that
// writes; the preferences table is this module's. The stages are the starting data, then the
// preferences, then complete (the guide arrives with the Designer, D18).
import { DomainFault, type Commit, type ReadUnit, type Result, type UnitOfWork } from "../../../foundation/public.js";
import { decideAccess, nextActionFor, resolveSessionAccess, type NextAction } from "../../identity/public.js";
import type { OwnerPreferences, SetupPorts } from "../ports.js";

export type SetupStage = "data" | "preferences" | "complete";
export type DataChoice = "unselected" | "empty" | "imported";

export type SetupStatus = Readonly<{ stage: SetupStage; dataChoice: DataChoice; nextAction: NextAction }>;
export type PreferencesView = Readonly<{ preferences: OwnerPreferences | null; stage: SetupStage }>;

export type SetupDependencies = Readonly<{
  unit: UnitOfWork<SetupPorts> & ReadUnit<SetupPorts>;
  nowMs: () => number;
}>;

const stageOf = (dataChoice: DataChoice, preferences: OwnerPreferences | null): SetupStage =>
  dataChoice === "unselected" ? "data" : preferences === null ? "preferences" : "complete";

const failure = <T>(code: "AUTH_REQUIRED" | "RECOVERY_ACK_REQUIRED" | "MFA_REQUIRED" | "SETUP_DATA_REQUIRED" | "STEP_UP_REQUIRED" | "SETUP_DATA_ALREADY_CHOSEN"): Result<T> => ({ ok: false, error: { code } });

/** The stage for any live session of the owner: the wizard needs it before the data are open. */
export function readSetupStatus(deps: SetupDependencies, token: string, requestId: string): Result<SetupStatus> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<SetupStatus> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return failure("AUTH_REQUIRED");
    }
    // Identity is what counts here: the factor and the acknowledgment are stages the wizard shows.
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow && decision.code === "AUTH_REQUIRED") {
      return failure("AUTH_REQUIRED");
    }
    const preferences = ports.preferences.read(access.session.ownerId);
    return { ok: true, value: { stage: stageOf(access.snapshot.dataChoice, preferences), dataChoice: access.snapshot.dataChoice, nextAction: nextActionFor(access.snapshot, nowMs) } };
  });
}

/** The preferences, after the gate and the choice of data: private like every later screen. */
export function readOwnerPreferences(deps: SetupDependencies, token: string, requestId: string): Result<PreferencesView> {
  const nowMs = deps.nowMs();
  return deps.unit.read((ports): Result<PreferencesView> => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      return failure("AUTH_REQUIRED");
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      return failure(decision.code);
    }
    const preferences = ports.preferences.read(access.session.ownerId);
    return { ok: true, value: { preferences, stage: stageOf(access.snapshot.dataChoice, preferences) } };
  });
}

/** Saves the preferences in one unit of work with the policy check and the audit entry. */
export function saveOwnerPreferences(deps: SetupDependencies, token: string, preferences: OwnerPreferences, requestId: string): Result<PreferencesView> {
  const nowMs = deps.nowMs();
  const result = deps.unit.run((ports) => {
    const access = resolveSessionAccess(ports, token, nowMs, requestId);
    if (access === null) {
      throw new DomainFault({ code: "AUTH_REQUIRED" });
    }
    const decision = decideAccess(access.snapshot, "data", nowMs);
    if (!decision.allow) {
      throw new DomainFault({ code: decision.code });
    }
    ports.preferences.write(access.session.ownerId, preferences, nowMs);
    ports.audit.append({
      ownerId: access.session.ownerId,
      action: "settings.preferences_saved",
      entityId: access.session.ownerId,
      at: new Date(nowMs).toISOString(),
      requestId,
      details: { timezone: preferences.timezone, locale: preferences.locale },
    });
    return { value: { preferences, stage: stageOf(access.snapshot.dataChoice, preferences) }, invalidations: [] } satisfies Commit<PreferencesView>;
  });
  return result.ok ? { ok: true, value: result.value.value } : result;
}
