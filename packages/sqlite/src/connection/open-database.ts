// SQLite connections (Architektura §4.5, §4.8): every connection sets foreign keys, the busy
// timeout and synchronous=FULL and reads each value back; the writer also confirms WAL. A value
// that does not stick closes the connection with an error naming the setting, instead of
// running on weaker guarantees. The writer is opened only by a process holding the writer lease.
import Database from "better-sqlite3";

export type ConnectionRole = "writer" | "reader";

export type ConnectionOptions = Readonly<{
  role: ConnectionRole;
  /** DB_BUSY_TIMEOUT_MS, validated by the bootstrap parser (Architektura §14.5). */
  busyTimeoutMs: number;
}>;

export type SqliteConnection = Readonly<{
  role: ConnectionRole;
  /** The driver handle; adapters reach it only through a unit of work (transactions). */
  handle: Database.Database;
  close: () => void;
}>;

/** SQLite's value of synchronous=FULL. */
const SYNCHRONOUS_FULL = 2;

/** A connection setting that SQLite did not confirm on read-back. */
export class ConnectionSettingError extends Error {
  readonly setting: string;

  constructor(setting: string) {
    super(`SQLite did not confirm ${setting}`);
    this.name = "ConnectionSettingError";
    this.setting = setting;
  }
}

function confirm(db: Database.Database, setting: string, assignment: string | undefined, expected: number | string): void {
  if (assignment !== undefined) {
    db.pragma(`${setting} = ${assignment}`);
  }
  if (db.pragma(setting, { simple: true }) !== expected) {
    throw new ConnectionSettingError(setting);
  }
}

/** Opens and configures a connection; the reader is read-only and needs an existing file. */
export function openDatabase(file: string, options: ConnectionOptions): SqliteConnection {
  if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0) {
    throw new RangeError("busyTimeoutMs must be a non-negative integer");
  }
  const db = options.role === "writer" ? new Database(file) : new Database(file, { readonly: true, fileMustExist: true });
  try {
    // Foreign keys are a per-connection setting and must be on before any transaction.
    confirm(db, "foreign_keys", "ON", 1);
    confirm(db, "busy_timeout", String(options.busyTimeoutMs), options.busyTimeoutMs);
    confirm(db, "synchronous", "FULL", SYNCHRONOUS_FULL);
    // WAL is a property of the database file, set by the writer; a reader only observes it.
    confirm(db, "journal_mode", options.role === "writer" ? "WAL" : undefined, "wal");
  } catch (error) {
    db.close();
    throw error;
  }
  return { role: options.role, handle: db, close: () => db.close() };
}
