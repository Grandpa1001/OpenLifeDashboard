// D50.1 — the built command backup-verify on a real installation (Architektura §11.3.3 point 1).
// AC1: a bundle made by backup-create is verified in full and reported with its scope, reason, schema version
//      and app version, as restorable by this build without a migration and of this installation; the command
//      only reads, so it changes nothing in the folder and runs beside a running server.
// AC2: a changed byte of export.json, a package that lost files, a name that is not a package and a path in place
//      of a name are refused with the part named; the damaged package stays on disk untouched.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const run = (script: string, setup: Installation, input?: unknown) => runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", setup.instance.dir], processEnv(setup), input === undefined ? undefined : JSON.stringify(input));
const verify = (setup: Installation, snapshot: string) => run("backup-verify", setup, { snapshot });
const failure = (output: string) => outputEvent(output, "backup-verify.failed");
const tree = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort().map((entry) => `${entry}:${statSync(path.join(dir, entry)).isFile() ? statSync(path.join(dir, entry)).size : "dir"}`);

async function withBundle(prefix: string) {
  const { setup } = await booksOverApi(prefix);
  await stopServer(setup.server);
  expect((await run("backup-create", setup)).code).toBe(0);
  return setup;
}

describe("D50.1-AC1 a copy is verified in full and read against this build", () => {
  it("reports the bundle as restorable without a migration and of this installation, changes nothing and works beside a running server", async () => {
    const setup = await withBundle("d50-1");
    const [dir] = packages(setup.instance);
    const name = path.basename(dir!);
    const before = tree(backupsDir(setup.instance));
    const exit = await verify(setup, name);
    expect(exit.code, exit.output).toBe(0);
    expect(outputEvent(exit.output, "backup.verified")).toMatchObject({ snapshot: name, scope: "bundle", reason: "manual", sameInstallation: true, migrationNeeded: false });
    expect(typeof outputEvent(exit.output, "backup.verified")?.["schemaVersion"]).toBe("number");
    expect(tree(backupsDir(setup.instance))).toEqual(before);

    const server = await serve(setup.instance);
    expect(outputEvent((await verify(setup, name)).output, "backup.verified")).toMatchObject({ snapshot: name });
    await stopServer(server);
  });
});

describe("D50.1-AC2 a damaged or unknown copy is refused with the part named", () => {
  it("refuses a changed byte of export.json, a package without its files, an unknown name and a path, and leaves the damaged package on disk", async () => {
    const setup = await withBundle("d50-1b");
    const [dir] = packages(setup.instance);
    const name = path.basename(dir!);
    const partial = "20260101T000000Z-manual-00000000-0000-4000-8000-000000000000";
    mkdirSync(path.join(backupsDir(setup.instance), partial));
    cpSync(path.join(dir!, "app.db"), path.join(backupsDir(setup.instance), partial, "app.db"));
    expect(failure((await verify(setup, partial)).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: ["files"] });
    expect(failure((await verify(setup, "20260102T000000Z-manual-00000000-0000-4000-8000-000000000001")).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: ["directory"] });
    expect(failure((await verify(setup, "../app.db")).output)).toMatchObject({ code: "INPUT_INVALID" });
    expect(failure((await run("backup-verify", setup, {})).output)).toMatchObject({ code: "INPUT_INVALID" });

    const exportFile = path.join(dir!, "export.json");
    writeFileSync(exportFile, readFileSync(exportFile, "utf8").replace("Książki", "Ksiązki"));
    const before = tree(backupsDir(setup.instance));
    const exit = await verify(setup, name);
    expect([exit.code, failure(exit.output)]).toMatchObject([1, { code: "SNAPSHOT_INVALID", fields: ["export.json"] }]);
    expect(tree(backupsDir(setup.instance))).toEqual(before);
    expect(readdirSync(dir!).sort()).toEqual(["app.db", "checksums.json", "export.json", "meta.json"]);
  });
});
