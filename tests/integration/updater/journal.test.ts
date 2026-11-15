// D52.2 — the journal of the updater on real files (Architektura §11.2.1).
// AC1: a record written is read back whole after the journal is opened again, with the newest taken among the files
//      that are whole; a new installation reads as empty and a journal whose files are all damaged is unreadable
//      (the updater opens nothing), never read as empty.
// AC2: the write stopped at any of its steps (before the temporary file is whole, after it, between the two
//      renames, after both) leaves a journal that reads as the old record or the new one and never as anything
//      else; a torn temporary file and a changed byte are not read; the fence survives the restart.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UPDATE_STATE_FILE, type UpdateRecord } from "@openlife/contracts/updates/state";
import { describe, expect, it } from "vitest";
import { fileTextOf, nodeJournalFiles, openJournal, type JournalFiles } from "../../../apps/updater/src/journal/journal.js";
import { beginInstall } from "../../../apps/updater/src/state-machine/begin.js";
import { initialRecord, transition } from "../../../apps/updater/src/state-machine/transitions.js";

const NOW = "2026-11-15T12:00:00.000Z";
const folder = (): string => mkdtempSync(path.join(tmpdir(), "journal-"));
const recordAt = (seq: number, over: Partial<UpdateRecord> = {}): UpdateRecord => ({ ...initialRecord(NOW), seq, ...over });
const file = (dir: string, suffix = ""): string => path.join(dir, `${UPDATE_STATE_FILE}${suffix}`);

describe("D52.2-AC1 a record is read back whole and an unreadable journal is not an empty one", () => {
  it("reads a new installation as empty and a written record as itself, in private files", () => {
    const dir = folder();
    const journal = openJournal(dir);
    expect(journal.read()).toEqual({ ok: true, record: null, source: "none" });
    const first = recordAt(1, { state: "checking", operationId: "11111111-1111-4111-8111-111111111111", fence: 4 });
    journal.write(first);
    expect(openJournal(dir).read()).toEqual({ ok: true, record: first, source: "current" });
    const second = { ...first, seq: 2, state: "pulling" as const };
    journal.write(second);
    expect(openJournal(dir).read()).toEqual({ ok: true, record: second, source: "current" });
    expect(readdirSync(dir).sort()).toEqual([UPDATE_STATE_FILE, `${UPDATE_STATE_FILE}.prev`]);
    if (process.platform !== "win32") expect((statSync(file(dir)).mode & 0o777).toString(8)).toBe("600");
  });

  it("takes the previous record when the current file is changed, and says unreadable when every file is damaged", () => {
    const dir = folder();
    const journal = openJournal(dir);
    journal.write(recordAt(1));
    journal.write(recordAt(2, { state: "checking", operationId: "11111111-1111-4111-8111-111111111111" }));
    const text = readFileSync(file(dir), "utf8");
    chmodSync(file(dir), 0o600);
    writeFileSync(file(dir), text.replace("checking", "pulling "));
    expect(journal.read()).toMatchObject({ ok: true, source: "previous", record: { seq: 1 } });
    writeFileSync(file(dir, ".prev"), "{not json");
    expect(journal.read()).toEqual({ ok: false, code: "JOURNAL_UNREADABLE" });
    // A file that is not a record is a damaged journal, not a new installation.
    const other = folder();
    writeFileSync(file(other), "garbage");
    expect(openJournal(other).read()).toEqual({ ok: false, code: "JOURNAL_UNREADABLE" });
  });

  it("does not read a file whose hash does not agree with its record", () => {
    const dir = folder();
    const record = recordAt(3);
    const text = JSON.parse(fileTextOf(record)) as { record: UpdateRecord; sha256: string };
    writeFileSync(file(dir), `${JSON.stringify({ record: { ...text.record, seq: 99 }, sha256: text.sha256 })}\n`);
    expect(openJournal(dir).read()).toEqual({ ok: false, code: "JOURNAL_UNREADABLE" });
  });
});

