// Classification of the database file before the writer opens it (Architektura §4.8). Nothing
// here changes the main file: a file without the SQLite WAL header is judged from its header
// alone, a WAL database is read through a read-only connection (SQLite may leave its -wal/-shm
// companions). A foreign or newer database is never adopted, repaired or migrated.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import Database from "better-sqlite3";
import { targetSchemaVersion, type MigrationPlan } from "./migration.js";

export type DatabaseRefusalCode = "DATABASE_UNRECOGNIZED" | "DATABASE_NEWER" | "MIGRATION_CHECKSUM_MISMATCH" | "INSTANCE_METADATA_INVALID";

export type DatabaseInspection =
  /** No file, an empty file, or a WAL database without any table (an interrupted init). */
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "current"; schemaVersion: number }>
  | Readonly<{ kind: "pending"; fromSchemaVersion: number; toSchemaVersion: number }>
  | Readonly<{ kind: "refused"; code: DatabaseRefusalCode; fields: readonly string[] }>;

/** Field reported for a file that is not this application's database. */
export const DATABASE_FIELD = "database";
const COMPANION_SUFFIXES = ["-wal", "-shm", "-journal"];
const HEADER_BYTES = 100;
const SQLITE_MAGIC = "SQLite format 3\0";
/** Header bytes 18/19 (file format write/read version) are 2 for a database in WAL mode. */
const WAL_FORMAT = 2;

type ManifestRow = Readonly<{ version: number; id: string; checksum: string }>;

const unrecognized: DatabaseInspection = { kind: "refused", code: "DATABASE_UNRECOGNIZED", fields: [DATABASE_FIELD] };

const exists = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

type HeaderCheck = "missing" | "empty" | "wal" | "foreign";

function checkHeader(file: string): HeaderCheck {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "foreign";
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return "foreign";
    }
    if (stats.size === 0) {
      return "empty";
    }
    const header = Buffer.alloc(HEADER_BYTES);
    const read = readSync(fd, header, 0, HEADER_BYTES, 0);
    const isSqlite = read === HEADER_BYTES && header.subarray(0, SQLITE_MAGIC.length).toString("latin1") === SQLITE_MAGIC;
    return isSqlite && header[18] === WAL_FORMAT && header[19] === WAL_FORMAT ? "wal" : "foreign";
  } finally {
    closeSync(fd);
  }
}

function isManifestRow(row: unknown): row is ManifestRow {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const [version, id, checksum] = ["version", "id", "checksum"].map((key) => Reflect.get(row, key));
  return Number.isSafeInteger(version) && typeof id === "string" && typeof checksum === "string";
}

type Contents =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "foreign" }>
  | Readonly<{ kind: "ours"; manifest: readonly ManifestRow[]; instanceIds: readonly unknown[] }>;

function readContents(file: string, busyTimeoutMs: number): Contents {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  } catch {
    return { kind: "foreign" };
  }
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").pluck().all();
    if (tables.length === 0) {
      return { kind: "empty" };
    }
    if (!tables.includes("schema_migration") || !tables.includes("instance")) {
      return { kind: "foreign" };
    }
    const manifest: unknown[] = db.prepare("SELECT version, id, checksum FROM schema_migration ORDER BY version").all();
    if (!manifest.every(isManifestRow)) {
      return { kind: "foreign" };
    }
    return { kind: "ours", manifest, instanceIds: db.prepare("SELECT instance_id FROM instance").pluck().all() };
  } catch {
    return { kind: "foreign" };
  } finally {
    db.close();
  }
}

export function inspectDatabase(
  file: string,
  plan: MigrationPlan,
  expected: Readonly<{ instanceId: string; busyTimeoutMs: number }>,
): DatabaseInspection {
  const header = checkHeader(file);
  if (header === "missing") {
    // Journal companions without their database are left-overs nobody may silently replace.
    return COMPANION_SUFFIXES.some((suffix) => exists(`${file}${suffix}`)) ? unrecognized : { kind: "empty" };
  }
  if (header !== "wal") {
    return header === "empty" ? { kind: "empty" } : unrecognized;
  }
  const contents = readContents(file, expected.busyTimeoutMs);
  if (contents.kind !== "ours") {
    return contents.kind === "empty" ? { kind: "empty" } : unrecognized;
  }

  const { manifest } = contents;
  if (manifest.length === 0 || manifest.some((row, index) => row.version !== index + 1)) {
    return unrecognized;
  }
  // Unknown versions or IDs come from a newer image (or another product): never downgraded.
  if (manifest.some((row) => plan[row.version - 1]?.id !== row.id)) {
    return { kind: "refused", code: "DATABASE_NEWER", fields: ["schemaVersion"] };
  }
  const changed = manifest.filter((row) => plan[row.version - 1]?.checksum !== row.checksum).map((row) => row.id);
  if (changed.length > 0) {
    return { kind: "refused", code: "MIGRATION_CHECKSUM_MISMATCH", fields: changed };
  }
  if (contents.instanceIds.length !== 1 || contents.instanceIds[0] !== expected.instanceId) {
    return { kind: "refused", code: "INSTANCE_METADATA_INVALID", fields: ["instanceId"] };
  }
  const applied = manifest.length;
  const target = targetSchemaVersion(plan);
  return applied === target ? { kind: "current", schemaVersion: applied } : { kind: "pending", fromSchemaVersion: applied, toSchemaVersion: target };
}
