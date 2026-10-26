// D09.3 — password sign-in and its persistent lockout on a real database file, with a
// controlled clock (Architektura §9.8). The use case, the sqlite adapters and the shared hasher
// are the production ones; only time, ids and tokens are injected.
// AC1: a correct password creates exactly one session; wrong password and foreign e-mail are the
//      same outcome; the fifth failure locks 15 minutes, blocked requests change nothing, the
//      lock opens exactly at lockedUntil, counters survive a restart, success clears only the
//      account bucket.
// AC2: a failing audit append rolls the whole attempt back (no session, no counter); a password
//      verified against a credential that changed meanwhile is refused.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { createOwner, LOCKOUT_DURATION_MS, LOCKOUT_WINDOW_MS, readIdentityStatus, signInWithPassword, signOut, type AuthAttemptOutcome, type PasswordVerifier } from "../../../packages/core/dist/modules/identity/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindIdentityAccessReader } from "../../../packages/sqlite/dist/adapters/identity/access-reader.js";
import { bindMfaStore } from "../../../packages/sqlite/dist/adapters/identity/mfa-store.js";
import { bindOwnerWriters } from "../../../packages/sqlite/dist/adapters/identity/owner-writers.js";
import { bindSignInStores } from "../../../packages/sqlite/dist/adapters/identity/sign-in-ports.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { scratchDir } from "../../support/scratch.ts";

const INSTANCE_ID = "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d48";
const EMAIL = "owner@example.test";
const PASSWORD = "  zażółć 🔐 $(id) gęślą  ";
const T0 = Date.parse("2026-10-26T12:00:00.000Z");

const hasher = createPasswordHasher();
const open: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of open.splice(0)) if (connection.handle.open) connection.close();
});

type Rig = Readonly<{
  file: string;
  connection: () => SqliteConnection;
  attempt: (options?: Partial<{ email: string; password: string; ip: string; verifier: PasswordVerifier }>) => Promise<AuthAttemptOutcome>;
  clock: { now: number };
  count: (table: string) => number;
  rows: <T>(sql: string) => T[];
}>;

async function rig(): Promise<Rig> {
  const file = path.join(scratchDir("openlife-signin-"), "app.db");
  const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
  open.push(connection);
  initializeDatabase(connection, PRODUCT_MIGRATION_PLAN, { instanceId: INSTANCE_ID, createdAt: new Date(T0).toISOString() });
  const clock = { now: T0 };
  const unitOf = () =>
    createUnitOfWork(connection, (tx) => ({ ...bindSignInStores(tx), owners: bindOwnerWriters(tx).owners, access: bindIdentityAccessReader(tx, () => clock.now), audit: bindAppendAudit(tx) }));
  const owner = createUnitOfWork(connection, (tx) => ({ ...bindOwnerWriters(tx), mfa: bindMfaStore(tx), audit: bindAppendAudit(tx) })).run((ports) =>
    createOwner(ports, { ownerId: "owner-1", email: EMAIL, passwordHash: "", requestId: "req-0", now: new Date(T0).toISOString() }),
  );
  expect(owner.ok).toBe(true);
  // The owner's real hash, written the way the CLI's credential is replaced in a test.
  connection.handle.prepare("UPDATE account SET password = ?").run(await hasher.hash(PASSWORD));
  const decoyHash = await hasher.hash("decoy password of the tests");
  let sequence = 0;
  return {
    file,
    connection: () => connection,
    clock,
    attempt: (options = {}) => {
      sequence += 1;
      const email = options.email ?? EMAIL;
      const ip = options.ip ?? "203.0.113.1";
      return signInWithPassword(
        {
          unit: unitOf(),
          verifier: options.verifier ?? hasher,
          decoyHash,
          nowMs: () => clock.now,
          newSessionId: () => `session-${sequence}`,
          newSessionToken: () => `token-${sequence}`,
        },
        { email, password: options.password ?? PASSWORD, accountKey: `account:${email}`, ipKey: `ip:${ip}`, ip, userAgent: "vitest", requestId: `req-${sequence}` },
      );
    },
    count: (table) => (connection.handle.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number),
    rows: <T>(sql: string) => connection.handle.prepare(sql).all() as T[],
  };
}

const WRONG = "a wrong password of enough length";
const buckets = (r: Rig) => r.rows<{ bucket_key: string; failures: number; locked_until_ms: number | null }>("SELECT bucket_key, failures, locked_until_ms FROM auth_lockout ORDER BY bucket_key");
const auditActions = (r: Rig) => r.rows<{ action: string }>("SELECT action FROM audit_log ORDER BY id").map((row) => row.action);

