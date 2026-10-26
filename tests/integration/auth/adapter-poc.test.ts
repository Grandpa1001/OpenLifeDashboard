// D09.1 — PoC of the auth adapter with the pinned better-auth on a real database file migrated
// by the product plan (Architektura §9.8). A write monitor on the connection records every
// INSERT/UPDATE/DELETE and whether it ran inside a transaction.
// AC1: the pinned version works on that database: the schema matches what it derives from the
//      adapter options and its planner has nothing to add; an owner written through the unit of
//      work signs in through the library with the shared hasher (wrong password refused), the
//      library's hash verifies with the shared hasher, and a session written through the unit of
//      work is read back by the library from this installation's cookie.
// AC2: the test detects what rules the library's API out as the write path: sign-in commits its
//      session in autocommit, a failing session after-hook (an audit failure) leaves the session
//      committed, getSession deletes an expired session (a write on a read, also under
//      maintenance), and an async step inside a unit of work is rolled back. If a later version
//      changes any of this, the test fails and the adapter decision is reviewed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { generateRandomString, makeSignature } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix, createAuthOptions } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { checkAuthSchema } from "../../../apps/server/dist/adapters/auth/auth-schema.js";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { AsyncUnitOfWorkError, createUnitOfWork, type TransactionHandle } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { scratchDir } from "../../support/scratch.ts";
import { repoRoot } from "../../support/server-process.ts";

const BASE_URL = "http://127.0.0.1:8080";
const INSTANCE_ID = "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d48";
const SECRET = "5a0c9f3e7d21b8a64c0e9f1d3b7a5c2e8f4d6b0a1c3e5f7092b4d6f8a0c2e4f6";
const EMAIL = "owner@example.test";
const PASSWORD = "  zażółć 🔐 $(id) gęślą  ";
const ORIGIN = { origin: BASE_URL };

type Write = Readonly<{ sql: string; inTransaction: boolean }>;
type Installation = Readonly<{ file: string; writer: SqliteConnection; writes: Write[] }>;

const open: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of open.splice(0)) if (connection.handle.open) connection.close();
});

/** A database file at the product schema and its writer, with every write statement recorded. */
function freshInstallation(): Installation {
  const file = path.join(scratchDir("openlife-auth-poc-"), "app.db");
  const writer = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
  open.push(writer);
  initializeDatabase(writer, PRODUCT_MIGRATION_PLAN, { instanceId: INSTANCE_ID, createdAt: new Date().toISOString() });
  const writes: Write[] = [];
  const prepare = writer.handle.prepare.bind(writer.handle);
  writer.handle.prepare = ((sql: string) => {
    if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) {
      writes.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(" ").toLowerCase(), inTransaction: writer.handle.inTransaction });
    }
    return prepare(sql);
  }) as typeof writer.handle.prepare;
  return { file, writer, writes };
}

const hasher = createPasswordHasher();
const iso = (ms: number) => new Date(ms).toISOString();
const done = <T>(value: T) => ({ value, invalidations: [] });
const bindExec = (tx: TransactionHandle) => ({ exec: (sql: string, ...params: unknown[]) => tx.prepare(sql).run(...params) });

