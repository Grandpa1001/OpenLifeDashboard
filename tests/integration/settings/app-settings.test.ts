// D41.2 — the application options on a real SQLite file (Architektura §14.1, §14.3; DEV §9.38): the
// production adapter and use cases in one unit of work. The access policy is the one input stood in for.
// AC1: a change of two options at once is written whole and audited with the old and the new value; a
//      failing audit or a refused option takes everything back; the values are still there when the
//      database is opened again; a reset takes the stored value away.
// AC2: an unknown key, a wrong type, a value outside the range, an option read-only or locked by the
//      environment and a set that breaks the rule between the record and the body limits each give a
//      stable code with paths and write nothing; an option that asks for a fresh second factor changes with one and
//      is refused with an older one (D43.4).
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { afterEach, describe, expect, it } from "vitest";
import { patchAppSettings, readAppSettings, resetAppSetting } from "../../../packages/core/dist/modules/settings/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindAppSettingStore } from "../../../packages/sqlite/dist/adapters/settings/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { closeRigs, createIdentityRig, RIG_T0, type IdentityRig } from "../../support/identity-rig.ts";

afterEach(closeRigs);

const OWNER = "owner-1";
const TOKEN = "owner-token";
/** The gate stood in for: the owner's token passes the data access, any other has no session. */
const gate = {
  sessions: { findActive: (token: string) => (token === TOKEN ? { sessionId: "s-1", ownerId: OWNER, assurance: "totp" as const, passwordVerifiedAtMs: RIG_T0, totpVerifiedAtMs: RIG_T0, accessEpoch: 1 } : null) },
  access: { current: () => ({ ownerExists: true, ownerMatches: true, sessionState: "active" as const, epochMatches: true, mfaPolicy: "required" as const, enrollmentState: "complete" as const, assurance: "totp" as const, trustedState: "not_used" as const, dataChoice: "empty" as const, totpVerifiedAtMs: RIG_T0, passwordVerifiedAtMs: RIG_T0 }) },
};

function setup(rig: IdentityRig, options: { failingAudit?: boolean; environment?: Record<string, unknown> } = {}) {
  const unit = createUnitOfWork(rig.connection, (tx) => ({
    ...gate,
    appSettings: bindAppSettingStore(tx),
    audit: options.failingAudit === true ? { append: () => { throw new Error("the audit failed"); } } : bindAppendAudit(tx),
  }));
  return { unit, deps: { unit, nowMs: () => rig.clock.now, catalog: SETTINGS_CATALOG, environment: options.environment ?? {} } };
}

