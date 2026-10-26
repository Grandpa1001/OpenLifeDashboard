// D09.2 — the built `create-owner` CLI on real installations (Architektura §4.8, §9.8).
// AC1: parallel runs give exactly one owner, one credential and one `owner.created` entry; the
//      password arrives only on stdin and appears in no argument, environment effect, output,
//      database file or maintenance file; the credential works through the shared hasher and the
//      library sign-in. (F09 parallel-owner-creation)
// AC2: a failing audit append, credential or singleton claim rolls the whole command back (F09
//      owner-audit-failure-rolls-back); a second owner, a foreign user with the same e-mail and a
//      running app writer are refused and change nothing.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { createAuthOptions } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { createPasswordHasher, PASSWORD_HASH_PREFIX } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import {
  freshTestInstance,
  outputEvent,
  repoRoot,
  runBuiltScript,
  startBuiltServer,
  startedInstallation,
  waitForExit,
  type ProcessExit,
} from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
const EMAIL = "owner@example.test";
const PASSWORD = "  zażółć 🔐 $(id) gęślą  ";

const databaseFile = (instance: TestInstance): string => path.join(instance.dir, "data", "app.db");
const input = (email: string, password: string): string => JSON.stringify({ email, password });
const cliEnv = (instance: TestInstance): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", ...instance.env });

function createOwner(instance: TestInstance, stdin: string, args: readonly string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Promise<ProcessExit> {
  return runBuiltScript(CREATE_OWNER, ["--installation", instance.dir, ...args], { ...cliEnv(instance), ...extraEnv }, stdin);
}

/** Reads through a reader connection, so it also works while another process holds the writer. */
function query<T>(instance: TestInstance, sql: string): T[] {
  const reader = openDatabase(databaseFile(instance), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all() as T[];
  } finally {
    reader.close();
  }
}

const count = (instance: TestInstance, table: string): number => query<{ n: number }>(instance, `SELECT count(*) AS n FROM "${table}"`)[0]?.n ?? -1;
const counts = (instance: TestInstance) => ({
  users: count(instance, "user"),
  accounts: count(instance, "account"),
  owners: count(instance, "instance_state"),
  audit: count(instance, "audit_log"),
});
const NOTHING = { users: 0, accounts: 0, owners: 0, audit: 0 };
const ONE_OWNER = { users: 1, accounts: 1, owners: 1, audit: 1 };

function withWriter(instance: TestInstance, use: (exec: (sql: string) => void) => void): void {
  const writer = openDatabase(databaseFile(instance), { role: "writer", busyTimeoutMs: 5000 });
  try {
    use((sql) => void writer.handle.exec(sql));
  } finally {
    writer.close();
  }
}

/** Every file under the installation except the build output, as text. */
function installationText(instance: TestInstance): string {
  return readdirSync(instance.dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const bytes = readFileSync(path.join(entry.parentPath, entry.name));
      return `${bytes.toString("latin1")}\n${bytes.toString("utf8")}`;
    })
    .join("\n");
}

const failure = (run: ProcessExit): Record<string, unknown> | undefined => outputEvent(run.output, "create-owner.failed");