/** The owner as the adapter writes it: user + credential account in one unit of work. */
async function writeOwner(installation: Installation, password = PASSWORD): Promise<void> {
  const stored = await hasher.hash(password);
  const now = iso(Date.now());
  createUnitOfWork(installation.writer, bindExec).run(({ exec }) => {
    exec(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-1', 'Owner', ?, 1, NULL, ?, ?)`, EMAIL, now, now);
    exec(
      `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('account-1', 'owner-1', 'credential', 'owner-1', ?, ?, ?)`,
      stored,
      now,
      now,
    );
    return done(null);
  });
}

function library(installation: Installation, extra: Partial<BetterAuthOptions> = {}) {
  return betterAuth({ ...createAuthOptions({ hasher, baseUrl: BASE_URL, secret: SECRET, instanceId: INSTANCE_ID }), database: installation.writer.handle, ...extra });
}

const signIn = (auth: ReturnType<typeof library>, password: string) =>
  auth.api.signInEmail({ body: { email: EMAIL, password }, headers: new Headers(ORIGIN), asResponse: true });

const sessionCount = (installation: Installation): unknown => installation.writer.handle.prepare("SELECT count(*) FROM session").pluck().get();

describe("D09.1-AC1 the pinned library on a real database", () => {
  it("better-auth is pinned to 1.7.13 and that version is installed", () => {
    expect(readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")).toMatch(/^ {2}better-auth: 1\.7\.13$/m);
    const installed: unknown = JSON.parse(readFileSync(path.join(repoRoot, "apps/server/node_modules/better-auth/package.json"), "utf8"));
    expect(installed).toMatchObject({ version: "1.7.13" });
  });

  it("the migrated schema matches the adapter options; the library planner has nothing to do and changes nothing", async () => {
    const installation = freshInstallation();
    expect(checkAuthSchema(installation.writer)).toEqual({ ok: true });
    const schemaBefore = installation.writer.handle.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
    const plan = await getMigrations({ ...createAuthOptions({ hasher, baseUrl: BASE_URL, secret: SECRET, instanceId: INSTANCE_ID }), database: installation.writer.handle }, { throwOnUnsafe: false });
    expect({ create: plan.toBeCreated, add: plan.toBeAdded, indexes: plan.toBeAddedIndexes, problems: plan.schemaProblems, unsafe: plan.unsafeChanges }).toEqual({
      create: [],
      add: [],
      indexes: [],
      problems: [],
      unsafe: [],
    });
    expect(installation.writer.handle.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schemaBefore);
    expect(installation.writes).toEqual([]);
  });

  it("an owner written through the unit of work signs in through the library with the shared hasher", async () => {
    const installation = freshInstallation();
    await writeOwner(installation);
    const auth = library(installation);
    expect((await signIn(auth, PASSWORD.trim())).status).toBe(401);
    expect((await signIn(auth, PASSWORD.normalize("NFD"))).status).toBe(401);
    const accepted = await signIn(auth, PASSWORD);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toMatch(new RegExp(`^${authCookiePrefix(INSTANCE_ID)}\\.session_token=`));
    // The library hashes with the same configuration: its hash verifies with the shared hasher.
    const context = await auth.$context;
    expect(await hasher.verify(await context.password.hash(PASSWORD), PASSWORD)).toBe(true);
  });

  it("a session written through the unit of work is read back by the library from this installation's cookie", async () => {
    const installation = freshInstallation();
    await writeOwner(installation);
    const token = generateRandomString(32);
    const now = Date.now();
    createUnitOfWork(installation.writer, bindExec).run(({ exec }) => {
      exec(`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES ('session-1', ?, ?, ?, ?, NULL, NULL, 'owner-1')`, iso(now + 86_400_000), token, iso(now), iso(now));
      return done(null);
    });
    installation.writes.length = 0;
    const cookie = `${authCookiePrefix(INSTANCE_ID)}.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, SECRET)}`)}`;
    const read = await library(installation).api.getSession({ headers: new Headers({ cookie }) });
    expect(read?.session.id).toBe("session-1");
    expect(read?.user.email).toBe(EMAIL);
    // Refresh is disabled in the options: reading a valid session writes nothing.
    expect(installation.writes).toEqual([]);
    const foreignCookie = `openlife-000000000000.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, SECRET)}`)}`;
    expect(await library(installation).api.getSession({ headers: new Headers({ cookie: foreignCookie }) })).toBeNull();
  });
});

describe("D09.1-AC2 the adapter test detects writes outside one commit", () => {
  it("library sign-in commits its session in autocommit, outside any unit of work", async () => {
    const installation = freshInstallation();
    await writeOwner(installation);
    installation.writes.length = 0;
    expect((await signIn(library(installation), PASSWORD)).status).toBe(200);
    expect(installation.writes).toContainEqual({ sql: 'insert into "session"', inTransaction: false });
  });

  it("a failing session after-hook (an audit write that fails) leaves the session committed", async () => {
    const installation = freshInstallation();
    await writeOwner(installation);
    const auth = library(installation, {
      databaseHooks: {
        session: {
          create: {
            after: async () => {
              throw new Error("audit_log unavailable");
            },
          },
        },
      },
    });
    await expect(signIn(auth, PASSWORD)).rejects.toThrow("audit_log unavailable");
    // No shared commit: the session exists although its audit failed.
    expect(sessionCount(installation)).toBe(1);
  });

  it("library getSession deletes an expired session: a write on a read, also while maintenance holds the database", async () => {
    const installation = freshInstallation();
    await writeOwner(installation);
    const auth = library(installation);
    const cookie = (await signIn(auth, PASSWORD)).headers.get("set-cookie")?.split(";")[0] ?? "";
    installation.writer.handle.prepare("UPDATE session SET expiresAt = ?").run(iso(Date.now() - 1000));
    installation.writes.length = 0;
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(installation.writes).toContainEqual({ sql: 'delete from "session"', inTransaction: false });
    expect(sessionCount(installation)).toBe(0);
  });

  it("hashing inside a unit of work is rejected and rolls back the credential write", async () => {
    const installation = freshInstallation();
    const now = iso(Date.now());
    expect(() =>
      createUnitOfWork(installation.writer, bindExec).run(
        // @ts-expect-error -- the unit-of-work type refuses async work; this is the runtime guard.
        async ({ exec }) => {
          exec(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-1', 'Owner', ?, 1, NULL, ?, ?)`, EMAIL, now, now);
          await hasher.hash(PASSWORD);
          return done(null);
        },
      ),
    ).toThrow(AsyncUnitOfWorkError);
    expect(installation.writer.handle.prepare(`SELECT count(*) FROM "user"`).pluck().get()).toBe(0);
  });
});