const stored = (rig: IdentityRig) => rig.rows<{ key: string; value_json: string }>("SELECT key, value_json FROM app_setting ORDER BY key").map((row) => [row.key, JSON.parse(row.value_json)]);
const audits = (rig: IdentityRig) => rig.rows<{ action: string; entity_id: string; details: string }>("SELECT action, entity_id, details FROM audit_log WHERE action LIKE 'setting.%' ORDER BY rowid").map((entry) => [entry.action, entry.entity_id, JSON.parse(entry.details)]);
const valueOf = (settings: ReadonlyArray<{ key: string; value: unknown; source: string }>, key: string) => settings.find((setting) => setting.key === key);
const ok = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe("D41.2-AC1 one change, whole, audited and kept", () => {
  it("writes two options at once, reads them with their source, and audits the old and the new value of each", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    expect(valueOf(ok(readAppSettings(deps, TOKEN, "r-0")), "limits.registries")).toMatchObject({ value: 200, source: "default" });

    const changed = ok(patchAppSettings(deps, TOKEN, { values: { "limits.registries": 50, "logs.level": "warn" } }, "r-1"));
    expect(valueOf(changed, "limits.registries")).toMatchObject({ value: 50, source: "db", editable: true, restartRequired: false });
    expect(valueOf(changed, "logs.level")).toMatchObject({ value: "warn", source: "db" });
    expect(stored(rig)).toEqual([["limits.registries", 50], ["logs.level", "warn"]]);
    expect(audits(rig)).toEqual([
      ["setting.changed", "limits.registries", { key: "limits.registries", oldValue: 200, newValue: 50 }],
      ["setting.changed", "logs.level", { key: "logs.level", oldValue: "info", newValue: "warn" }],
    ]);
    expect(valueOf(ok(readAppSettings(deps, TOKEN, "r-2")), "limits.registries")).toMatchObject({ value: 50, source: "db" });
  });

  it("takes everything back when one option of the set is refused or the audit fails", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    const refused = patchAppSettings(deps, TOKEN, { values: { "limits.registries": 50, "logs.level": "trace" } }, "r-1");
    expect(refused).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(stored(rig)).toEqual([]);
    expect(audits(rig)).toEqual([]);

    const failing = setup(rig, { failingAudit: true });
    expect(() => patchAppSettings(failing.deps, TOKEN, { values: { "limits.registries": 50 } }, "r-2")).toThrow("the audit failed");
    expect(stored(rig)).toEqual([]);
  });

  it("keeps the values when the database is opened again, and a reset takes the stored value away", async () => {
    const rig = await createIdentityRig();
    ok(patchAppSettings(setup(rig).deps, TOKEN, { values: { "limits.registries": 50, "backup.time": "03:30" } }, "r-1"));
    const again = setup(rig).deps;
    expect(valueOf(ok(readAppSettings(again, TOKEN, "r-2")), "backup.time")).toMatchObject({ value: "03:30", source: "db" });

    const reset = ok(resetAppSetting(again, TOKEN, "limits.registries", "r-3"));
    expect(reset).toMatchObject({ key: "limits.registries", value: 200, source: "default" });
    expect(stored(rig)).toEqual([["backup.time", "03:30"]]);
    expect(audits(rig).at(-1)).toEqual(["setting.reset", "limits.registries", { key: "limits.registries", oldValue: 50 }]);
    // Resetting what was never changed writes nothing and audits nothing.
    const count = audits(rig).length;
    expect(ok(resetAppSetting(again, TOKEN, "limits.registries", "r-4"))).toMatchObject({ source: "default" });
    expect(audits(rig)).toHaveLength(count);
  });
});