describe("D09.2-AC1 one owner, one credential, one audit entry", () => {
  it("creates the owner from stdin; hash, singleton and audit entry are stored; no secret is left anywhere", async () => {
    const instance = await startedInstallation();
    const run = await createOwner(instance, input("  Owner@Example.TEST ", PASSWORD), [], { OWNER_PASSWORD: "ignored-env-password" });
    expect(run.code, run.output).toBe(0);
    const created = outputEvent(run.output, "owner.created");
    expect(created).toMatchObject({ event: "owner.created", ownerId: expect.any(String), requestId: expect.any(String) });
    const ownerId = String(created?.["ownerId"]);

    expect(counts(instance)).toEqual(ONE_OWNER);
    expect(query(instance, `SELECT id, email, emailVerified FROM "user"`)).toEqual([{ id: ownerId, email: EMAIL, emailVerified: 1 }]);
    expect(query<{ password: string; providerId: string; accountId: string; userId: string }>(instance, "SELECT password, providerId, accountId, userId FROM account")).toEqual([
      { password: expect.stringMatching(/^\$argon2id\$/), providerId: "credential", accountId: ownerId, userId: ownerId },
    ]);
    const stored = query<{ password: string }>(instance, "SELECT password FROM account")[0]?.password ?? "";
    expect(stored.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(await createPasswordHasher().verify(stored, PASSWORD)).toBe(true);
    expect(await createPasswordHasher().verify(stored, PASSWORD.trim())).toBe(false);
    expect(query(instance, "SELECT owner_id, access_epoch FROM instance_state")).toEqual([{ owner_id: ownerId, access_epoch: 1 }]);
    expect(query(instance, "SELECT actor, action, entity, entity_id, request_id, details FROM audit_log")).toEqual([
      { actor: ownerId, action: "owner.created", entity: "owner", entity_id: ownerId, request_id: created?.["requestId"], details: null },
    ]);

    // The password is in no output and no file of the installation (database, WAL, state, logs).
    for (const secret of [PASSWORD, PASSWORD.trim(), "ignored-env-password"]) {
      expect(run.output).not.toContain(secret);
      expect(installationText(instance)).not.toContain(secret);
    }
  });

  it("the created owner signs in through the library with the shared hasher; a wrong password does not", async () => {
    const instance = await startedInstallation();
    expect((await createOwner(instance, input(EMAIL, PASSWORD))).code).toBe(0);
    const writer = openDatabase(databaseFile(instance), { role: "writer", busyTimeoutMs: 5000 });
    try {
      const auth = betterAuth({
        ...createAuthOptions({ hasher: createPasswordHasher(), baseUrl: "http://localhost:8080", secret: instance.secrets[0] ?? "", instanceId: instance.instanceId }),
        database: writer.handle,
      });
      const signIn = (password: string) =>
        auth.api.signInEmail({ body: { email: EMAIL, password }, headers: new Headers({ origin: "http://localhost:8080" }), asResponse: true });
      expect((await signIn(PASSWORD.trim())).status).toBe(401);
      expect((await signIn(PASSWORD)).status).toBe(200);
    } finally {
      writer.close();
    }
  });

  it("F09 parallel-owner-creation: four simultaneous commands give one success, one owner, one credential, one audit entry", async () => {
    const instance = await startedInstallation();
    const runs = await Promise.all(
      ["a", "b", "c", "d"].map((name) => createOwner(instance, input(`${name}@example.test`, `password for ${name} 🔐 ${name}`))),
    );
    const succeeded = runs.filter((run) => run.code === 0);
    expect(succeeded).toHaveLength(1);
    // The others met the running creator (the lease is not waited for) or the finished owner.
    for (const run of runs.filter((each) => each.code !== 0)) {
      expect(run.code).toBe(1);
      expect(["INSTANCE_BUSY", "OWNER_ALREADY_EXISTS"]).toContain(failure(run)?.["code"]);
    }
    expect(counts(instance)).toEqual(ONE_OWNER);
    const winner = succeeded[0];
    const ownerId = String(outputEvent(winner?.output ?? "", "owner.created")?.["ownerId"]);
    expect(query(instance, "SELECT owner_id FROM instance_state")).toEqual([{ owner_id: ownerId }]);
  });

  it("credentials never travel in arguments or the environment: any extra argument is a usage error, empty stdin is invalid input", async () => {
    const instance = await startedInstallation();
    const withArgument = await createOwner(instance, input(EMAIL, PASSWORD), ["--password", "hunter2hunter2"]);
    expect(withArgument.code).toBe(1);
    expect(failure(withArgument)).toMatchObject({ code: "USAGE", fields: ["arguments"] });
    expect(withArgument.output).not.toContain("hunter2hunter2");
    const fromEnvironment = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], {
      ...cliEnv(instance),
      OWNER_EMAIL: EMAIL,
      OWNER_PASSWORD: PASSWORD,
    });
    expect(fromEnvironment.code).toBe(1);
    expect(failure(fromEnvironment)).toMatchObject({ code: "INPUT_INVALID" });
    expect(counts(instance)).toEqual(NOTHING);
  });

  const invalid: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["a password of 11 characters", input(EMAIL, "elevenchars"), ["password"]],
    ["a password of 129 emoji", input(EMAIL, "🔐".repeat(129)), ["password"]],
    ["a malformed e-mail", input("not-an-email", "a long enough password"), ["email"]],
    ["an unknown field", JSON.stringify({ email: EMAIL, password: PASSWORD, role: "admin" }), ["input"]],
    ["input that is not JSON", "owner@example.test a long enough password", ["input"]],
    ["input of more than 16 KiB", input(EMAIL, "x".repeat(20_000)), ["input"]],
  ];
  for (const [name, stdin, fields] of invalid) {
    it(`refuses ${name} with INPUT_INVALID naming fields, not values, and creates nothing`, async () => {
      const instance = await startedInstallation();
      const run = await createOwner(instance, stdin);
      expect(run.code).toBe(1);
      expect(failure(run)).toEqual({ event: "create-owner.failed", code: "INPUT_INVALID", fields });
      expect(run.output).not.toContain("elevenchars");
      expect(counts(instance)).toEqual(NOTHING);
    });
  }

  it("accepts the shortest and the longest valid password counted in code points", async () => {
    for (const password of ["a".repeat(12), "🔐".repeat(128)]) {
      const instance = await startedInstallation();
      const run = await createOwner(instance, input(EMAIL, password));
      expect(run.code, run.output).toBe(0);
      const stored = query<{ password: string }>(instance, "SELECT password FROM account")[0]?.password ?? "";
      expect(await createPasswordHasher().verify(stored, password)).toBe(true);
    }
  });
});

