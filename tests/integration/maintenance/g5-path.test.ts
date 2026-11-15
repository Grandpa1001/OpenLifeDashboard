// Gate G5 path (DEV §8.4, §9.50): the whole way of a copy on two installations, by the built commands.
// A holds F01 (Książki with 25 records and the screen with its table widget bound). A stopped, its folder of the
// copies is listed, a bundle is made, listed and verified; B is a separate installation (the keys of A and an
// empty data folder). A damaged copy of the bundle is refused by B and changes nothing; the good bundle is
// restored: the count of the records, the revision of the registry and the bindings of the screen are those of
// F01 and of A, a session of A is dead on B, the owner signs in with the old authenticator, and the audit says
// the restore. The only copy A has survives a nightly look that cannot make a new one (no space) and a retention.
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { createNightlyBackupJob } from "../../../apps/server/dist/workers/nightly-backup.js";
import { listBackups } from "../../../apps/server/dist/adapters/filesystem/backup-catalog.js";
import { pruneBackups } from "../../../apps/server/dist/adapters/filesystem/backup-retention.js";
import { verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { codeOf, query, send, serve, signIn, stopServer, stopServers, verify } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";
import { prepareTestInstance, type TestInstance } from "../../support/test-instance.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const run = (script: string, instance: TestInstance, input?: unknown) =>
  runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, input === undefined ? undefined : JSON.stringify(input));
const count = (instance: TestInstance, sql: string): number => query<{ n: number }>(instance, sql)[0]!.n;
const recordTable = (instance: TestInstance): string => query<{ name: string }>(instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1")[0]!.name;

describe("G5-path a bundle of A is listed, verified, refused when damaged and restored on a separate installation B", () => {
  it("lists and verifies the bundle, refuses a damaged copy of it, restores the good one with the data of F01 and ends the sessions of A, and the sole copy of A survives a failed look and a retention", async () => {
    const a = await booksOverApi("g5");
    await stopServer(a.setup.server);
    const A = a.setup.instance;
    expect((await run("backup-create", A)).code).toBe(0);
    const [packageDir] = packages(A);
    const name = path.basename(packageDir!);

    // The list and the check of A.
    const listed = (outputEvent((await run("backup-list", A)).output, "backup.listed") as { backups: Array<{ state: string; scope?: string; reason?: string }> }).backups;
    expect(listed.map((entry) => [entry.state, entry.scope, entry.reason])).toEqual([["completed", "bundle", "manual"]]);
    expect(outputEvent((await run("backup-verify", A, { snapshot: name })).output, "backup.verified")).toMatchObject({ scope: "bundle", sameInstallation: true, migrationNeeded: false });

    // B: the keys of A and no data.
    const fresh = prepareTestInstance(mkdtempSync(path.join(tmpdir(), "g5-machine-")));
    writeFileSync(fresh.instanceFile, `${JSON.stringify({ ...(JSON.parse(readFileSync(A.instanceFile, "utf8")) as object), installationPath: fresh.dir }, null, 2)}\n`);
    const B: TestInstance = { ...fresh, instanceId: A.instanceId, env: { ...fresh.env, BETTER_AUTH_SECRET: A.env["BETTER_AUTH_SECRET"]!, APP_ENCRYPTION_KEY: A.env["APP_ENCRYPTION_KEY"]! } };

    // A damaged copy of the bundle (a changed byte of app.db, under the name of a package) is refused and changes nothing.
    const damagedName = name.replace(/^\d{8}T\d{6}Z/, "20260101T000000Z");
    cpSync(packageDir!, path.join(backupsDir(B), damagedName), { recursive: true });
    const damagedDb = path.join(backupsDir(B), damagedName, "app.db");
    const bytes = readFileSync(damagedDb);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)]! + 1) % 256;
    writeFileSync(damagedDb, bytes);
    const refused = await run("restore-instance", B, { snapshot: damagedName, confirm: "replace-current-database" });
    expect([refused.code, outputEvent(refused.output, "restore-instance.failed")]).toMatchObject([1, { code: "SNAPSHOT_INVALID", fields: ["app.db"] }]);
    expect(readdirSync(path.join(B.dir, "data")).filter((entry) => entry.startsWith("app.db") || entry.startsWith(".restore-parked-"))).toEqual([]);

    // The good bundle restores.
    cpSync(packageDir!, path.join(backupsDir(B), name), { recursive: true });
    const restored = await run("restore-instance", B, { snapshot: name, confirm: "replace-current-database" });
    expect(restored.code, restored.output).toBe(0);
    expect(count(B, `SELECT count(*) AS n FROM "${recordTable(B)}"`)).toBe(BOOKS.records.length);
    expect(count(B, `SELECT count(*) AS n FROM "${recordTable(B)}"`)).toBe(count(A, `SELECT count(*) AS n FROM "${recordTable(A)}"`));
    expect(query(B, "SELECT symbol, schema_revision FROM registry ORDER BY symbol")).toEqual(query(A, "SELECT symbol, schema_revision FROM registry ORDER BY symbol"));
    for (const table of ["screen", "widget", "binding"]) expect(count(B, `SELECT count(*) AS n FROM "${table}"`), table).toBe(count(A, `SELECT count(*) AS n FROM "${table}"`));
    expect(count(B, "SELECT count(*) AS n FROM binding")).toBeGreaterThan(0);
    expect(count(B, "SELECT count(*) AS n FROM audit_log WHERE action = 'backup.restored'")).toBe(1);

    // On B: a session of A is dead and the owner signs in with the password and the authenticator he had.
    const server = await serve(B);
    expect((await send(server, "GET", REGISTRIES_PATH, undefined, { cookie: a.cookie })).status).toBe(401);
    const login = await signIn(server);
    expect(login.status).toBe(200);
    expect((await verify(server, login.cookie, { code: await codeOf(a.owner.secret, 1) })).status).toBe(200);
    await stopServer(server);

    // The only copy of A survives a look that cannot make another (no space) and a retention that would remove everything ordinary.
    const log: Array<{ event: string; code?: string }> = [];
    const job = createNightlyBackupJob({
      snapshots: { create: async () => ({ ok: false, code: "SNAPSHOT_LOW_SPACE" }) },
      readCatalog: () => listBackups(backupsDir(A), A.instanceId),
      prune: (policy) => pruneBackups(backupsDir(A), A.instanceId, policy),
      timeZone: () => "Europe/Warsaw",
      settings: () => ({ enabled: true, time: "02:00", nightlyKeep: 2, safetyKeepDays: 7 }),
      nowMs: () => Date.parse("2030-01-01T12:00:00Z"),
      maintenanceActive: () => false,
      newOperationId: () => "g5-operation",
      logger: { log: (event: { event: string; code?: string }) => void log.push(event) },
    });
    expect(await job.run()).toBe("failed");
    expect(log).toEqual([{ level: "error", event: "backup.nightly_failed", operationId: "g5-operation", code: "SNAPSHOT_LOW_SPACE" }]);
    const pruned = pruneBackups(backupsDir(A), A.instanceId, { nightlyKeep: 2, safetyKeepDays: 7, nowMs: Date.parse("2030-01-01T12:00:00Z"), inUse: new Set() });
    expect(pruned.ok && pruned.removed).toEqual([]);
    expect(verifyDatabaseSnapshot(packageDir!).ok).toBe(true);
    expect(packages(A)).toHaveLength(1);
  });
});
