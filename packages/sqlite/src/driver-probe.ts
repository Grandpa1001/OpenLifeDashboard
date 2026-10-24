import Database from "better-sqlite3";

// Native driver probe for D02 (Architektura §6.1): proves that the real better-sqlite3 module
// loads on this platform and that commit and rollback behave on a file database. It creates
// only its own table in a caller-supplied scratch file; product schema arrives with D04.

export const PROBE_COMMITTED_ROWS = 3;
export const PROBE_ROLLED_BACK_ROWS = 2;

export type DriverProbeResult = Readonly<{
  sqliteVersion: string;
  rowsAfterCommit: number;
  rowsAfterRollback: number;
  rowsAfterReopen: number;
}>;

/** Thrown inside the second transaction so that the driver must roll it back. */
class IntentionalRollback extends Error {}

function readColumn(row: unknown, column: string): unknown {
  return typeof row === "object" && row !== null && column in row ? Reflect.get(row, column) : undefined;
}

function readNumber(row: unknown, column: string): number {
  const value = readColumn(row, column);
  if (typeof value !== "number") {
    throw new TypeError(`expected a numeric "${column}" column, got ${JSON.stringify(row)}`);
  }
  return value;
}

function countRows(db: Database.Database): number {
  return readNumber(db.prepare("SELECT COUNT(*) AS rows FROM driver_probe").get(), "rows");
}

/** Runs the probe on a new file; the caller owns creating and removing its directory. */
export function probeDriver(file: string): DriverProbeResult {
  const db = new Database(file, { fileMustExist: false });
  let result: Omit<DriverProbeResult, "rowsAfterReopen">;
  try {
    db.exec("CREATE TABLE driver_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO driver_probe (label) VALUES (?)");
    const insertAll = db.transaction((labels: readonly string[]) => {
      for (const label of labels) {
        insert.run(label);
      }
    });

    insertAll(Array.from({ length: PROBE_COMMITTED_ROWS }, (_, index) => `committed-${index}`));
    const rowsAfterCommit = countRows(db);

    const failingBatch = db.transaction(() => {
      insertAll(Array.from({ length: PROBE_ROLLED_BACK_ROWS }, (_, index) => `rolled-back-${index}`));
      throw new IntentionalRollback("probe rollback");
    });
    try {
      failingBatch();
    } catch (error) {
      if (!(error instanceof IntentionalRollback)) {
        throw error;
      }
    }
    const rowsAfterRollback = countRows(db);
    const version = readColumn(db.prepare("SELECT sqlite_version() AS version").get(), "version");
    result = { sqliteVersion: String(version), rowsAfterCommit, rowsAfterRollback };
  } finally {
    db.close();
  }

  // A fresh connection sees only what was committed to the file.
  const reopened = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return { ...result, rowsAfterReopen: countRows(reopened) };
  } finally {
    reopened.close();
  }
}