describe("D09.2-AC2 failures roll back everything; other writers and owners are refused", () => {
  const failing: ReadonlyArray<readonly [string, string]> = [
    ["F09 owner-audit-failure-rolls-back: the audit append fails", `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`],
    ["the credential write fails", `CREATE TRIGGER fail_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'account unavailable'); END;`],
    ["the owner singleton claim fails", `CREATE TRIGGER fail_claim BEFORE INSERT ON instance_state BEGIN SELECT RAISE(ABORT, 'singleton unavailable'); END;`],
  ];
  for (const [name, trigger] of failing) {
    it(`${name}: exit 1, no user, credential, owner or audit entry, and the next run succeeds`, async () => {
      const instance = await startedInstallation();
      withWriter(instance, (exec) => exec(trigger));
      const run = await createOwner(instance, input(EMAIL, PASSWORD));
      expect(run.code).toBe(1);
      expect(failure(run)).toMatchObject({ code: "COMMAND_FAILED", fields: [] });
      expect(counts(instance)).toEqual(NOTHING);
      // Neither the password nor the database message reaches the output.
      expect(run.output).not.toContain(PASSWORD.trim());
      expect(run.output).not.toContain("unavailable");
      withWriter(instance, (exec) => exec(trigger.replace(/^CREATE TRIGGER (\w+) .*/, "DROP TRIGGER $1;")));
      const retry = await createOwner(instance, input(EMAIL, PASSWORD));
      expect(retry.code, retry.output).toBe(0);
      expect(counts(instance)).toEqual(ONE_OWNER);
    });
  }

  it("a second owner is refused with OWNER_ALREADY_EXISTS; the first credential, owner and audit entry stay as they were", async () => {
    const instance = await startedInstallation();
    expect((await createOwner(instance, input(EMAIL, PASSWORD))).code).toBe(0);
    const credentialRows = (): string => JSON.stringify([query(instance, `SELECT * FROM "user"`), query(instance, "SELECT * FROM account")]);
    const before = credentialRows();
    const second = await createOwner(instance, input("second@example.test", "another strong password"));
    expect(second.code).toBe(1);
    expect(failure(second)).toEqual({ event: "create-owner.failed", code: "OWNER_ALREADY_EXISTS", fields: [] });
    expect(counts(instance)).toEqual(ONE_OWNER);
    expect(credentialRows()).toBe(before);
  });

  it("a foreign user row is not an owner: the owner is created beside it; a foreign user with the same e-mail rolls the command back", async () => {
    const instance = await startedInstallation();
    withWriter(instance, (exec) =>
      exec(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('foreign-1', 'Foreign', 'foreign@example.test', 0, NULL, 'now', 'now');`),
    );
    const collision = await createOwner(instance, input("foreign@example.test", PASSWORD));
    expect(collision.code).toBe(1);
    expect(failure(collision)).toMatchObject({ code: "COMMAND_FAILED" });
    expect(counts(instance)).toEqual({ ...NOTHING, users: 1 });

    const run = await createOwner(instance, input(EMAIL, PASSWORD));
    expect(run.code, run.output).toBe(0);
    const ownerId = String(outputEvent(run.output, "owner.created")?.["ownerId"]);
    expect(query(instance, "SELECT owner_id FROM instance_state")).toEqual([{ owner_id: ownerId }]);
    expect(counts(instance)).toEqual({ ...ONE_OWNER, users: 2 });
  });

  it("a running app holds the writer: INSTANCE_BUSY, no change of the database; after it stops the command works", async () => {
    const instance = await startedInstallation();
    const server = await startBuiltServer({ installation: instance });
    const stateFile = path.join(instance.dir, "control", "maintenance", "state.json");
    const stateBefore = readFileSync(stateFile, "utf8");
    const run = await createOwner(instance, input(EMAIL, PASSWORD));
    expect(run.code).toBe(1);
    expect(failure(run)).toEqual({ event: "create-owner.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] });
    expect(counts(instance)).toEqual(NOTHING);
    expect(readFileSync(stateFile, "utf8")).toBe(stateBefore);

    server.child.kill("SIGTERM");
    expect((await waitForExit(server.child, server.output, 15_000)).code).toBe(0);
    expect((await createOwner(instance, input(EMAIL, PASSWORD))).code).toBe(0);
    expect(counts(instance)).toEqual(ONE_OWNER);
  });

  it("an installation whose app has not started yet has no database: DATABASE_MISSING, none is created", async () => {
    const instance = freshTestInstance();
    const run = await createOwner(instance, input(EMAIL, PASSWORD));
    expect(run.code).toBe(1);
    expect(failure(run)).toEqual({ event: "create-owner.failed", code: "DATABASE_MISSING", fields: ["database"] });
    expect(readdirSync(path.join(instance.dir, "data"))).not.toContain("app.db");
  });
});
