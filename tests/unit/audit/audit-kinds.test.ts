// D43.6 — the kinds of the audit log (Scope §5.9): one definition labels an entry and filters the query.
// AC1: the kinds of the core are the kinds of the contract; every action the application writes today has
//      the kind the Security page shows it under; an action no filter names has none; no action is in two kinds.
import { AUDIT_KIND_NAMES } from "@openlife/contracts/http/security";
import { AUDIT_KINDS, AUDIT_KIND_FILTERS, auditKindOf } from "../../../packages/core/src/modules/audit/public.js";
import { describe, expect, it } from "vitest";

/** The actions the application writes, by the kind they are shown under (a new action must be added here). */
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  logins: ["login.succeeded", "login.failed", "mfa.verified", "mfa.step_up", "mfa.failed", "mfa.recovery_used", "password.confirmed", "password.confirm_failed"],
  security: [
    "owner.created", "owner.password_reset", "owner.password_changed", "owner.mfa_reset", "password.change_failed",
    "mfa.enrollment_started", "mfa.enrolled", "mfa.recovery_acknowledged", "mfa.recovery_reissued", "mfa.recovery_regenerated", "mfa.restarted", "mfa.disabled",
    "session.revoked", "session.revoked_others", "device.revoked", "device.revoked_all",
  ],
  structure: [
    "setup.data_chosen", "settings.preferences_saved", "setting.changed", "setting.reset",
    "registry.created", "registry.deleted", "registry.restored", "registry.column_added", "registry.column_removed", "registry.column_renamed", "registry.column_required_changed", "registry.column_type_changed",
    "dictionary.created", "dictionary.updated", "dictionary.deleted", "config.created", "config.updated", "config.deleted", "screen.created", "screen.design_saved",
  ],
  updates: ["update.installed", "backup.created"],
};

describe("D43.6-AC1 the kinds of the audit log", () => {
  it("are the kinds of the contract, in the same order", () => {
    expect([...AUDIT_KINDS]).toEqual([...AUDIT_KIND_NAMES]);
    expect(Object.keys(AUDIT_KIND_FILTERS)).toEqual([...AUDIT_KINDS]);
  });

  it("show every action the application writes under its kind, and an unknown action under none", () => {
    for (const [kind, actions] of Object.entries(KNOWN)) {
      for (const action of actions) expect(auditKindOf(action), action).toBe(kind);
    }
    expect(auditKindOf("nothing.happened")).toBeNull();
    expect(auditKindOf("nodot")).toBeNull();
  });

  it("never put an action in two kinds: the sign-in actions of the second factor leave the security kind", () => {
    const security = AUDIT_KIND_FILTERS.security;
    for (const action of AUDIT_KIND_FILTERS.logins.actions) {
      expect(security.except, action).toContain(action);
      expect(auditKindOf(action), action).toBe("logins");
    }
  });
});
