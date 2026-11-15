// D51.2 — the drills of a damaged package and of a locked database (Architektura §11.3.1, §11.3.3; Scope NF-05).
// AC1: every part of a bundle (app.db, meta.json, checksums.json, export.json), a missing file, an extra file, a
//      link in place of a file and a database that is garbage under honest checksums is refused with the part
//      named by the catalog, by backup-verify and by restore-instance alike; the package and the current database
//      stay as they were, and the retention removes none of them even under a keep that would remove every
//      ordinary copy.
// AC2: a write lock held on the database by another connection (an uncommitted change) neither blocks a copy nor
//      leaks into it: the copy is the committed state and verifies; the lock is not broken.
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { afterEach, describe, expect, it } from "vitest";
import { pruneBackups } from "../../../apps/server/dist/adapters/filesystem/backup-retention.js";
import { stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { booksOverApi } from "../../support/books-http.ts";
import { backupsDir, databaseFile, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const run = (name: string, setup: Installation, input?: unknown) =>
  runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${name}.js`), ["--installation", setup.instance.dir], { PATH: process.env["PATH"] ?? "", ...setup.instance.env }, input === undefined ? undefined : JSON.stringify(input));
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const failureOf = (output: string, event: string) => outputEvent(output, event);
/** Every file of a folder with its hash: what a refused command must leave as it found it. */
const treeHash = (dir: string): string =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((entry) => (statSync(path.join(dir, entry)).isFile() ? `${entry}:${sha256(path.join(dir, entry))}` : `${entry}/`))
    .join("|");
const setOnDisk = (setup: Installation): string => ["app.db", "app.db-wal", "app.db-shm"].map((file) => { const full = path.join(setup.instance.dir, "data", file); return existsSync(full) ? `${file}:${sha256(full)}` : `${file}:absent`; }).join("|");

const flipByte = (file: string): void => {
  const bytes = readFileSync(file);
  bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)]! + 1) % 256;
  writeFileSync(file, bytes);
};
const packageName = (n: number): string => `2026010${n}T000000Z-manual-${randomUUID()}`;

type Damage = Readonly<{ label: string; apply: (dir: string) => void; fields: readonly string[] }>;
const DAMAGES: readonly Damage[] = [
  { label: "a changed byte of app.db", apply: (dir) => flipByte(path.join(dir, "app.db")), fields: ["app.db"] },
  { label: "a changed meta.json", apply: (dir) => writeFileSync(path.join(dir, "meta.json"), readFileSync(path.join(dir, "meta.json"), "utf8").replace("manual", "nightly")), fields: ["meta.json"] },
  { label: "a truncated checksums.json", apply: (dir) => truncateSync(path.join(dir, "checksums.json"), 20), fields: ["checksums.json"] },
  { label: "a changed byte of export.json", apply: (dir) => flipByte(path.join(dir, "export.json")), fields: ["export.json"] },
  { label: "a missing export.json", apply: (dir) => rmSync(path.join(dir, "export.json")), fields: ["files"] },
  { label: "an extra file", apply: (dir) => writeFileSync(path.join(dir, "notes.txt"), "not part of a package"), fields: ["files"] },
  { label: "a link in place of export.json", apply: (dir) => { rmSync(path.join(dir, "export.json")); symlinkSync(path.join(dir, "app.db"), path.join(dir, "export.json")); }, fields: ["files"] },
  {
    label: "a database that is garbage under checksums that agree with it",
    apply: (dir) => {
      writeFileSync(path.join(dir, "app.db"), "this is not a database ".repeat(2000));
      const checksums = JSON.parse(readFileSync(path.join(dir, "checksums.json"), "utf8")) as { files: Record<string, string> };
      checksums.files["app.db"] = sha256(path.join(dir, "app.db"));
      writeFileSync(path.join(dir, "checksums.json"), JSON.stringify(checksums));
    },
    fields: [],
  },
];

describe("D51.2-AC1 every damaged part is refused with its name by every command and nothing is changed", () => {
  it("names the part in the catalog, in backup-verify and in restore-instance, changes neither the package nor the database, and the retention keeps all of them", async () => {
    const { setup } = await booksOverApi("d51-2");
    await stopServer(setup.server);
    expect((await run("backup-create", setup)).code).toBe(0);
    const [good] = packages(setup.instance);
    const folder = backupsDir(setup.instance);
    const damaged = DAMAGES.map((damage, index) => ({ ...damage, name: packageName(index + 1) }));
    for (const entry of damaged) {
      cpSync(good!, path.join(folder, entry.name), { recursive: true });
      entry.apply(path.join(folder, entry.name));
    }

    const databaseBefore = setOnDisk(setup);
    const listed = (outputEvent((await run("backup-list", setup)).output, "backup.listed") as { backups: Array<{ state: string; name: string; fields?: string[] }> }).backups;
    for (const entry of damaged) {
      const found = listed.find((each) => each.name === entry.name);
      expect(found?.state, entry.label).toBe("invalid");
      // The garbage database has no fixed name of a part, only that a part is named.
      if (entry.fields.length > 0) expect(found?.fields, entry.label).toEqual(entry.fields);
      else expect(found?.fields?.length, entry.label).toBeGreaterThan(0);
    }
    expect(listed.find((each) => each.name === path.basename(good!))?.state).toBe("completed");

    for (const entry of damaged) {
      const before = treeHash(path.join(folder, entry.name));
      const fields = listed.find((each) => each.name === entry.name)?.fields;
      const verify = await run("backup-verify", setup, { snapshot: entry.name });
      expect([verify.code, failureOf(verify.output, "backup-verify.failed")], entry.label).toMatchObject([1, { code: "SNAPSHOT_INVALID", fields }]);
      const restore = await run("restore-instance", setup, { snapshot: entry.name, confirm: "replace-current-database" });
      expect([restore.code, failureOf(restore.output, "restore-instance.failed")], entry.label).toMatchObject([1, { code: "SNAPSHOT_INVALID", fields }]);
      expect(treeHash(path.join(folder, entry.name)), entry.label).toBe(before);
    }
    expect(setOnDisk(setup)).toBe(databaseBefore);
    expect(readdirSync(path.join(setup.instance.dir, "data")).filter((file) => file.startsWith(".restore-parked-"))).toEqual([]);

    // A keep that would remove every ordinary copy touches none of the damaged ones, and the good one is the newest of its kind.
    const everyDirectory = readdirSync(folder).filter((file) => !file.startsWith(".")).sort();
    const pruned = pruneBackups(folder, setup.instance.instanceId, { nightlyKeep: 2, safetyKeepDays: 7, nowMs: Date.parse("2030-01-01T00:00:00Z"), inUse: new Set() });
    expect(pruned.ok && pruned.removed).toEqual([]);
    expect(readdirSync(folder).filter((file) => !file.startsWith(".")).sort()).toEqual(everyDirectory);
  });
});

describe("D51.2-AC2 a write lock held by another connection neither blocks nor leaks into a copy", () => {
  it("takes a copy that holds the committed state only and verifies, while the lock stays", async () => {
    const { setup } = await booksOverApi("d51-2b");
    await stopServer(setup.server);
    const holder = openDatabase(databaseFile(setup.instance), { role: "writer", busyTimeoutMs: 5000 });
    try {
      holder.handle.exec("CREATE TABLE IF NOT EXISTS drill_lock (v TEXT)");
      holder.handle.exec("BEGIN IMMEDIATE");
      holder.handle.exec("INSERT INTO drill_lock VALUES ('uncommitted')");
      const exit = await run("backup-create", setup);
      // In WAL the reader of the copy is never blocked by a writer: the copy is made at once.
      expect(exit.code, exit.output).toBe(0);
      const [dir] = packages(setup.instance);
      const verified = await run("backup-verify", setup, { snapshot: path.basename(dir!) });
      expect(verified.code, verified.output).toBe(0);
      const copy = openDatabase(path.join(dir!, "app.db"), { role: "reader", busyTimeoutMs: 5000, journal: "delete" });
      try {
        // The table was committed before the lock, the row is not: the copy holds the one and not the other.
        expect(copy.handle.prepare("SELECT count(*) AS n FROM drill_lock").get()).toEqual({ n: 0 });
      } finally {
        copy.close();
      }
      expect(holder.handle.prepare("SELECT count(*) AS n FROM drill_lock").get()).toEqual({ n: 1 });
    } finally {
      holder.handle.exec("ROLLBACK");
      holder.close();
    }
  });
});
