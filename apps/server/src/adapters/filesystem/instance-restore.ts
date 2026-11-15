// The files of the restore of a whole instance (Architektura §11.3.3 points 3 to 5; D50.2). The current database
// set (`app.db`, `app.db-wal`, `app.db-shm`) is moved aside together, unchanged, into a folder of its own beside
// it (a move on one file system, so nothing is copied and nothing is lost whatever state the set is in, a damaged
// database included), the verified `app.db` of the package takes its place through a temporary file and a
// rename, and an old WAL can never be attached to it because it was moved with its database. A failure at any
// point moves the parked set back and leaves the folder as it was. The caller holds the writer lease and has
// verified the package.
import { copyFileSync, existsSync, mkdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DATABASE_SNAPSHOT_FILES } from "@openlife/contracts/backups/database-snapshot";
import { sha256File } from "./database-snapshots.js";
import { syncDirectory, syncFile } from "./durable-files.js";

export type RestoreFilesInputs = Readonly<{
  /** The live database file; its `-wal` and `-shm` are the companions of the set. */
  databaseFile: string;
  /** The published, verified package directory. */
  packageDir: string;
  /** Names the parked folder; UTC compact time and an id. */
  parkedName: string;
}>;

export type RestoreFilesResult =
  | Readonly<{ ok: true; parkedDir: string; /** Moves the parked set back and removes the restored files: what a later failure of the caller needs. */ rollback: () => void }>
  | Readonly<{ ok: false; code: "RESTORE_PARK_FAILED" | "RESTORE_PLACE_FAILED" | "RESTORE_CHECKSUM_MISMATCH" }>;

const COMPANIONS = ["", "-wal", "-shm"] as const;

export function restoreDatabaseFiles(inputs: RestoreFilesInputs): RestoreFilesResult {
  const dir = path.dirname(inputs.databaseFile);
  const parkedDir = path.join(dir, `.restore-parked-${inputs.parkedName}`);
  const temporary = `${inputs.databaseFile}.restoring`;
  const parked: string[] = [];

  const putBack = (): void => {
    rmSync(temporary, { force: true, recursive: true });
    for (const suffix of COMPANIONS) rmSync(`${inputs.databaseFile}${suffix}`, { force: true });
    for (const suffix of parked.splice(0)) renameSync(path.join(parkedDir, `${path.basename(inputs.databaseFile)}${suffix}`), `${inputs.databaseFile}${suffix}`);
    // Nothing is left to keep in it: the folder of a restore that did not happen is not left behind.
    rmdirSync(parkedDir);
  };

  try {
    mkdirSync(parkedDir);
    for (const suffix of COMPANIONS) {
      if (existsSync(`${inputs.databaseFile}${suffix}`)) {
        renameSync(`${inputs.databaseFile}${suffix}`, path.join(parkedDir, `${path.basename(inputs.databaseFile)}${suffix}`));
        parked.push(suffix);
      }
    }
    syncDirectory(dir);
  } catch {
    try {
      putBack();
    } catch {
      // The folder keeps what it could not move back; the parked folder is named in the journal of the caller.
    }
    return { ok: false, code: "RESTORE_PARK_FAILED" };
  }

  try {
    const source = path.join(inputs.packageDir, DATABASE_SNAPSHOT_FILES.database);
    copyFileSync(source, temporary);
    syncFile(temporary);
    // The package was verified a moment ago; the copy must be what it was verified as.
    if (sha256File(temporary) !== sha256File(source)) {
      putBack();
      return { ok: false, code: "RESTORE_CHECKSUM_MISMATCH" };
    }
    renameSync(temporary, inputs.databaseFile);
    syncDirectory(dir);
  } catch {
    try {
      putBack();
    } catch {
      // Reported through the journal: the set is in the parked folder.
    }
    return { ok: false, code: "RESTORE_PLACE_FAILED" };
  }
  return { ok: true, parkedDir, rollback: putBack };
}
