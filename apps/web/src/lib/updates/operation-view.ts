// What the operation of an update says to the owner (Scope §5.9, S14; Architektura §11.2.2 step 8; D57.2). The operation is the one the updater has
// on its journal, as `GET /api/v1/updates` gives it; this is the reading of it for the screens: whether it is going on (so the state is asked for
// again), at which stage, and what became of it once it is over. What became of it is told from the state alone, never from the answer to the
// request that started it, which may never have come: an update that was begun and whose connection was cut is still an update that is going on.
import type { UpdatesStatusDto } from "@openlife/contracts/http/updates";

export type OperationDto = NonNullable<UpdatesStatusDto["operation"]>;

/** How often the state is asked for while an update goes on. */
export const UPDATE_POLL_MS = 2000;

/** The stages the owner sees, in order; `rolling_back` is its own line that is not one of them. */
export const UPDATE_STAGES = ["checking", "pulling", "quiescing", "backing_up", "switching", "verifying", "committing"] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];

const ENDED: ReadonlySet<string> = new Set(["idle", "completed", "rolled_back", "recovery_failed"]);

/** True while the updater works on the operation or waits for the new app: the page asks again and says where it is. */
export const isGoingOn = (operation: OperationDto | null | undefined): operation is OperationDto => operation !== null && operation !== undefined && !ENDED.has(operation.state);

/** What the page polls on: an update that goes on. */
export const shouldPoll = (data: UpdatesStatusDto | undefined): boolean => data !== undefined && isGoingOn(data.operation);

export type UpdateResult =
  | Readonly<{ kind: "updated"; operationId: string; version: string }>
  | Readonly<{ kind: "returned"; operationId: string; code: string | null }>
  | Readonly<{ kind: "stuck"; operationId: string; code: string | null }>;

/**
 * The outcome of the last operation, until the owner dismisses it. An operation that is `completed` is a success only when the application that
 * answers now is the release it was for; one that ended `idle` or `rolled_back` is a return to the previous version with the code that stopped it
 * (an operation that was never started has no code and says nothing); `recovery_failed` holds the installation and says so.
 */
export function resultOf(data: UpdatesStatusDto | undefined, dismissedId: string | null): UpdateResult | null {
  const operation = data?.operation ?? null;
  if (data === undefined || operation === null || operation.operationId === dismissedId) return null;
  if (operation.state === "completed") return operation.targetRelease !== null && operation.targetRelease === data.current ? { kind: "updated", operationId: operation.operationId, version: data.current } : null;
  if (operation.state === "recovery_failed") return { kind: "stuck", operationId: operation.operationId, code: operation.error?.code ?? null };
  if ((operation.state === "idle" || operation.state === "rolled_back") && operation.error !== null) return { kind: "returned", operationId: operation.operationId, code: operation.error.code };
  return null;
}

/** The codes the updater ends an operation with that the page has a sentence for (README, "When an update does not finish"). */
export const KNOWN_RESULT_CODES: readonly string[] = [
  "ABORTED", "UPDATER_RESTARTED", "CATALOG_MISSING", "CATALOG_TOO_LARGE", "CATALOG_INVALID", "RELEASE_UNKNOWN", "RELEASE_REQUIRES_ADMIN", "PULL_FAILED", "DIGEST_MISMATCH", "BACKUP_MISSING", "BACKUP_INVALID", "PREVIOUS_UNKNOWN", "START_TIMEOUT", "B_EXITED", "B_OOM_KILLED", "B_MIGRATION_FAILED", "B_MISSING", "VERSION_MISMATCH", "SCHEMA_MISMATCH", "RELEASE_FILE_FAILED", "SWITCH_FAILED",
];

const DISMISSED_KEY = "openlife.updates.dismissed";

/** The operation whose result the owner has closed, kept in this browser; a browser that keeps nothing shows the result again, which is harmless. */
export function dismissedOperation(): string | null {
  try {
    return globalThis.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissOperation(operationId: string): void {
  try {
    globalThis.localStorage.setItem(DISMISSED_KEY, operationId);
  } catch {
    // Nothing is kept; the result stays on the page of this visit only.
  }
}
