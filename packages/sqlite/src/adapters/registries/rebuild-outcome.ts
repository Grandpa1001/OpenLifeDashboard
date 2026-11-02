// What a rebuild interrupted by a crash left in the database (Architektura §4.8, §11.4; D27.2),
// read at the start under the writer lease, before anything writes. The rebuild is one transaction,
// so the registry is either at the schema revision the operation started from (nothing was kept) or
// one above it (the transaction committed and only closing the operation was lost). A table of a
// rebuild that is still there, a registry that is gone and any other revision are not states a
// rebuild leaves: they are `unknown`, and a human decides. A deletion (D30.1) is the same transaction
// with `deleted_at` set: a registry deleted one revision above committed, one deleted at the revision
// the operation started from is not a state the deletion leaves. Like the migrator, it reads the driver
// handle directly: it runs in the bootstrap, before any unit of work exists.
import type { SqliteConnection } from "../../connection/open-database.js";
import { REBUILD_TABLE_SUFFIX } from "./table-rebuild.js";

export type RebuildOutcome = "not_committed" | "committed" | "unknown";

export function readRebuildOutcome(connection: SqliteConnection, registryId: string, fromSchemaRevision: number): RebuildOutcome {
  const db = connection.handle;
  const leftovers = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'").get(`reg\\_%${REBUILD_TABLE_SUFFIX.replace(/_/g, "\\_")}`) as { n: number };
  if (leftovers.n > 0) return "unknown";
  const registry = db.prepare("SELECT schema_revision, deleted_at FROM registry WHERE id = ?").get(registryId) as { schema_revision: number; deleted_at: string | null } | undefined;
  if (registry === undefined) return "unknown";
  if (registry.deleted_at !== null) return registry.schema_revision === fromSchemaRevision + 1 ? "committed" : "unknown";
  if (registry.schema_revision === fromSchemaRevision) return "not_committed";
  return registry.schema_revision === fromSchemaRevision + 1 ? "committed" : "unknown";
}
