// What the retention keeps and what it may remove (Architektura §11.3.1 point 7, §14 `backup.nightlyKeep`,
// `backup.safetyKeepDays`; D49.1). Pure: it is given the finished copies of this installation and the moment,
// and says for each one whether it stays and why; the file system is another module's business.
//
// The rules, in the order they decide:
//  - a copy an operation is using (an update, a recovery) is never removed;
//  - a copy the owner asked for (`manual`) is never removed by the retention;
//  - the newest finished copy of every reason stays whatever its age or the limit, so the last good copy of a
//    kind outlives the rest;
//  - `nightly` copies beyond the newest `nightlyKeep` go; the others (`pre_*`) go when older than `safetyKeepDays`.

export const RETENTION_REASONS = ["nightly", "manual", "pre_update", "pre_delete", "pre_type_change", "pre_migration", "pre_restore"] as const;
export type RetentionReason = (typeof RETENTION_REASONS)[number];

export type RetentionCandidate = Readonly<{ name: string; reason: RetentionReason; startedAt: string }>;

export type RetentionPolicy = Readonly<{
  nightlyKeep: number;
  safetyKeepDays: number;
  nowMs: number;
  /** Names of the copies an operation in progress is using. */
  inUse: ReadonlySet<string>;
}>;

export type KeepReason = "in_use" | "manual" | "last_of_kind" | "within_limit" | "within_days";
export type RemoveReason = "over_limit" | "expired";

export type RetentionPlan = Readonly<{
  keep: ReadonlyArray<Readonly<{ name: string; why: KeepReason }>>;
  remove: ReadonlyArray<Readonly<{ name: string; why: RemoveReason }>>;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function planRetention(candidates: readonly RetentionCandidate[], policy: RetentionPolicy): RetentionPlan {
  // Newest first; the name breaks a tie so the plan does not depend on the order of the input.
  const newestFirst = [...candidates].sort((a, b) => (a.startedAt === b.startedAt ? b.name.localeCompare(a.name) : b.startedAt.localeCompare(a.startedAt)));
  const seenKinds = new Set<RetentionReason>();
  let nightlies = 0;
  const keep: Array<{ name: string; why: KeepReason }> = [];
  const remove: Array<{ name: string; why: RemoveReason }> = [];
  for (const copy of newestFirst) {
    const newestOfKind = !seenKinds.has(copy.reason);
    seenKinds.add(copy.reason);
    if (copy.reason === "nightly") nightlies += 1;
    if (policy.inUse.has(copy.name)) keep.push({ name: copy.name, why: "in_use" });
    else if (copy.reason === "manual") keep.push({ name: copy.name, why: "manual" });
    else if (newestOfKind) keep.push({ name: copy.name, why: "last_of_kind" });
    else if (copy.reason === "nightly" && nightlies <= policy.nightlyKeep) keep.push({ name: copy.name, why: "within_limit" });
    else if (copy.reason === "nightly") remove.push({ name: copy.name, why: "over_limit" });
    else if (policy.nowMs - Date.parse(copy.startedAt) <= policy.safetyKeepDays * DAY_MS) keep.push({ name: copy.name, why: "within_days" });
    else remove.push({ name: copy.name, why: "expired" });
  }
  return { keep, remove };
}
