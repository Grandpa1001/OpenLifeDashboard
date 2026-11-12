// The kinds the owner filters the audit log by (Scope §5.9): sign-ins, security, structure and updates. An
// action is `<entity>.<event>` (the entity is the part before the dot); a kind is a set of entities with the
// exact actions that join or leave it. One definition serves both the label of an entry and the filter of the
// query, so an entry is never shown under a kind the filter does not find it in.

export const AUDIT_KINDS = ["logins", "security", "structure", "updates"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditKindFilter = Readonly<{
  /** Whole entities, the part of an action before the dot. */
  entities: readonly string[];
  /** Single actions that belong to the kind besides its entities. */
  actions: readonly string[];
  /** Actions of those entities that belong elsewhere. */
  except: readonly string[];
}>;

/** Proving or failing to prove who is asking: the password at sign-in, the second factor, a step-up. */
const SIGN_IN_ACTIONS = ["login.succeeded", "login.failed", "mfa.verified", "mfa.step_up", "mfa.failed", "mfa.recovery_used", "password.confirmed", "password.confirm_failed"] as const;

export const AUDIT_KIND_FILTERS: Readonly<Record<AuditKind, AuditKindFilter>> = {
  logins: { entities: [], actions: SIGN_IN_ACTIONS, except: [] },
  // The account and what protects it: the owner, the password, the second factor, the sessions and the devices, and the trail itself (its retention).
  security: { entities: ["owner", "password", "mfa", "session", "device", "audit"], actions: [], except: SIGN_IN_ACTIONS },
  // What the owner has built and configured: registries, dictionaries, ConfigTable, screens, the options and the setup.
  structure: { entities: ["registry", "dictionary", "config", "screen", "setting", "settings", "setup"], actions: [], except: [] },
  // Updates and copies of the installation (written from D49 on).
  updates: { entities: ["update", "backup"], actions: [], except: [] },
};

const entityOf = (action: string): string => action.slice(0, Math.max(0, action.indexOf(".")));

/** The kind an action is shown under, or null for an action no filter names. */
export function auditKindOf(action: string): AuditKind | null {
  const entity = entityOf(action);
  for (const kind of AUDIT_KINDS) {
    const filter = AUDIT_KIND_FILTERS[kind];
    if (filter.actions.includes(action) || (filter.entities.includes(entity) && !filter.except.includes(action))) {
      return kind;
    }
  }
  return null;
}
