// D09.1-AC3 — the auth tables are checked against the adapter before the server is ready
// (Architektura §9.8). A new installation gets them from the migration plan and starts; a
// missing column, index or table, or a column of another type, stops the real start with exit 1
// and AUTH_SCHEMA_INCOMPATIBLE naming the difference, before listening, and nothing repairs the
// schema: no auto-migrator of the library runs, the database file stays as it was.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkAuthSchema } from "../../../apps/server/dist/adapters/auth/auth-schema.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { outputEvent, runServerEntry, startedInstallation } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const AUTH_TABLES = ["account", "session", "user", "verification"];

const databaseFile = (instance: TestInstance): string => path.join(instance.dir, "data", "app.db");
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function withWriter<T>(instance: TestInstance, use: (handle: ReturnType<typeof openDatabase>["handle"]) => T): T {
  const writer = openDatabase(databaseFile(instance), { role: "writer", busyTimeoutMs: 5000 });
  try {
    return use(writer.handle);
  } finally {
    writer.close();
  }
}

const schemaOf = (instance: TestInstance): unknown => withWriter(instance, (handle) => handle.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all());

describe("D09.1-AC3 the auth schema decides readiness", () => {
  it("a new installation has the auth tables of the migration plan and starts", async () => {
    const instance = await startedInstallation();
    const tables = withWriter(instance, (handle) => handle.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck().all());
    expect(tables).toEqual(expect.arrayContaining(AUTH_TABLES));
    expect(withWriter(instance, (handle) => checkAuthSchema({ role: "writer", handle, close: () => undefined }))).toEqual({ ok: true });
  });

  const differences: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["a missing column", `ALTER TABLE session DROP COLUMN "ipAddress";`, ["session.ipAddress"]],
    ["a missing index", `DROP INDEX "session_userId_idx";`, ["session.userId"]],
    ["a missing table", `DROP TABLE verification;`, ["verification"]],
    [
      "a column of another type",
      `DROP TABLE verification;
       CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" text not null, "createdAt" date not null, "updatedAt" date not null);
       CREATE INDEX "verification_identifier_idx" on "verification" ("identifier");`,
      ["verification.expiresAt"],
    ],
  ];

  for (const [name, change, fields] of differences) {
    it(`${name} stops the start with AUTH_SCHEMA_INCOMPATIBLE and nothing is repaired`, async () => {
      const instance = await startedInstallation();
      withWriter(instance, (handle) => handle.exec(change));
      const schemaBefore = schemaOf(instance);
      const fileBefore = sha256(databaseFile(instance));

      const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env });
      expect(exit.code, exit.output).toBe(1);
      expect(outputEvent(exit.output, "bootstrap.failed")).toEqual({ event: "bootstrap.failed", code: "AUTH_SCHEMA_INCOMPATIBLE", fields });
      expect(exit.output).not.toContain('"bootstrap.ready"');
      expect(exit.output).not.toContain('"server.listening"');
      expect(sha256(databaseFile(instance))).toBe(fileBefore);
      expect(schemaOf(instance)).toEqual(schemaBefore);
    });
  }
});