describe("D09.3-AC1 sign-in outcomes", () => {
  it("a correct password grants one session with the basic nextAction; a refusal carries none", async () => {
    const r = await rig();
    const granted = await r.attempt();
    expect(granted).toEqual({ kind: "granted", token: "token-1", expiresAtMs: T0 + 30 * 24 * 3600 * 1000, nextAction: "mfa_enrollment" });
    expect(r.count("session")).toBe(1);
    expect(r.rows("SELECT id, token, userId, ipAddress, userAgent FROM session")).toEqual([{ id: "session-1", token: "token-1", userId: "owner-1", ipAddress: "203.0.113.1", userAgent: "vitest" }]);
    expect(auditActions(r)).toEqual(["owner.created", "login.succeeded"]);

    expect(await r.attempt({ password: WRONG })).toEqual({ kind: "denied" });
    expect(r.count("session")).toBe(1);
  });

  it("a wrong password and a foreign e-mail are the same outcome and both leave counters and audit", async () => {
    const r = await rig();
    expect(await r.attempt({ password: WRONG })).toEqual({ kind: "denied" });
    expect(await r.attempt({ email: "foreign@example.test" })).toEqual({ kind: "denied" });
    expect(buckets(r).map((bucket) => [bucket.bucket_key, bucket.failures])).toEqual([
      ["account:foreign@example.test", 1],
      ["account:owner@example.test", 1],
      ["ip:203.0.113.1", 2],
    ]);
    expect(auditActions(r)).toEqual(["owner.created", "login.failed", "login.failed"]);
    expect(r.rows("SELECT details FROM audit_log WHERE action = 'login.failed' ORDER BY id")).toEqual([
      { details: '{"ownerMatched":true,"locked":false}' },
      { details: '{"ownerMatched":false,"locked":false}' },
    ]);
  });

  it("an unknown e-mail is verified against the decoy hash, so a refusal costs one verification like the owner's", async () => {
    const r = await rig();
    const calls: string[] = [];
    const spy: PasswordVerifier = { verify: (stored, password) => (calls.push(stored.slice(0, 9)), hasher.verify(stored, password)) };
    await r.attempt({ email: "foreign@example.test", verifier: spy });
    await r.attempt({ password: WRONG, verifier: spy });
    expect(calls).toEqual(["$argon2id", "$argon2id"]);
  });

  it("the fifth failure locks for 15 minutes with the remaining seconds; blocked requests change nothing", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await r.attempt({ password: WRONG })).toEqual({ kind: "denied" });
    }
    expect(await r.attempt({ password: WRONG })).toEqual({ kind: "locked", retryAfterSeconds: 900 });
    const locked = buckets(r);
    expect(locked.map((bucket) => bucket.locked_until_ms)).toEqual([T0 + LOCKOUT_DURATION_MS, T0 + LOCKOUT_DURATION_MS]);
    const auditBefore = auditActions(r);

    r.clock.now = T0 + 1000;
    expect(await r.attempt({ password: WRONG })).toEqual({ kind: "locked", retryAfterSeconds: 899 });
    // The correct password does not pass a lock, and the lock is not extended or audited.
    expect(await r.attempt()).toEqual({ kind: "locked", retryAfterSeconds: 899 });
    expect(await r.attempt({ email: "foreign@example.test" })).toEqual({ kind: "locked", retryAfterSeconds: 899 });
    expect(buckets(r).filter((bucket) => bucket.bucket_key.includes("owner") || bucket.bucket_key.startsWith("ip:"))).toEqual(locked);
    expect(auditActions(r)).toEqual(auditBefore);
    expect(r.count("session")).toBe(0);
  });

  it("a lock of a foreign e-mail looks exactly like the owner's", async () => {
    const r = await rig();
    const outcomes: AuthAttemptOutcome[] = [];
    for (let failure = 1; failure <= 5; failure += 1) {
      outcomes.push(await r.attempt({ email: "foreign@example.test", ip: "198.51.100.7" }));
    }
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["denied", "denied", "denied", "denied", "locked"]);
    expect(outcomes[4]).toEqual({ kind: "locked", retryAfterSeconds: 900 });
  });

  it("the lock is open again exactly at lockedUntil, one millisecond earlier it is not", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 5; failure += 1) await r.attempt({ password: WRONG });
    r.clock.now = T0 + LOCKOUT_DURATION_MS - 1;
    expect(await r.attempt()).toEqual({ kind: "locked", retryAfterSeconds: 1 });
    r.clock.now = T0 + LOCKOUT_DURATION_MS;
    expect((await r.attempt()).kind).toBe("granted");
    // Success clears the account bucket, not the IP's (failures of other attempts stay counted).
    expect(buckets(r).map((bucket) => bucket.bucket_key)).toEqual(["ip:203.0.113.1"]);
  });

  it("failures are counted in a 15-minute window: an older count does not add to a new failure", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 4; failure += 1) await r.attempt({ password: WRONG });
    r.clock.now = T0 + LOCKOUT_WINDOW_MS;
    expect(await r.attempt({ password: WRONG })).toEqual({ kind: "denied" });
    expect(buckets(r).map((bucket) => bucket.failures)).toEqual([1, 1]);
  });

  it("the counters survive a restart: a new connection and use case see the same lock", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 5; failure += 1) await r.attempt({ password: WRONG });
    r.connection().close();
    const reopened = openDatabase(r.file, { role: "writer", busyTimeoutMs: 5000 });
    open.push(reopened);
    const unit = createUnitOfWork(reopened, (tx) => ({ ...bindSignInStores(tx), owners: bindOwnerWriters(tx).owners, access: bindIdentityAccessReader(tx, () => T0 + 5000), audit: bindAppendAudit(tx) }));
    const outcome = await signInWithPassword(
      { unit, verifier: hasher, decoyHash: "unused", nowMs: () => T0 + 5000, newSessionId: () => "s", newSessionToken: () => "t" },
      { email: EMAIL, password: PASSWORD, accountKey: `account:${EMAIL}`, ipKey: "ip:203.0.113.1", ip: "203.0.113.1", userAgent: null, requestId: "req-restart" },
    );
    expect(outcome).toEqual({ kind: "locked", retryAfterSeconds: 895 });
  });

  it("a success clears the account's failures, not those of other buckets: three failures, a success from elsewhere, four more do not lock", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 3; failure += 1) await r.attempt({ password: WRONG, ip: "198.51.100.1" });
    expect((await r.attempt({ ip: "198.51.100.2" })).kind).toBe("granted");
    for (let failure = 1; failure <= 4; failure += 1) {
      expect(await r.attempt({ password: WRONG, ip: "198.51.100.3" })).toEqual({ kind: "denied" });
    }
    expect(buckets(r).find((bucket) => bucket.bucket_key === "ip:198.51.100.1")?.failures).toBe(3);
  });

  it("five failures from one address lock that address for every e-mail, but not other addresses", async () => {
    const r = await rig();
    for (let failure = 1; failure <= 5; failure += 1) await r.attempt({ email: `guess${failure}@example.test`, ip: "198.51.100.9" });
    expect((await r.attempt({ ip: "198.51.100.9" })).kind).toBe("locked");
    expect((await r.attempt({ ip: "198.51.100.10" })).kind).toBe("granted");
  });

  it("expired buckets are pruned by the next failure, so foreign e-mails cannot grow the table", async () => {
    const r = await rig();
    for (let guess = 1; guess <= 3; guess += 1) await r.attempt({ email: `guess${guess}@example.test`, ip: `198.51.100.${guess}` });
    expect(r.count("auth_lockout")).toBe(6);
    r.clock.now = T0 + LOCKOUT_WINDOW_MS;
    await r.attempt({ password: WRONG });
    expect(buckets(r).map((bucket) => bucket.bucket_key)).toEqual(["account:owner@example.test", "ip:203.0.113.1"]);
  });
});

