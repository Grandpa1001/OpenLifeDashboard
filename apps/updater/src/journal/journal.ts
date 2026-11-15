// The journal of the updater, `control/update-state.json` (Architektura §11.2.1; D52.2). A record is written so
// that a crash at any point of the write leaves a whole record, the old one or the new one, and the reading takes
// the newest record that is whole:
//   1. the new record is written to `update-state.json.tmp` and flushed;
//   2. the current file becomes `update-state.json.prev`;
//   3. the new file becomes `update-state.json`, and the directory is flushed.
// A file is whole when it parses, has the shape of a record and its hash agrees with its text, so a torn write or
// a changed byte is not read as a record. After a crash between the steps 2 and 3 there is no current file, and
// the temporary one, which is newer than the previous, is the record. When no file is whole, the journal says so
// and does not guess: an updater that cannot read its own state opens nothing.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UPDATE_STATE_FILE, updateRecordSchema, type UpdateRecord } from "@openlife/contracts/updates/state";

/** The operations on the files, so a test can stop the write at any step. */
export type JournalFiles = Readonly<{
  writeFlushed: (file: string, content: string) => void;
  rename: (from: string, to: string) => void;
  flushDirectory: (dir: string) => void;
  read: (file: string) => string | null;
}>;

export const nodeJournalFiles: JournalFiles = {
  writeFlushed: (file, content) => {
    rmSync(file, { force: true });
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => renameSync(from, to),
  flushDirectory: (dir) => {
    if (process.platform === "win32") return;
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  read: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
};

export type JournalRead = Readonly<{ ok: true; record: UpdateRecord | null; source: "current" | "temporary" | "previous" | "none" }> | Readonly<{ ok: false; code: "JOURNAL_UNREADABLE" }>;

const hashOf = (record: UpdateRecord): string => createHash("sha256").update(JSON.stringify(record)).digest("hex");

/** The text of a file for a record: the record and the hash of it, one line. */
export const fileTextOf = (record: UpdateRecord): string => `${JSON.stringify({ record, sha256: hashOf(record) })}\n`;

function wholeRecord(text: string | null): UpdateRecord | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { record?: unknown; sha256?: unknown };
    const record = updateRecordSchema.safeParse(parsed.record);
    return record.success && typeof parsed.sha256 === "string" && parsed.sha256 === hashOf(record.data) ? record.data : null;
  } catch {
    return null;
  }
}

export type Journal = Readonly<{
  /** The newest record that is whole, or null when the installation has never written one; an unreadable journal is an error, not an empty one. */
  read: () => JournalRead;
  /** Writes the record in the three steps; a throw at any of them leaves the journal readable. */
  write: (record: UpdateRecord) => void;
}>;

export function openJournal(dir: string, files: JournalFiles = nodeJournalFiles): Journal {
  const current = path.join(dir, UPDATE_STATE_FILE);
  const temporary = `${current}.tmp`;
  const previous = `${current}.prev`;
  return {
    read: () => {
      const candidates = [
        { source: "current", text: files.read(current) },
        { source: "temporary", text: files.read(temporary) },
        { source: "previous", text: files.read(previous) },
      ] as const;
      const whole = candidates.flatMap((candidate) => {
        const record = wholeRecord(candidate.text);
        return record === null ? [] : [{ source: candidate.source, record }];
      });
      if (whole.length === 0) {
        // Nothing written and nothing left behind is a new installation; anything left behind that is not whole is not.
        return candidates.every((candidate) => candidate.text === null) ? { ok: true, record: null, source: "none" } : { ok: false, code: "JOURNAL_UNREADABLE" };
      }
      const newest = whole.reduce((best, each) => (each.record.seq > best.record.seq ? each : best));
      return { ok: true, record: newest.record, source: newest.source };
    },
    write: (record) => {
      files.writeFlushed(temporary, fileTextOf(record));
      if (files.read(current) !== null) files.rename(current, previous);
      files.rename(temporary, current);
      files.flushDirectory(dir);
    },
  };
}
