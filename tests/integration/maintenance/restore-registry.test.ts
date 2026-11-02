// D30.2 — restoring one deleted registry from its copy pre_delete with the command restore-registry
// (Scope §5.6, S10; Architektura §5.2, §11.3.3), on a real installation: Książki of F01 and its table
// widget made through the API of the built server, deleted through the API (D30.1), then restored by the
// built command while the server is stopped.
// AC1: the registry, its columns and its 25 records come back under the same identifiers with their
//      times and revisions, the table and its indexes as a new registry has them, at schema revision 3;
//      the other registry, the screens and the sign-in data are untouched; started again, the server
//      lists Książki, serves its records and the table widget is ok; the audit has no values.
// AC2: a running server is INSTANCE_BUSY; a bad or unknown name, a damaged package, a copy of another
//      installation or of another reason are refused; a registry not deleted, a symbol the copy does not
//      have and a failure after the table or after the catalog change nothing.
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATABASE_SNAPSHOT_FILES } from "@openlife/contracts/backups/database-snapshot";
import { recordPageSchema, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema, structurePath, structurePreviewPath, structurePreviewSchema } from "@openlife/contracts/http/registries";
import { screenPath, screenSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { restoreRegistry, type RegistryTables } from "../../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindRegistryStore, bindRegistryTables, openRegistryCopy } from "../../../packages/sqlite/dist/adapters/registries/public.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { post, query, send, serve, stopServer, stopServers, type Installation } from "../../support/auth-http.ts";
import { BOOKS, booksOverApi } from "../../support/books-http.ts";
import { backupsDir, packages } from "../../support/database-fixtures.ts";
import { closeWriters, writerOf } from "../../support/rebuild-writer.ts";
import { outputEvent, repoRoot, runBuiltScript } from "../../support/server-process.ts";

afterEach(async () => {
  closeWriters();
  await stopServers();
});

const RESTORE = path.join(repoRoot, "apps/server/dist/cli/restore-registry.js");
const processEnv = (setup: Installation) => ({ PATH: process.env["PATH"] ?? "", ...setup.instance.env });
const restore = (setup: Installation, input: unknown) => runBuiltScript(RESTORE, ["--installation", setup.instance.dir], processEnv(setup), JSON.stringify(input));
const failure = (output: string) => outputEvent(output, "restore-registry.failed");

/** Everything of the installation a restore must not touch, and everything of Książki it must bring back. */
const others = (setup: Installation) =>
  JSON.stringify([query(setup.instance, "SELECT * FROM registry WHERE symbol <> 'ksiazki'"), query(setup.instance, "SELECT * FROM reg_waga ORDER BY id"), query(setup.instance, "SELECT * FROM screen"), query(setup.instance, "SELECT * FROM widget"), query(setup.instance, "SELECT * FROM binding ORDER BY 1"), query(setup.instance, 'SELECT * FROM "user"'), query(setup.instance, "SELECT * FROM account"), query(setup.instance, "SELECT * FROM session")]);
const books = (setup: Installation) =>
  JSON.stringify([
    query(setup.instance, "SELECT id, user_id, symbol, display_name, table_name, created_at FROM registry WHERE symbol = 'ksiazki'"),
    query(setup.instance, "SELECT c.* FROM registry_column c JOIN registry r ON r.id = c.registry_id WHERE r.symbol = 'ksiazki' ORDER BY c.position"),
    query(setup.instance, "SELECT * FROM reg_ksiazki ORDER BY id"),
    query(setup.instance, "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'reg_ksiazki' ORDER BY name"),
  ]);
const everything = (setup: Installation) => JSON.stringify([others(setup), query(setup.instance, "SELECT * FROM registry"), query(setup.instance, "SELECT * FROM registry_column"), query(setup.instance, "SELECT sql FROM sqlite_master ORDER BY name"), query(setup.instance, "SELECT action FROM audit_log ORDER BY rowid")]);

/** Książki of F01 with its widget and a second registry, then Książki deleted through the API (S10); the server is stopped. */
async function deleted(keyPrefix: string) {
  const { setup, cookie, screenId } = await booksOverApi(keyPrefix);
  expect((await post(setup.server, REGISTRIES_PATH, { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: {}, defaultValue: null, required: false }] }, { cookie })).status).toBe(201);
  const before = books(setup);
  const preview = structurePreviewSchema.parse((await send(setup.server, "POST", structurePreviewPath(BOOKS.symbol), { change: { kind: "deleteRegistry" } }, { cookie })).json());
  expect((await send(setup.server, "POST", structurePath(BOOKS.symbol), { change: { kind: "deleteRegistry" }, planToken: preview.planToken }, { cookie })).status).toBe(200);
  await stopServer(setup.server);
  const [pkg] = packages(setup.instance);
  return { setup, cookie, screenId, before, pkg: pkg!, snapshot: path.basename(pkg!) };
}

