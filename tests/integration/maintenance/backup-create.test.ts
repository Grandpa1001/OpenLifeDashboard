// D48.2 — the command backup-create (Scope §5.6; Architektura §11.3, §11.4), on a real installation: Książki of
// F01 made through the API of the built server, the server stopped, the built command run.
// AC1: the command publishes one package of scope bundle with the reason manual; it verifies, its export.json
//      is accepted by the parser and holds the 25 records and the table widget, its app.db holds the same 25
//      rows; the live database is not changed (no audit entry, same rows); the output names the package and
//      its size and no value of the data; a second run makes a second package.
// AC2: a running server is INSTANCE_BUSY and an unknown argument is USAGE; each leaves no package and
//      no staging.
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundleSnapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { parseExportFile } from "../../../apps/server/dist/portability/parse-export.js";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { query, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages, stagingEntries } from "../../support/database-fixtures.ts";
import { closeWriters } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const BACKUP = path.join(repoRoot, "apps/server/dist/cli/backup-create.js");
const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const backup = (setup: Installation, args: readonly string[] = []) => runBuiltScript(BACKUP, ["--installation", setup.instance.dir, ...args], processEnv(setup));
const failure = (output: string) => outputEvent(output, "backup-create.failed");
const live = (setup: Installation) => JSON.stringify([query(setup.instance, "SELECT * FROM reg_ksiazki ORDER BY id"), query(setup.instance, "SELECT action FROM audit_log ORDER BY rowid")]);

describe("D48.2-AC1 the command takes a bundle of the whole installation", () => {
  it("publishes a verified bundle with the reason manual that holds the same 25 records in export.json and app.db, and leaves the live database as it was", async () => {
    const { setup } = await booksOverApi("d48-2");
    await stopServer(setup.server);
    const before = live(setup);

    const exit = await backup(setup);
    expect(exit.code, exit.output).toBe(0);
    const [pkg] = packages(setup.instance);
    expect(packages(setup.instance)).toHaveLength(1);
    expect(stagingEntries(setup.instance)).toEqual([]);
    const event = outputEvent(exit.output, "backup.created");
    expect(event).toMatchObject({ scope: "bundle", reason: "manual", directory: path.basename(pkg!) });
    expect(event?.["bytes"]).toBeGreaterThan(0);

    expect(verifyDatabaseSnapshot(pkg!).ok).toBe(true);
    const meta = bundleSnapshotMetaSchema.parse(JSON.parse(readFileSync(path.join(pkg!, "meta.json"), "utf8")));
    expect([meta.scope, meta.reason, meta.snapshotId]).toEqual(["bundle", "manual", event?.["snapshotId"]]);
    const parsed = parseExportFile(readFileSync(path.join(pkg!, "export.json"), "utf8"), LIMITS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const registry = parsed.file.registries.find((candidate) => candidate.symbol === BOOKS.symbol);
    expect(registry?.records).toHaveLength(25);
    expect(parsed.file.screens.flatMap((screen) => screen.widgets).some((widget) => widget.type === "register-table")).toBe(true);
    const copy = openDatabase(path.join(pkg!, "app.db"), { role: "reader", busyTimeoutMs: 5000, journal: "delete" });
    try {
      expect((copy.handle.prepare("SELECT COUNT(*) AS n FROM reg_ksiazki").get() as { n: number }).n).toBe(25);
    } finally {
      copy.close();
    }
    // The output holds no title of a record.
    expect(exit.output).not.toContain("Książka testowa");
    expect(live(setup)).toBe(before);

    expect((await backup(setup)).code).toBe(0);
    expect(packages(setup.instance)).toHaveLength(2);
  });
});

describe("D48.2-AC2 what the command refuses", () => {
  it("a running server and an unknown argument leave no package and no staging", async () => {
    const { setup } = await booksOverApi("d48-2b");
    await stopServer(setup.server);
    const server = await serve(setup.instance);
    const busy = await backup(setup);
    expect([busy.code, failure(busy.output)]).toEqual([1, { event: "backup-create.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] }]);
    await stopServer(server);
    expect(failure((await backup(setup, ["--unknown"])).output)).toMatchObject({ code: "USAGE" });
    expect(packages(setup.instance)).toEqual([]);
    expect(stagingEntries(setup.instance)).toEqual([]);
    expect(backupsDir(setup.instance)).toContain("backup");
  });
});
