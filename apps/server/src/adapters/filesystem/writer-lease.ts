// WriterLeasePort (Architektura §4.8, §18.6): the single writer of an installation holds an
// exclusive system lock on the fixed file control/maintenance/writer.lock for its lifetime.
// The lock belongs to the open file description, not to the process: other descriptors of the
// file, spawned children (descriptors are close-on-exec) and timers cannot drop or inherit it,
// and the kernel releases it when the holder exits, also after SIGKILL. The file is never
// truncated, unlinked or replaced: another inode would bypass the lock. No PID, TTL or
// exclusive-create marker stands in for the lock.
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import path from "node:path";
import { tryLock } from "fs-native-extensions";

/** Lock file inside the maintenance mount; the field name reported in bootstrap failures. */
export const WRITER_LOCK_FILE = "writer.lock";

export type WriterLease = Readonly<{
  file: string;
  /** False after release: callers that need the writer role check it before any mutation. */
  isHeld: () => boolean;
  /** Releases the lock by closing its descriptor; the file stays in place. Idempotent. */
  release: () => void;
}>;

export type WriterLeaseResult =
  | Readonly<{ ok: true; lease: WriterLease }>
  | Readonly<{ ok: false; code: "INSTANCE_BUSY" | "LEASE_UNAVAILABLE"; fields: readonly string[] }>;

// O_NOFOLLOW refuses a symlinked lock file; Windows has no such flag and no POSIX symlink here.
const OPEN_FLAGS = constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
const LOCK_FILE_MODE = 0o600;

const failure = (code: "INSTANCE_BUSY" | "LEASE_UNAVAILABLE"): WriterLeaseResult => ({ ok: false, code, fields: [WRITER_LOCK_FILE] });

/**
 * Tries once, without waiting: a running writer means INSTANCE_BUSY at once. Anything that
 * prevents a real lock (no permission, not a regular file, symlink) is LEASE_UNAVAILABLE.
 */
export function acquireWriterLease(maintenanceDir: string): WriterLeaseResult {
  const file = path.join(maintenanceDir, WRITER_LOCK_FILE);
  let fd: number;
  try {
    // A write-capable descriptor: Linux grants an exclusive OFD lock only on one.
    fd = openSync(file, OPEN_FLAGS, LOCK_FILE_MODE);
  } catch {
    return failure("LEASE_UNAVAILABLE");
  }
  let outcome: "locked" | "busy" | "unavailable";
  try {
    outcome = !fstatSync(fd).isFile() ? "unavailable" : tryLock(fd) ? "locked" : "busy";
  } catch {
    outcome = "unavailable";
  }
  if (outcome !== "locked") {
    closeSync(fd);
    return failure(outcome === "busy" ? "INSTANCE_BUSY" : "LEASE_UNAVAILABLE");
  }

  let held = true;
  return {
    ok: true,
    lease: {
      file,
      isHeld: () => held,
      release: () => {
        if (held) {
          held = false;
          closeSync(fd);
        }
      },
    },
  };
}