describe("D52.2-AC2 a write stopped at any step leaves the old record or the new one", () => {
  /** A journal on real files whose operation number `crashAt` throws, as a process killed there would not return. */
  function crashingFiles(crashAt: number): JournalFiles {
    let step = 0;
    const tick = (): void => {
      step += 1;
      if (step === crashAt) throw new Error("crash");
    };
    return {
      writeFlushed: (target, content) => {
        tick();
        nodeJournalFiles.writeFlushed(target, content);
      },
      rename: (from, to) => {
        tick();
        nodeJournalFiles.rename(from, to);
      },
      flushDirectory: (dir) => {
        tick();
        nodeJournalFiles.flushDirectory(dir);
      },
      read: nodeJournalFiles.read,
    };
  }

  it("reads the old or the new record after a stop at each of the four operations of the write, and then goes on", () => {
    for (let crashAt = 1; crashAt <= 4; crashAt += 1) {
      const dir = folder();
      const old = recordAt(1, { state: "checking", operationId: "11111111-1111-4111-8111-111111111111", fence: 2 });
      const next = recordAt(2, { state: "pulling", operationId: old.operationId, fence: 2 });
      openJournal(dir).write(old);
      expect(() => openJournal(dir, crashingFiles(crashAt)).write(next), `stop ${crashAt}`).toThrow("crash");
      const read = openJournal(dir).read();
      expect(read.ok, `stop ${crashAt}`).toBe(true);
      expect(read.ok && [1, 2].includes(read.record?.seq ?? -1), `stop ${crashAt}: ${JSON.stringify(read)}`).toBe(true);
      expect(read.ok && JSON.stringify(read.record) === JSON.stringify(read.record?.seq === 2 ? next : old), `stop ${crashAt} reads a whole record, not a mixture`).toBe(true);
      // The journal takes the next record whatever the stop left, and the one after reads as it.
      const after = recordAt((read.ok ? (read.record?.seq ?? 0) : 0) + 1, { state: "quiescing", operationId: old.operationId, fence: 2 });
      openJournal(dir).write(after);
      expect(openJournal(dir).read()).toMatchObject({ ok: true, record: { seq: after.seq } });
    }
  });

  it("takes the temporary file as the record when the stop is between the two renames and the current file is gone", () => {
    const dir = folder();
    const old = recordAt(1);
    const next = recordAt(2, { state: "checking", operationId: "11111111-1111-4111-8111-111111111111" });
    openJournal(dir).write(old);
    // Exactly the state after the first rename: the previous file is the old record, the temporary one the new, no current file.
    writeFileSync(file(dir, ".tmp"), fileTextOf(next));
    nodeJournalFiles.rename(file(dir), file(dir, ".prev"));
    expect(existsSync(file(dir))).toBe(false);
    expect(openJournal(dir).read()).toMatchObject({ ok: true, source: "temporary", record: { seq: 2 } });
  });

  it("does not read a torn temporary file and keeps the whole current one", () => {
    const dir = folder();
    const journal = openJournal(dir);
    const old = recordAt(1, { state: "checking", operationId: "11111111-1111-4111-8111-111111111111" });
    journal.write(old);
    const torn = fileTextOf(recordAt(2, { state: "pulling", operationId: old.operationId }));
    writeFileSync(file(dir, ".tmp"), torn.slice(0, Math.floor(torn.length / 2)));
    expect(openJournal(dir).read()).toEqual({ ok: true, record: old, source: "current" });
    journal.write(recordAt(2, { state: "pulling", operationId: old.operationId }));
    expect(openJournal(dir).read()).toMatchObject({ ok: true, record: { seq: 2 } });
  });

  it("keeps the fence across the restart: a command of the crashed writer is refused after it, a newer one is taken", () => {
    const dir = folder();
    const journal = openJournal(dir);
    const begun = beginInstall(initialRecord(NOW), { v: 1, operationId: "22222222-2222-4222-8222-222222222222", issuedAt: Date.parse(NOW), nonce: "n".repeat(24), command: { type: "install", release: "1.2.3", fence: 5 } }, NOW);
    if (!begun.ok) throw new Error("not begun");
    journal.write(begun.record);
    const closed = transition(begun.record, "idle", {}, NOW);
    if (!closed.ok) throw new Error("not closed");
    journal.write(closed.record);

    const reopened = openJournal(dir).read();
    if (!reopened.ok || reopened.record === null) throw new Error("not read");
    const attempt = (fence: number) => beginInstall(reopened.record!, { v: 1, operationId: "33333333-3333-4333-8333-333333333333", issuedAt: Date.parse(NOW), nonce: "n".repeat(24), command: { type: "install", release: "1.2.4", fence } }, NOW);
    expect(attempt(4)).toEqual({ ok: false, code: "STALE_FENCE" });
    expect(attempt(5).ok).toBe(true);
    expect(attempt(6).ok).toBe(true);
    mkdirSync(path.join(dir, "unused"), { recursive: true });
  });
});