describe("D41.2-AC2 what is refused, and why", () => {
  const code = (result: { ok: boolean; error?: { code: string; issues?: ReadonlyArray<{ path: string; code: string }> } }) => (result.ok ? "ok" : [result.error?.code, ...(result.error?.issues ?? []).map((each) => `${each.path}:${each.code}`)]);

  it("an unknown key, a wrong type, a value outside the range and a read-only option each give their code and write nothing", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    for (const [values, expected] of [
      [{ "no.such.option": 1 }, ["VALIDATION_FAILED", "values.no.such.option:SETTING_UNKNOWN"]],
      [{ "updates.checkEnabled": "yes" }, ["VALIDATION_FAILED", "values.updates.checkEnabled:SETTING_INVALID"]],
      [{ "limits.registries": 0 }, ["VALIDATION_FAILED", "values.limits.registries:SETTING_INVALID"]],
      [{ "limits.registries": 1001 }, ["VALIDATION_FAILED", "values.limits.registries:SETTING_INVALID"]],
      [{ "backup.time": "25:00" }, ["VALIDATION_FAILED", "values.backup.time:SETTING_INVALID"]],
      [{ "limits.jsonBodyKiB": 512 }, ["VALIDATION_FAILED", "values.limits.jsonBodyKiB:SETTING_READ_ONLY"]],
    ] as const) {
      expect(code(patchAppSettings(deps, TOKEN, { values }, "r-1")), JSON.stringify(values)).toEqual(expected);
    }
    for (const input of [null, {}, { values: {} }, { values: [] }, { values: "x" }]) {
      expect(code(patchAppSettings(deps, TOKEN, input, "r-2")), JSON.stringify(input)).toEqual(["VALIDATION_FAILED", "values:VALUES_REQUIRED"]);
    }
    expect(stored(rig)).toEqual([]);
    expect(audits(rig)).toEqual([]);
  });

  it("an option locked by the environment is told as locked, stays at the value of the environment, and a reset does not get round the lock", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig, { environment: { "limits.recordMaxKiB": 64 } });
    expect(valueOf(ok(readAppSettings(deps, TOKEN, "r-0")), "limits.recordMaxKiB")).toMatchObject({ value: 64, source: "env", editable: false, restartRequired: true });
    expect(code(patchAppSettings(deps, TOKEN, { values: { "limits.recordMaxKiB": 100, "limits.registries": 50 } }, "r-1"))).toEqual(["VALIDATION_FAILED", "values.limits.recordMaxKiB:SETTING_LOCKED_BY_ENV"]);
    expect(stored(rig)).toEqual([]);
    // An override stored before the variable was set is removed by the reset, and the lock still stands.
    rig.sql(`INSERT INTO app_setting (key, value_json, updated_at_ms) VALUES ('limits.recordMaxKiB', '120', ${RIG_T0})`);
    expect(ok(resetAppSetting(deps, TOKEN, "limits.recordMaxKiB", "r-2"))).toMatchObject({ value: 64, source: "env", editable: false });
    expect(stored(rig)).toEqual([]);
  });

  it("a set that breaks the rule between the record limit and the body limit is refused as a whole", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    expect(code(patchAppSettings(deps, TOKEN, { values: { "limits.recordMaxKiB": 250, "limits.registries": 50 } }, "r-1"))).toEqual(["VALIDATION_FAILED", "values.limits.recordMaxKiB:SETTING_CONFLICT"]);
    expect(stored(rig)).toEqual([]);
    expect(ok(patchAppSettings(deps, TOKEN, { values: { "limits.recordMaxKiB": 248 } }, "r-2")).find((setting) => setting.key === "limits.recordMaxKiB")).toMatchObject({ value: 248 });
  });

  it("an option that asks for a fresh second factor changes and resets while the factor is fresh, and is refused with nothing written when it is older than five minutes", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    // Fresh: the change and the reset go through (D43.4).
    expect(valueOf(ok(patchAppSettings(deps, TOKEN, { values: { "backup.nightlyKeep": 20 } }, "r-1")), "backup.nightlyKeep")).toMatchObject({ value: 20, source: "db" });
    expect(valueOf([ok(resetAppSetting(deps, TOKEN, "backup.nightlyKeep", "r-2"))], "backup.nightlyKeep")).toMatchObject({ source: "default" });
    expect(valueOf(ok(patchAppSettings(deps, TOKEN, { values: { "backup.nightlyKeep": 20, "limits.registries": 50 } }, "r-3")), "limits.registries")).toMatchObject({ value: 50 });

    // The factor was proven six minutes ago: all three are refused whole, and the stored values stay.
    rig.clock.now += 6 * 60 * 1000;
    const before = stored(rig);
    expect(code(patchAppSettings(deps, TOKEN, { values: { "backup.nightlyKeep": 30 } }, "r-4"))).toEqual(["STEP_UP_REQUIRED"]);
    expect(code(patchAppSettings(deps, TOKEN, { values: { "backup.nightlyKeep": 30, "limits.registries": 60 } }, "r-5"))).toEqual(["STEP_UP_REQUIRED"]);
    expect(code(resetAppSetting(deps, TOKEN, "audit.retentionDays", "r-6"))).toEqual(["STEP_UP_REQUIRED"]);
    expect(code(resetAppSetting(deps, TOKEN, "no.such.option", "r-7"))).toEqual(["NOT_FOUND"]);
    expect(stored(rig)).toEqual(before);
    // An option that asks for nothing still changes with the old factor.
    expect(valueOf(ok(patchAppSettings(deps, TOKEN, { values: { "limits.registries": 70 } }, "r-8")), "limits.registries")).toMatchObject({ value: 70 });
  });

  it("no session is no access, for a read, a change and a reset", async () => {
    const rig = await createIdentityRig();
    const { deps } = setup(rig);
    expect(code(readAppSettings(deps, "other", "r-1"))).toEqual(["AUTH_REQUIRED"]);
    expect(code(patchAppSettings(deps, "other", { values: { "limits.registries": 50 } }, "r-2"))).toEqual(["AUTH_REQUIRED"]);
    expect(code(resetAppSetting(deps, "other", "limits.registries", "r-3"))).toEqual(["AUTH_REQUIRED"]);
    expect(stored(rig)).toEqual([]);
  });
});
