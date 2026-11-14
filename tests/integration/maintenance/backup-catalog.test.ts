// D48.3 — the catalog of the backup folder (Architektura §11.4), on a real installation with two bundles made by
// the built command backup-create and read by the built command backup-list.
// AC1: the catalog lists both bundles as completed with scope, reason, size and the schema version; a directory
//      that holds only app.db and a working directory left in staging are not completed (invalid with the
//      part named, incomplete); the listing changes nothing in the folder and works beside a running server.
// AC2: a damaged package (a changed byte of export.json) is shown as invalid with export.json and stays on disk
//      untouched; a package of another installation is a completed copy that is not of this installation.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../../../apps/server/dist/adapters/filesystem/backup-catalog.js";
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
const run = (script: string, setup: Installation) => runBuiltScript(path.join(repoRoot, `apps/server/dist/cli/${script}.js`), ["--installation", setup.instance.dir], processEnv(setup));
type Listed = { state: string; name: string; scope?: string; reason?: string; bytes?: number; fields?: string[]; schemaVersion?: number; ofThisInstallation?: boolean };
const listed = async (setup: Installation): Promise<Listed[]> => {
  const exit = await run("backup-list", setup);
  expect(exit.code, exit.output).toBe(0);
  return (outputEvent(exit.output, "backup.listed") as { backups: Listed[] }).backups;
};
/** Every file of the folder with its size: what a read-only command must leave as it found it. */
const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true }).map(String).sort().map((entry) => `${entry}:${statSync(path.join(dir, entry)).isFile() ? statSync(path.join(dir, entry)).size : "dir"}`);

async function withTwoBundles(prefix: string) {
  const { setup } = await booksOverApi(prefix);
  await stopServer(setup.server);
  expect((await run("backup-create", setup)).code).toBe(0);
  expect((await run("backup-create", setup)).code).toBe(0);
  return setup;
}

describe("D48.3-AC1 only a verified published package is completed", () => {
  it("lists both bundles as completed, a directory with only app.db as invalid and a leftover of staging as incomplete, and changes nothing", async () => {
    const setup = await withTwoBundles("d48-3");
    const [first] = packages(setup.instance);
    const folder = backupsDir(setup.instance);
    const completed = await listed(setup);
    expect(completed.map((entry) => [entry.state, entry.scope, entry.reason])).toEqual([["completed", "bundle", "manual"], ["completed", "bundle", "manual"]]);
    expect(completed.every((entry) => (entry.bytes ?? 0) > 0 && (entry.schemaVersion ?? 0) > 0 && entry.ofThisInstallation === true)).toBe(true);

    // A package that lost its files, and the working directory of a copy that never finished.
    const partial = path.join(folder, "20260101T000000Z-manual-00000000-0000-4000-8000-000000000000");
    mkdirSync(partial);
    cpSync(path.join(first!, "app.db"), path.join(partial, "app.db"));
    mkdirSync(path.join(folder, ".staging", "20260102T000000Z-manual-half"), { recursive: true });
    writeFileSync(path.join(folder, ".staging", "20260102T000000Z-manual-half", "app.db"), "half");
    const before = tree(folder);
    const entries = await listed(setup);
    expect(entries.map((entry) => entry.state)).toEqual(["invalid", "completed", "completed", "incomplete"]);
    expect(entries[0]).toMatchObject({ name: path.basename(partial), fields: ["files"] });
    expect(entries[3]).toMatchObject({ name: "20260102T000000Z-manual-half" });
    expect(tree(folder)).toEqual(before);

    // The listing only reads: it runs beside a running server and agrees.
    const server = await serve(setup.instance);
    expect(await listed(setup)).toEqual(entries);
    await stopServer(server);
  });
});

describe("D48.3-AC2 a damaged package is shown and kept, another installation's is not this one's", () => {
  it("shows the changed byte of export.json as invalid and leaves the package on disk; a copy of another installation is completed but not of this one", async () => {
    const setup = await withTwoBundles("d48-3b");
    const [first, second] = packages(setup.instance);
    const exportFile = path.join(first!, "export.json");
    writeFileSync(exportFile, readFileSync(exportFile, "utf8").replace("Książki", "Ksiązki"));
    const entries = await listed(setup);
    expect(entries.map((entry) => [entry.state, entry.fields ?? null])).toEqual([["invalid", ["export.json"]], ["completed", null]]);
    expect(readdirSync(first!).sort()).toEqual(["app.db", "checksums.json", "export.json", "meta.json"]);
    rmSync(first!, { recursive: true });

    const elsewhere = listBackups(backupsDir(setup.instance), "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a");
    expect(elsewhere.map((entry) => [entry.state, entry.state === "completed" ? entry.ofThisInstallation : null])).toEqual([["completed", false]]);
    expect(path.basename(second!)).toBe(elsewhere[0]!.name);
  });
});
