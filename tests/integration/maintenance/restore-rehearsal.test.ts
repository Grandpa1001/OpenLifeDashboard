// D50.3 — the rehearsal of the restore on a separate installation (Architektura §11.3.3 point 8; Scope S-restore).
// A new machine is the keys of the installation (`control/instance.json` and the environment file with the two
// secrets) and an empty data folder; the package is copied into its backup folder; the command restores it.
// AC1: the installation made from the package of F01's Książki holds the same data: the 25 records, the registry
//      revision and a canonical export equal to the export of the copy but for the time it was written; the
//      owner signs in on it with the password and the authenticator the source had, and a session of the source
//      is dead there. Nothing is parked, because there was nothing to park.
// AC2: a machine with the right keys but another instance file, or with the instance file and another key, is
//      refused and stays empty: no database appears.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXPORT_PATH } from "@openlife/contracts/http/export";
import { REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { canonicalExport } from "../../../apps/server/dist/portability/canonical.js";
import { parseExportFile } from "../../../apps/server/dist/portability/parse-export.js";
import { codeOf, query, send, serve, signIn, stopServer, stopServers, verify } from "../../support/auth-http.ts";
import { booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";
import { prepareTestInstance, type TestInstance } from "../../support/test-instance.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const run = (script: string, instance: TestInstance, input?: unknown) =>
  runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, input === undefined ? undefined : JSON.stringify(input));
const failure = (output: string) => outputEvent(output, "restore-instance.failed");

/** The machine a disaster recovery starts from: the keys of the source (instance file and secrets), no data. */
function newMachineWith(source: TestInstance, over: { secrets?: boolean; instanceFile?: boolean } = {}): TestInstance {
  const fresh = prepareTestInstance(mkdtempSync(path.join(tmpdir(), "restore-machine-")));
  const instanceFile = over.instanceFile === false ? fresh.instanceFile : path.join(source.dir, "control", "instance.json");
  const metadata = JSON.parse(readFileSync(instanceFile, "utf8")) as Record<string, unknown>;
  writeFileSync(fresh.instanceFile, `${JSON.stringify({ ...metadata, installationPath: fresh.dir }, null, 2)}\n`);
  const env = over.secrets === false ? fresh.env : { ...fresh.env, BETTER_AUTH_SECRET: source.env["BETTER_AUTH_SECRET"]!, APP_ENCRYPTION_KEY: source.env["APP_ENCRYPTION_KEY"]! };
  return { ...fresh, env, instanceId: over.instanceFile === false ? fresh.instanceId : source.instanceId };
}

async function sourceWithBundle(prefix: string) {
  const books = await booksOverApi(prefix);
  await stopServer(books.setup.server);
  expect((await run("backup-create", books.setup.instance)).code).toBe(0);
  const [dir] = packages(books.setup.instance);
  return { ...books, packageDir: dir!, name: path.basename(dir!) };
}

describe("D50.3-AC1 a separate installation restored from the package holds the data of the copy", () => {
  it("has the 25 records, an export equal to the copy's, lets the owner sign in with the old authenticator and ends a session of the source", async () => {
    const source = await sourceWithBundle("d50-3");
    const machine = newMachineWith(source.setup.instance);
    cpSync(source.packageDir, path.join(backupsDir(machine), source.name), { recursive: true });
    expect(existsSync(path.join(machine.dir, "data", "app.db"))).toBe(false);

    const verified = await run("backup-verify", machine, { snapshot: source.name });
    expect(outputEvent(verified.output, "backup.verified"), verified.output).toMatchObject({ sameInstallation: true, migrationNeeded: false });
    const exit = await run("restore-instance", machine, { snapshot: source.name, confirm: "replace-current-database" });
    expect(exit.code, exit.output).toBe(0);
    expect(outputEvent(exit.output, "instance.restored")).toMatchObject({ parked: null, revokedSessions: expect.any(Number) });

    const table = (instance: TestInstance) => query<{ name: string }>(instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1")[0]!.name;
    const counted = (instance: TestInstance) => query<{ n: number }>(instance, `SELECT count(*) AS n FROM "${table(instance)}"`)[0]!.n;
    expect(counted(machine)).toBe(25);
    expect(query(machine, "SELECT symbol, schema_revision FROM registry ORDER BY symbol")).toEqual(query(source.setup.instance, "SELECT symbol, schema_revision FROM registry ORDER BY symbol"));

    const server = await serve(machine);
    // A session of the source is dead here, the owner signs in again with the password and the authenticator he had.
    expect((await send(server, "GET", REGISTRIES_PATH, undefined, { cookie: source.cookie })).status).toBe(401);
    const login = await signIn(server);
    expect(login.status).toBe(200);
    const verifiedLogin = await verify(server, login.cookie, { code: await codeOf(source.owner.secret, 1) });
    expect(verifiedLogin.status, verifiedLogin.text).toBe(200);
    const cookie = verifiedLogin.cookie ?? login.cookie;

    const exported = await send(server, "GET", EXPORT_PATH, undefined, { cookie });
    expect(exported.status).toBe(200);
    const parse = (text: string) => {
      const result = parseExportFile(text, LIMITS);
      if (!result.ok) throw new Error(`not accepted: ${JSON.stringify(result.issues.slice(0, 3))}`);
      return canonicalExport({ ...result.file, exportedAt: "x", appVersion: "x" });
    };
    expect(parse(exported.text)).toBe(parse(readFileSync(path.join(source.packageDir, "export.json"), "utf8")));
    await stopServer(server);
  });
});

describe("D50.3-AC2 a machine without the right keys is refused and stays empty", () => {
  it("refuses another instance file and another encryption key and creates no database", async () => {
    const source = await sourceWithBundle("d50-3b");
    const wrongInstance = newMachineWith(source.setup.instance, { instanceFile: false });
    cpSync(source.packageDir, path.join(backupsDir(wrongInstance), source.name), { recursive: true });
    const refusedInstance = await run("restore-instance", wrongInstance, { snapshot: source.name, confirm: "replace-current-database" });
    expect([refusedInstance.code, failure(refusedInstance.output)]).toMatchObject([1, { code: "SNAPSHOT_UNSUITABLE", fields: ["instanceId"] }]);
    expect(existsSync(path.join(wrongInstance.dir, "data", "app.db"))).toBe(false);

    const wrongKey = newMachineWith(source.setup.instance, { secrets: false });
    cpSync(source.packageDir, path.join(backupsDir(wrongKey), source.name), { recursive: true });
    const refusedKey = await run("restore-instance", wrongKey, { snapshot: source.name, confirm: "replace-current-database" });
    expect([refusedKey.code, failure(refusedKey.output)]).toMatchObject([1, { code: "KEY_MISMATCH", fields: ["APP_ENCRYPTION_KEY"] }]);
    expect(existsSync(path.join(wrongKey.dir, "data", "app.db"))).toBe(false);
  });
});