describe("D09.3-AC2 the attempt is atomic", () => {
  it("a failing audit append rolls back the granted attempt: no session, and the error propagates", async () => {
    const r = await rig();
    r.connection().handle.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    await expect(r.attempt()).rejects.toThrow();
    expect(r.count("session")).toBe(0);
    expect(r.count("auth_lockout")).toBe(0);
  });

  it("a failing audit append rolls back a refusal too: no counter is stored", async () => {
    const r = await rig();
    r.connection().handle.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    await expect(r.attempt({ password: WRONG })).rejects.toThrow();
    expect(r.count("auth_lockout")).toBe(0);
  });

  it("a password verified against a credential replaced meanwhile is refused", async () => {
    const r = await rig();
    const replacing: PasswordVerifier = {
      verify: async (stored, password) => {
        const verdict = await hasher.verify(stored, password);
        r.connection().handle.prepare("UPDATE account SET password = ?").run(await hasher.hash("the owner changed the password"));
        return verdict;
      },
    };
    expect(await r.attempt({ verifier: replacing })).toEqual({ kind: "denied" });
    expect(r.count("session")).toBe(0);
  });

  it("a session that was granted is read back, ends at sign-out, and an expired or foreign one is not authenticated", async () => {
    const r = await rig();
    const granted = await r.attempt();
    if (granted.kind !== "granted") throw new Error("expected a session");
    const unit = createUnitOfWork(r.connection(), (tx) => ({ ...bindSignInStores(tx), owners: bindOwnerWriters(tx).owners, access: bindIdentityAccessReader(tx, () => r.clock.now), audit: bindAppendAudit(tx) }));
    expect(readIdentityStatus(unit, granted.token, r.clock.now)).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    expect(readIdentityStatus(unit, granted.token, granted.expiresAtMs)).toEqual({ authenticated: false, nextAction: "login" });
    expect(readIdentityStatus(unit, "not-a-token", r.clock.now)).toEqual({ authenticated: false, nextAction: "login" });
    // A session of a user who is not the owner never authenticates.
    r.connection().handle.exec(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('foreign', 'F', 'f@example.test', 0, NULL, 'x', 'x');
      INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES ('s-f', '2999-01-01T00:00:00.000Z', 'foreign-token', 'x', 'x', NULL, NULL, 'foreign');`);
    expect(readIdentityStatus(unit, "foreign-token", r.clock.now).authenticated).toBe(false);
    signOut(unit, granted.token);
    signOut(unit, granted.token);
    expect(readIdentityStatus(unit, granted.token, r.clock.now).authenticated).toBe(false);
  });
});
