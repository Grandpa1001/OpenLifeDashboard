// Database copy for snapshots (Architektura §11.3.1, §11.4). The SQLite Backup API reads the
// committed state through the source connection, including pages still in the WAL; the WAL and
// shared-memory files themselves are never copied. The copy is then switched to a rollback
// journal so it is one self-contained file that a read-only check opens without companions.
// Only the copy gets an extra connection; the source keeps its single writer.
import { statSync } from "node:fs";
import Database from "better-sqlite3";
import type { SqliteConnection } from "../connection/open-database.js";

export type DatabaseCopyFacts = Readonly<{
  schemaVersion: number;
  instanceId: string;
  bytes: number;
}>;

export type DatabaseCopyProblem = "unreadable" | "integrity" | "foreign_keys" | "manifest";

export type DatabaseCopyExamination =
  | Readonly<{ ok: true; facts: DatabaseCopyFacts }>
  | Readonly<{ ok: false; problem: DatabaseCopyProblem }>;

/** Copies the committed state of `source` into the new file `target` and makes it standalone. */
export async function copyDatabase(source: SqliteConnection, target: string): Promise<void> {
  await source.handle.backup(target);
  const copy = new Database(target, { fileMustExist: true });
  try {
    if (copy.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
      throw new Error("the snapshot copy did not leave WAL mode");
    }
  } finally {
    copy.close();
  }
}

/**
 * Read-only check of a copy: full integrity_check, an empty foreign_key_check and a readable
 * manifest and instance identity. A copy still in WAL mode is refused rather than opened.
 */
export function examineDatabaseCopy(file: string): DatabaseCopyExamination {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  try {
    if (db.pragma("journal_mode", { simple: true }) !== "delete") {
      return { ok: false, problem: "unreadable" };
    }
    if (db.pragma("integrity_check", { simple: true }) !== "ok") {
      return { ok: false, problem: "integrity" };
    }
    const violations: unknown = db.pragma("foreign_key_check");
    if (!Array.isArray(violations) || violations.length > 0) {
      return { ok: false, problem: "foreign_keys" };
    }
    const schemaVersion: unknown = db.prepare("SELECT max(version) FROM schema_migration").pluck().get();
    const instanceIds: unknown[] = db.prepare("SELECT instance_id FROM instance").pluck().all();
    const [instanceId] = instanceIds;
    if (!Number.isSafeInteger(schemaVersion) || typeof schemaVersion !== "number" || instanceIds.length !== 1 || typeof instanceId !== "string") {
      return { ok: false, problem: "manifest" };
    }
    return { ok: true, facts: { schemaVersion, instanceId, bytes: statSync(file).size } };
  } catch (error) {
    // A damaged page can make any read throw; a missing table means no manifest of ours.
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    return { ok: false, problem: code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB" ? "integrity" : "manifest" };
  } finally {
    db.close();
  }
}
