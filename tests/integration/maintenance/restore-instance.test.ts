// D50.2 — the built command restore-instance on real installations (Architektura §11.3.3 points 2 to 7).
// AC1: a bundle taken at 25 records restores a database that later held 26: the data is the copy's, the set
//      app.db (and its companions) the restore replaced is parked whole beside it, every session of the past is
//      ended and the access epoch is raised (the old cookie gets 401), the audit has `backup.restored`, the
//      journal outside the database says restored, and the app starts on the restored database.
// AC2: nothing changes the current database when the app runs (INSTANCE_BUSY), the confirmation is missing, the
//      package is damaged or unknown or of another installation, the key is not the one that sealed the copy,
//      or the file placement fails (the parked set goes back and no parked folder is left).
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { registryRecordsPath, IDEMPOTENCY_KEY_HEADER } from "@openlife/contracts/http/records";
import { afterEach, describe, expect, it } from "vitest";
import { post, query, send, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const processEnv = (setup: Installation, extra: Record<string, string> = {}) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env, ...extra });
const run = (script: string, setup: Installation, input?: unknown, extra: Record<string, string> = {}) =>
  runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", setup.instance.dir], processEnv(setup, extra), input === undefined ? undefined : JSON.stringify(input));
const restore = (setup: Installation, snapshot: string, extra: Record<string, string> = {}, input: Record<string, unknown> = { snapshot, confirm: "replace-current-database" }) => run("restore-instance", setup, input, extra);
const failure = (output: string) => outputEvent(output, "restore-instance.failed");
const dataDir = (setup: Installation) => path.join(setup.instance.dir, "data");
/** The database set as it lies on disk: what a refused restore must leave as it found it. */
const setOnDisk = (setup: Installation): string =>
  ["app.db", "app.db-wal", "app.db-shm"].map((file) => (existsSync(path.join(dataDir(setup), file)) ? `${file}:${createHash("sha256").update(readFileSync(path.join(dataDir(setup), file))).digest("hex")}` : `${file}:absent`)).join("|");
const parkedFolders = (setup: Installation): string[] => readdirSync(dataDir(setup)).filter((entry) => entry.startsWith(".restore-parked-"));
const recordCount = (setup: Installation): number => {
  const table = query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1")[0]!.name;
  return query<{ n: number }>(setup.instance, `SELECT count(*) AS n FROM "${table}"`)[0]!.n;
};

/** Książki with 25 records, a bundle of that state, and one record more afterwards. */
async function withBundleAndALaterRecord(prefix: string) {
  const { setup, cookie } = await booksOverApi(prefix);
  await stopServer(setup.server);
  expect((await run("backup-create", setup)).code).toBe(0);
  const server = await serve(setup.instance);
  const added = await post(server, registryRecordsPath(BOOKS.symbol), { schemaRevision: 1, values: BOOKS.records[0]!.values }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `${prefix}-later` } });
  expect(added.status).toBe(201);
  await stopServer(server);
  expect(recordCount(setup)).toBe(26);
  const [dir] = packages(setup.instance);
  return { setup, cookie, name: path.basename(dir!) };
}

describe("D50.2-AC1 the instance is restored from a verified copy and the access of the past ends", () => {
  it("brings back the 25 records, parks the replaced set whole, ends the old session, writes the audit and the journal and starts", async () => {
    const { setup, cookie, name } = await withBundleAndALaterRecord("d50-2");
    const exit = await restore(setup, name);
    expect(exit.code, exit.output).toBe(0);
    const event = outputEvent(exit.output, "instance.restored");
    expect(event).toMatchObject({ snapshot: name, revokedSessions: expect.any(Number) });
    expect(Number(event?.["revokedSessions"])).toBeGreaterThanOrEqual(1);

    expect(recordCount(setup)).toBe(25);
    const parked = parkedFolders(setup);
    expect(parked).toEqual([`.restore-parked-${String(event?.["parked"]).replace(/^\.restore-parked-/, "")}`]);
    expect(existsSync(path.join(dataDir(setup), parked[0]!, "app.db"))).toBe(true);
    expect(query<{ action: string }>(setup.instance, "SELECT action FROM audit_log WHERE action = 'backup.restored'")).toHaveLength(1);
    const journal = JSON.parse(readFileSync(path.join(setup.instance.dir, "control", "maintenance", "restore-journal.json"), "utf8")) as { state: string; snapshot: string };
    expect(journal).toMatchObject({ state: "restored", snapshot: name });

    const server = await serve(setup.instance);
    expect((await send(server, "GET", REGISTRIES_PATH, undefined, { cookie })).status).toBe(401);
    await stopServer(server);
  });
});

describe("D50.2-AC2 a refused or failed restore leaves the current database as it was", () => {
  it("refuses while the app runs, without the confirmation, for a damaged, unknown or foreign package and for another key", async () => {
    const { setup, name } = await withBundleAndALaterRecord("d50-2b");

    const running = await serve(setup.instance);
    expect(failure((await restore(setup, name)).output)).toMatchObject({ code: "INSTANCE_BUSY" });
    await stopServer(running);
    // After the run of the server: it leaves its WAL companions as a clean stop does, and that is the state to keep.
    const before = setOnDisk(setup);

    expect(failure((await restore(setup, name, {}, { snapshot: name })).output)).toMatchObject({ code: "INPUT_INVALID" });
    expect(failure((await restore(setup, "20260102T000000Z-manual-00000000-0000-4000-8000-000000000001")).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: ["directory"] });
    expect(failure((await restore(setup, name, { APP_ENCRYPTION_KEY: randomBytes(32).toString("hex") })).output)).toMatchObject({ code: "KEY_MISMATCH", fields: ["APP_ENCRYPTION_KEY"] });

    const foreign = await booksOverApi("d50-2c");
    await stopServer(foreign.setup.server);
    expect((await run("backup-create", foreign.setup)).code).toBe(0);
    const [foreignDir] = packages(foreign.setup.instance);
    cpSync(foreignDir!, path.join(backupsDir(setup.instance), path.basename(foreignDir!)), { recursive: true });
    expect(failure((await restore(setup, path.basename(foreignDir!))).output)).toMatchObject({ code: "SNAPSHOT_UNSUITABLE", fields: ["instanceId"] });

    const [dir] = packages(setup.instance);
    const exportFile = path.join(dir!, "export.json");
    writeFileSync(exportFile, readFileSync(exportFile, "utf8").replace("Książki", "Ksiązki"));
    expect(failure((await restore(setup, name)).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: ["export.json"] });

    expect(setOnDisk(setup)).toBe(before);
    expect(parkedFolders(setup)).toEqual([]);
    expect(recordCount(setup)).toBe(26);
  });

  it("moves the parked set back and leaves no parked folder when the placement of the copy fails", async () => {
    const { setup, name } = await withBundleAndALaterRecord("d50-2d");
    const before = setOnDisk(setup);
    // The place the temporary copy goes to is a directory: the copy cannot be written there.
    mkdirSync(path.join(dataDir(setup), "app.db.restoring"));
    const exit = await restore(setup, name);
    expect([exit.code, failure(exit.output)]).toMatchObject([1, { code: "RESTORE_PLACE_FAILED" }]);
    expect(setOnDisk(setup)).toBe(before);
    expect(parkedFolders(setup)).toEqual([]);
    expect(existsSync(path.join(dataDir(setup), "app.db.restoring"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(setup.instance.dir, "control", "maintenance", "restore-journal.json"), "utf8"))).toMatchObject({ state: "failed", code: "RESTORE_PLACE_FAILED" });
    expect(recordCount(setup)).toBe(26);
  });
});