describe("D30.2-AC1 Książki comes back from its copy pre_delete under the same identifiers", () => {
  it("the registry, its columns and its 25 records as they were, revision 3, nothing else touched; the server lists it again and the widget is ok", async () => {
    const { setup, cookie, screenId, before, snapshot } = await deleted("d30-2");
    const untouched = others(setup);

    const exit = await restore(setup, { snapshot, symbol: BOOKS.symbol });
    expect(exit.code, exit.output).toBe(0);
    const event = outputEvent(exit.output, "registry.restored");
    expect(event).toMatchObject({ symbol: BOOKS.symbol, schemaRevision: 3, records: 25 });
    expect(books(setup)).toBe(before);
    expect(query(setup.instance, "SELECT schema_revision, deleted_at FROM registry WHERE symbol = 'ksiazki'")).toEqual([{ schema_revision: 3, deleted_at: null }]);
    expect(others(setup)).toBe(untouched);
    const audit = query<{ details: string }>(setup.instance, "SELECT details FROM audit_log WHERE action = 'registry.restored'");
    expect(audit.map((row) => JSON.parse(row.details))).toEqual([{ registry: BOOKS.symbol, records: 25, columns: BOOKS.columns.length, snapshot: event!["snapshotId"] }]);

    // The session of the owner outlives the restart: the restore touched no sign-in data.
    const server = await serve(setup.instance);
    expect(registryListSchema.parse((await send(server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries.map((registry) => registry.symbol).sort()).toEqual(["ksiazki", "waga"]);
    expect(recordPageSchema.parse((await send(server, "GET", registryRecordsPath(BOOKS.symbol), undefined, { cookie })).json()).total).toBe(25);
    const screen = screenSchema.parse((await send(server, "GET", screenPath(screenId), undefined, { cookie })).json());
    expect(screen.widgets.find((widget) => widget.type === "register-table")?.state).toBe("ok");
  });
});

describe("D30.2-AC2 what a restore refuses", () => {
  it("a running server, a bad or unknown name, a damaged package, another installation's copy and a copy of another reason change nothing", async () => {
    const { setup, pkg, snapshot } = await deleted("d30-2-refused");
    const state = everything(setup);

    const server = await serve(setup.instance);
    const busy = await restore(setup, { snapshot, symbol: BOOKS.symbol });
    expect([busy.code, failure(busy.output)]).toEqual([1, { event: "restore-registry.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] }]);
    await stopServer(server);

    expect(failure((await restore(setup, { snapshot: "../app.db", symbol: BOOKS.symbol })).output)).toMatchObject({ code: "INPUT_INVALID" });
    expect(failure((await restore(setup, { snapshot: `20260101T000000Z-pre_delete-${randomUUID()}`, symbol: BOOKS.symbol })).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: ["directory"] });

    // A changed meta no longer matches its checksum.
    const meta = path.join(pkg, DATABASE_SNAPSHOT_FILES.meta);
    const original = readFileSync(meta, "utf8");
    writeFileSync(meta, original.replace('"pre_delete"', '"pre_update"'));
    expect(failure((await restore(setup, { snapshot, symbol: BOOKS.symbol })).output)).toMatchObject({ code: "SNAPSHOT_INVALID", fields: [DATABASE_SNAPSHOT_FILES.meta] });
    writeFileSync(meta, original);

    // A consistent package of another installation, and one of another reason (both with valid checksums).
    const forged = (name: string, change: (meta: Record<string, unknown>, db: SqliteConnection) => void): string => {
      const dir = path.join(backupsDir(setup.instance), name);
      cpSync(pkg, dir, { recursive: true });
      const db = openDatabase(path.join(dir, DATABASE_SNAPSHOT_FILES.database), { role: "writer", busyTimeoutMs: 5000 });
      const parsed = JSON.parse(original) as Record<string, unknown>;
      change(parsed, db);
      // Back to the one standalone file a package holds.
      db.handle.pragma("journal_mode = DELETE");
      db.close();
      parsed["databaseBytes"] = statSync(path.join(dir, DATABASE_SNAPSHOT_FILES.database)).size;
      writeFileSync(path.join(dir, DATABASE_SNAPSHOT_FILES.meta), `${JSON.stringify(parsed, null, 2)}\n`);
      const sum = (file: string) => createHash("sha256").update(readFileSync(path.join(dir, file))).digest("hex");
      writeFileSync(path.join(dir, DATABASE_SNAPSHOT_FILES.checksums), `${JSON.stringify({ algorithm: "sha256", files: { [DATABASE_SNAPSHOT_FILES.database]: sum(DATABASE_SNAPSHOT_FILES.database), [DATABASE_SNAPSHOT_FILES.meta]: sum(DATABASE_SNAPSHOT_FILES.meta) } }, null, 2)}\n`);
      return name;
    };
    const elsewhere = randomUUID();
    const foreign = forged(`20260101T000001Z-pre_delete-${randomUUID()}`, (parsed, db) => {
      db.handle.prepare("UPDATE instance SET instance_id = ?").run(elsewhere);
      parsed["instanceId"] = elsewhere;
    });
    expect(failure((await restore(setup, { snapshot: foreign, symbol: BOOKS.symbol })).output)).toMatchObject({ code: "SNAPSHOT_UNSUITABLE", fields: ["instanceId"] });
    const typeChange = forged(`20260101T000002Z-pre_type_change-${randomUUID()}`, (parsed) => {
      parsed["reason"] = "pre_type_change";
    });
    expect(failure((await restore(setup, { snapshot: typeChange, symbol: BOOKS.symbol })).output)).toMatchObject({ code: "SNAPSHOT_UNSUITABLE", fields: ["reason"] });
    expect(everything(setup)).toBe(state);
  });

  it("a registry not deleted or restored already, a symbol the copy does not have and a failure after the table or after the catalog change nothing", async () => {
    const { setup, pkg, snapshot } = await deleted("d30-2-conflict");
    expect(failure((await restore(setup, { snapshot, symbol: "nieznany" })).output)).toMatchObject({ code: "RESTORE_CONFLICT", fields: ["symbol"] });
    // waga is in the copy too, but it was never deleted: a restore would overwrite it.
    expect(failure((await restore(setup, { snapshot, symbol: "waga" })).output)).toMatchObject({ code: "RESTORE_CONFLICT", fields: ["deletedAt"] });

    // A failure after each stage of the unit takes the whole restore back.
    const before = everything(setup);
    const writer = writerOf(setup);
    /** One attempt of the unit with a stage made to fail; the message of what it threw. */
    const attempt = (wrap: Readonly<{ tables?: (inner: RegistryTables) => RegistryTables; afterCatalog?: boolean }>): string => {
      const copy = openRegistryCopy(path.join(pkg, DATABASE_SNAPSHOT_FILES.database), BOOKS.symbol);
      try {
        const unit = createUnitOfWork(writer.connection, (tx) => {
          const registries = bindRegistryStore(tx);
          const failing = { ...registries, markRestored: (...args: Parameters<typeof registries.markRestored>) => (registries.markRestored(...args), (() => { throw new Error("failed after the catalog"); })()) };
          return { registries: wrap.afterCatalog ? failing : registries, tables: (wrap.tables ?? ((inner) => inner))(bindRegistryTables(tx)), audit: bindAppendAudit(tx) };
        });
        unit.run((ports) => restoreRegistry(ports, { copy: { registry: copy.registry!, pages: copy.pages() }, snapshotId: randomUUID(), nowIso: new Date().toISOString(), requestId: "req-d30-2" }));
        return "no failure";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        copy.close();
      }
    };
    expect(attempt({ tables: (inner) => ({ ...inner, restore: (...args) => (inner.restore(...args), (() => { throw new Error("failed after the table"); })()) }) })).toBe("failed after the table");
    expect(attempt({ afterCatalog: true })).toBe("failed after the catalog");
    closeWriters();
    expect(everything(setup)).toBe(before);

    const restored = await restore(setup, { snapshot, symbol: BOOKS.symbol });
    expect(restored.code, restored.output).toBe(0);
    const state = everything(setup);
    expect(failure((await restore(setup, { snapshot, symbol: BOOKS.symbol })).output)).toMatchObject({ code: "RESTORE_CONFLICT", fields: ["deletedAt"] });
    expect(everything(setup)).toBe(state);
  });
});
