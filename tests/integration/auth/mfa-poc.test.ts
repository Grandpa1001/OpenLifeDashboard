// D10.1 — prototype of the one second-factor mechanism on a real database file (Architektura
// §9.3, §9.6, §9.7, §9.8). The decision it checks: Better Auth supplies the schema of its own
// tables and primitives (HOTP of @better-auth/utils 0.5.1, token and cookie signature); its
// `twoFactor` plugin is not used. The second factor's state is `mfa_state` and the assurance of a
// session is `session_ext`, both written only by the application's unit of work, with the
// secret sealed by the server's AES-256-GCM box. The flow below is the prototype: password
// session → enrollment challenge → confirmation → rotated session, read again after a restart.
// D11 implements the same steps as use cases with recovery codes, acknowledgment and routes.
// AC1: the prototype runs end to end and the state survives a restart; the secret exists only
//      as an envelope bound to owner and generation; one pending challenge activates once.
// AC2: a public update of the library cannot set assurance or timestamps; expiry and revocation
//      are read from the database at once (no cookie cache); an integration that does not behave
//      as assumed is reported as blocked.
import { readFileSync } from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix, createAuthOptions } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { checkMfaIntegration } from "../../../apps/server/dist/adapters/auth/mfa-capabilities.js";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { createSecretBox } from "../../../apps/server/dist/adapters/auth/secret-box.js";
import { createTotp, totpStepAt } from "../../../apps/server/dist/adapters/auth/totp.js";
import { createOwner, signInWithPassword, type SessionFacts } from "../../../packages/core/dist/modules/identity/public.js";
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
const BASE_URL = "http://127.0.0.1:8080";
const AUTH_SECRET = "5a0c9f3e7d21b8a64c0e9f1d3b7a5c2e8f4d6b0a1c3e5f7092b4d6f8a0c2e4f6";
const KEY = "9f2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c0e1b3d5f7a9c1e3b5d7f90";
const OTHER_KEY = "0b1d3f5a7c9e1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d";
const EMAIL = "owner@example.test";
const PASSWORD = "a passphrase for the prototype";
const T0 = Date.parse("2026-10-26T12:00:07.000Z");
const PENDING_LIFETIME_MS = 10 * 60 * 1000;

const hasher = createPasswordHasher();
const box = createSecretBox(KEY);
const totp = createTotp();
const open: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of open.splice(0)) if (connection.handle.open) connection.close();
});

type Rig = ReturnType<typeof rigOf> extends Promise<infer R> ? R : never;

/** A migrated database, an owner created by the production use case and a controlled clock. */
async function rigOf() {
  const file = path.join(scratchDir("openlife-mfa-"), "app.db");
  const clock = { now: T0 };
  let connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
  open.push(connection);
  initializeDatabase(connection, PRODUCT_MIGRATION_PLAN, { instanceId: INSTANCE_ID, createdAt: new Date(T0).toISOString() });
  const unitOn = (on: SqliteConnection) =>
    createUnitOfWork(on, (tx) => ({
      ...bindSignInStores(tx),
      ...bindOwnerWriters(tx),
      owners: bindOwnerWriters(tx).owners,
      mfa: bindMfaStore(tx),
      access: bindIdentityAccessReader(tx, () => clock.now),
      audit: bindAppendAudit(tx),
    }));
  let unit = unitOn(connection);
  const created = unit.run((ports) => createOwner(ports, { ownerId: "owner-1", email: EMAIL, passwordHash: "", requestId: "req-0", now: new Date(T0).toISOString() }));
  expect(created.ok).toBe(true);
  connection.handle.prepare("UPDATE account SET password = ?").run(await hasher.hash(PASSWORD));
  return {
    file,
    clock,
    get connection() {
      return connection;
    },
    get unit() {
      return unit;
    },
    /** A restart: the connection is closed and the file opened again. */
    reopen() {
      connection.close();
      connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
      open.push(connection);
      unit = unitOn(connection);
    },
    rows: <T>(sql: string) => connection.handle.prepare(sql).all() as T[],
  };
}

const done = <T>(value: T) => ({ value, invalidations: [] });

async function passwordSession(r: Rig, tag = "1"): Promise<string> {
  const outcome = await signInWithPassword(
    { unit: r.unit, verifier: hasher, decoyHash: "unused", nowMs: () => r.clock.now, newSessionId: () => `session-${tag}`, newSessionToken: () => `token-${tag}` },
    { email: EMAIL, password: PASSWORD, accountKey: "account", ipKey: "ip", ip: "127.0.0.1", userAgent: "vitest", requestId: `req-${tag}` },
  );
  if (outcome.kind !== "granted") throw new Error("the password session was not granted");
  return outcome.token;
}

const facts = (r: Rig, token: string): SessionFacts | null => {
  const read = r.unit.run((ports) => done(ports.sessions.findActive(token, r.clock.now)));
  return read.ok ? read.value.value : null;
};
const mfaRecord = (r: Rig) => {
  const read = r.unit.run((ports) => done(ports.mfa.read()));
  if (!read.ok) throw new Error("mfa read failed");
  return read.value.value;
};

/** Enrollment, step 1: a pending secret sealed for the generation it will have once active. */
function beginEnrollment(r: Rig, challengeId: string): { secret: string } {
  const secret = totp.generateSecret();
  const generation = mfaRecord(r)?.secretGeneration ?? 0;
  const sealed = box.seal(secret, { ownerId: "owner-1", generation: generation + 1 });
  r.unit.run((ports) => {
    ports.mfa.savePending({ challengeId, secret: sealed, expiresAtMs: r.clock.now + PENDING_LIFETIME_MS });
    return done(null);
  });
  return { secret };
}

const codeAt = async (secret: string, step: number): Promise<string> => createOTP(Buffer.from(secret, "base64url"), { digits: 6, period: 30 }).hotp(step);

/**
 * Enrollment, step 2: the code is checked against the opened pending secret (async, outside the
 * unit), then one unit activates it, rotates the session and audits. Returns the new token.
 */
async function confirmEnrollment(r: Rig, oldToken: string, challengeId: string, code: string, newToken: string): Promise<string | null> {
  const record = mfaRecord(r);
  if (record?.pending?.challengeId !== challengeId) return null;
  const secret = box.open(record.pending.secret, { ownerId: "owner-1", generation: record.secretGeneration + 1 });
  if (secret === null) return null;
  const step = await totp.verify(secret, code, r.clock.now);
  if (step === null || step <= (record.lastUsedStep ?? -1)) return null;
  const old = facts(r, oldToken);
  if (old === null) return null;
  const result = r.unit.run((ports) => {
    const activated = ports.mfa.activatePending({ challengeId, expectedGeneration: record.secretGeneration, usedStep: step, nowMs: r.clock.now });
    const rotated =
      activated &&
      ports.sessions.rotate(oldToken, {
        sessionId: `session-${newToken}`,
        token: newToken,
        ownerId: old.ownerId,
        createdAtMs: r.clock.now,
        expiresAtMs: r.clock.now + 30 * 24 * 3600 * 1000,
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        assurance: "totp",
        passwordVerifiedAtMs: old.passwordVerifiedAtMs,
        totpVerifiedAtMs: r.clock.now,
        accessEpoch: old.accessEpoch,
      });
    if (rotated) {
      ports.audit.append({ ownerId: old.ownerId, action: "mfa.enrolled", entityId: old.ownerId, at: new Date(r.clock.now).toISOString(), requestId: "req-enroll" });
    }
    return done(rotated);
  });
  return result.ok && result.value.value ? newToken : null;
}

describe("D10.1-AC1 the prototype: password session → enrollment challenge → rotation, read after a restart", () => {
  it("runs end to end; the state of the owner, the factor and the session is in the file after a restart", async () => {
    const r = await rigOf();
    expect(mfaRecord(r)).toEqual({ policy: "required", enrollmentState: "required", secretGeneration: 0, activeSecret: null, lastUsedStep: null, pending: null });

    const passwordToken = await passwordSession(r);
    expect(facts(r, passwordToken)).toEqual({ sessionId: "session-1", ownerId: "owner-1", assurance: "password", passwordVerifiedAtMs: T0, totpVerifiedAtMs: null, accessEpoch: 1 });

    const { secret } = beginEnrollment(r, "challenge-1");
    expect(totp.uri(secret, "OpenLifeDashboard", EMAIL)).toMatch(/^otpauth:\/\/totp\/.+secret=[A-Z2-7]+.*digits=6.*period=30/);
    const step = totpStepAt(r.clock.now);
    // A wrong code and a code two steps away change nothing.
    expect(await confirmEnrollment(r, passwordToken, "challenge-1", "000000", "token-2")).toBeNull();
    expect(await confirmEnrollment(r, passwordToken, "challenge-1", await codeAt(secret, step + 2), "token-2")).toBeNull();
    expect(mfaRecord(r)?.secretGeneration).toBe(0);
    expect(facts(r, passwordToken)?.assurance).toBe("password");

    const promoted = await confirmEnrollment(r, passwordToken, "challenge-1", await codeAt(secret, step), "token-2");
    expect(promoted).toBe("token-2");
    // The password token stopped working at once; the new session says how it proved itself.
    expect(facts(r, passwordToken)).toBeNull();
    expect(facts(r, "token-2")).toEqual({ sessionId: "session-token-2", ownerId: "owner-1", assurance: "totp", passwordVerifiedAtMs: T0, totpVerifiedAtMs: T0, accessEpoch: 1 });

    r.reopen();
    const record = mfaRecord(r);
    expect(record).toMatchObject({ policy: "required", enrollmentState: "awaiting_recovery_ack", secretGeneration: 1, lastUsedStep: step, pending: null });
    expect(box.open(record?.activeSecret ?? "", { ownerId: "owner-1", generation: 1 })).toBe(secret);
    expect(facts(r, "token-2")?.assurance).toBe("totp");
    expect(facts(r, passwordToken)).toBeNull();
    expect(r.rows<{ n: number }>("SELECT count(*) AS n FROM session_ext")[0]?.n).toBe(1);
    expect(r.rows("SELECT action FROM audit_log WHERE action = 'mfa.enrolled'")).toHaveLength(1);
  });

  it("the secret is in the file only as an envelope, never in clear", async () => {
    const r = await rigOf();
    const token = await passwordSession(r);
    const { secret } = beginEnrollment(r, "challenge-1");
    const pending = mfaRecord(r)?.pending?.secret ?? "";
    expect(pending).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(pending).not.toContain(secret);
    await confirmEnrollment(r, token, "challenge-1", await codeAt(secret, totpStepAt(r.clock.now)), "token-2");
    r.connection.handle.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(r.file);
    expect(bytes.toString("latin1")).not.toContain(secret);
    expect(bytes.toString("latin1")).not.toContain(Buffer.from(secret, "base64url").toString("latin1"));
  });

  it("an accepted step is consumed: the same code cannot confirm again and a replacement challenge needs a later step", async () => {
    const r = await rigOf();
    const token = await passwordSession(r);
    const first = beginEnrollment(r, "challenge-1");
    const step = totpStepAt(r.clock.now);
    const promoted = await confirmEnrollment(r, token, "challenge-1", await codeAt(first.secret, step), "token-2");
    expect(promoted).toBe("token-2");
    // The challenge is spent: the same code and the same challenge confirm nothing.
    expect(await confirmEnrollment(r, "token-2", "challenge-1", await codeAt(first.secret, step), "token-3")).toBeNull();
    expect(facts(r, "token-2")?.assurance).toBe("totp");
  });

  it("activation is a compare-and-set: of two confirmations of one challenge exactly one wins; an expired or foreign challenge never activates", async () => {
    const r = await rigOf();
    beginEnrollment(r, "challenge-1");
    const activate = (challengeId: string, expectedGeneration: number, nowMs: number): boolean => {
      const run = r.unit.run((ports) => done(ports.mfa.activatePending({ challengeId, expectedGeneration, usedStep: 5, nowMs })));
      return run.ok && run.value.value;
    };
    expect(activate("challenge-other", 0, r.clock.now)).toBe(false);
    expect(activate("challenge-1", 3, r.clock.now)).toBe(false);
    expect(activate("challenge-1", 0, r.clock.now + PENDING_LIFETIME_MS)).toBe(false);
    expect(mfaRecord(r)?.secretGeneration).toBe(0);
    expect(activate("challenge-1", 0, r.clock.now)).toBe(true);
    expect(activate("challenge-1", 0, r.clock.now)).toBe(false);
    expect(mfaRecord(r)).toMatchObject({ secretGeneration: 1, lastUsedStep: 5, pending: null });
  });

  it("rotation is atomic with the activation: if the session is gone nothing is activated", async () => {
    const r = await rigOf();
    const token = await passwordSession(r);
    const { secret } = beginEnrollment(r, "challenge-1");
    r.unit.run((ports) => done(ports.sessions.deleteByToken(token)));
    expect(await confirmEnrollment(r, token, "challenge-1", await codeAt(secret, totpStepAt(r.clock.now)), "token-2")).toBeNull();
    expect(mfaRecord(r)).toMatchObject({ secretGeneration: 0, activeSecret: null });
    // The rotation inside the unit: a missing old session rolls the activation back.
    expect(() =>
      r.unit.run((ports) => {
        const activated = ports.mfa.activatePending({ challengeId: "challenge-1", expectedGeneration: 0, usedStep: 1, nowMs: r.clock.now });
        if (activated && !ports.sessions.rotate("gone", { sessionId: "s", token: "t", ownerId: "owner-1", createdAtMs: 0, expiresAtMs: 1, ipAddress: null, userAgent: null, assurance: "totp", passwordVerifiedAtMs: 0, totpVerifiedAtMs: 0, accessEpoch: 1 })) {
          throw new Error("rotate refused");
        }
        return done(null);
      }),
    ).toThrow("rotate refused");
    expect(mfaRecord(r)).toMatchObject({ secretGeneration: 0, activeSecret: null });
    expect(mfaRecord(r)?.pending?.challengeId).toBe("challenge-1");
  });
});

describe("D10.1-AC1 the secret box and the verifier", () => {
  const context = { ownerId: "owner-1", generation: 1 };

  it("an envelope opens only with its key, owner, generation and format; any change of it is refused", () => {
    const envelope = box.seal("secret value", context);
    expect(box.open(envelope, context)).toBe("secret value");
    expect(createSecretBox(OTHER_KEY).open(envelope, context)).toBeNull();
    expect(box.open(envelope, { ...context, ownerId: "owner-2" })).toBeNull();
    expect(box.open(envelope, { ...context, generation: 2 })).toBeNull();
    expect(box.open(envelope.replace(/^v1/, "v2"), context)).toBeNull();
    expect(box.open(envelope.slice(0, -2), context)).toBeNull();
    expect(box.open(`${envelope}.x`, context)).toBeNull();
    expect(box.open("", context)).toBeNull();
    const [format = "", nonce = "", sealed = ""] = envelope.split(".");
    const flipped = Buffer.from(sealed, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(box.open([format, nonce, flipped.toString("base64url")].join("."), context)).toBeNull();
  });

  it("every seal uses a new nonce, so equal secrets give different envelopes", () => {
    expect(box.seal("same", context)).not.toBe(box.seal("same", context));
  });

  it("the verifier accepts the step before, the current and the next, and returns the matching step; two steps away and malformed codes are refused", async () => {
    const secret = totp.generateSecret();
    const now = T0;
    const step = totpStepAt(now);
    for (const offset of [-1, 0, 1]) {
      expect(await totp.verify(secret, await codeAt(secret, step + offset), now)).toBe(step + offset);
    }
    for (const offset of [-2, 2]) {
      expect(await totp.verify(secret, await codeAt(secret, step + offset), now)).toBeNull();
    }
    for (const malformed of ["", "12345", "1234567", "12345a", " 123456", "٠٠٠٠٠٠"]) {
      expect(await totp.verify(secret, malformed, now)).toBeNull();
    }
    expect(Buffer.from(secret, "base64url")).toHaveLength(20);
  });
});

describe("D10.1-AC2 no public write of assurance; the database decides; a mismatch blocks", () => {
  it("the library's public update-user cannot set assurance, timestamps, epoch or the factor's state", async () => {
    const r = await rigOf();
    const token = await passwordSession(r);
    const options = createAuthOptions({ hasher, baseUrl: BASE_URL, secret: AUTH_SECRET, instanceId: INSTANCE_ID });
    const auth = betterAuth({ ...options, database: r.connection.handle });
    const cookie = `${authCookiePrefix(INSTANCE_ID)}.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, AUTH_SECRET)}`)}`;
    const headers = new Headers({ cookie, origin: BASE_URL });
    // No plugin: nothing of the library's own two-factor model is installed.
    expect(options.plugins ?? []).toEqual([]);
    expect(Object.keys(auth.api).filter((name) => /twoFactor|totp|backupCode/i.test(name))).toEqual([]);

    const before = { ext: r.rows("SELECT * FROM session_ext"), mfa: r.rows("SELECT * FROM mfa_state"), epoch: r.rows("SELECT * FROM instance_state"), columns: r.rows("SELECT name FROM pragma_table_info('user')") };
    const attack = { name: "Mallory", assurance: "totp", totpVerifiedAtMs: 1, passwordVerifiedAtMs: 1, accessEpoch: 99, twoFactorEnabled: true, mfaVerifiedAt: 1 };
    await auth.api.updateUser({ headers, body: attack as never }).catch(() => undefined);
    expect({ ext: r.rows("SELECT * FROM session_ext"), mfa: r.rows("SELECT * FROM mfa_state"), epoch: r.rows("SELECT * FROM instance_state"), columns: r.rows("SELECT name FROM pragma_table_info('user')") }).toEqual(before);
    expect(facts(r, token)?.assurance).toBe("password");
  });

  it("revocation, rotation and expiry are read from the database at once, also by the library: no cookie cache", async () => {
    const r = await rigOf();
    const options = createAuthOptions({ hasher, baseUrl: BASE_URL, secret: AUTH_SECRET, instanceId: INSTANCE_ID });
    expect(options.session?.cookieCache?.enabled).toBe(false);
    expect(options.session?.disableSessionRefresh).toBe(true);
    const auth = betterAuth({ ...options, database: r.connection.handle });
    const cookieFor = async (token: string): Promise<Headers> =>
      new Headers({ cookie: `${authCookiePrefix(INSTANCE_ID)}.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, AUTH_SECRET)}`)}` });

    const token = await passwordSession(r);
    expect((await auth.api.getSession({ headers: await cookieFor(token) }))?.session.token).toBe(token);
    // Rotation (promotion): the old cookie is dead immediately.
    const { secret } = beginEnrollment(r, "challenge-1");
    expect(await confirmEnrollment(r, token, "challenge-1", await codeAt(secret, totpStepAt(r.clock.now)), "token-2")).toBe("token-2");
    expect(await auth.api.getSession({ headers: await cookieFor(token) })).toBeNull();
    expect((await auth.api.getSession({ headers: await cookieFor("token-2") }))?.session.token).toBe("token-2");
    // Revocation: the row is gone, the signed cookie is still well formed, and it authenticates nothing.
    r.unit.run((ports) => done(ports.sessions.deleteAllOfOwner("owner-1")));
    expect(await auth.api.getSession({ headers: await cookieFor("token-2") })).toBeNull();
    expect(facts(r, "token-2")).toBeNull();
    expect(r.rows("SELECT count(*) AS n FROM session_ext")).toEqual([{ n: 0 }]);
    // Expiry: a session whose time has come is not active for our reader either.
    const fresh = await passwordSession(r, "3");
    expect(facts(r, fresh)).not.toBeNull();
    r.clock.now += 30 * 24 * 3600 * 1000;
    expect(facts(r, fresh)).toBeNull();
  });

  it("migration 5 gives an existing owner and sessions their rows, so an installation migrated from migration 4 stays consistent", async () => {
    const file = path.join(scratchDir("openlife-mfa-migrate-"), "app.db");
    const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
    open.push(connection);
    initializeDatabase(connection, PRODUCT_MIGRATION_PLAN.slice(0, 4), { instanceId: INSTANCE_ID, createdAt: new Date(T0).toISOString() });
    const now = new Date(T0).toISOString();
    connection.handle.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('o', 'Owner', 'o@example.test', 1, NULL, '${now}', '${now}'), ('f', 'Foreign', 'f@example.test', 0, NULL, '${now}', '${now}');
      INSERT INTO instance_state (singleton, owner_id, access_epoch, owner_created_at) VALUES (1, 'o', 3, '${now}');
      INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES ('s1', '2999-01-01T00:00:00.000Z', 't1', '${now}', '${now}', NULL, NULL, 'o'), ('s2', '2999-01-01T00:00:00.000Z', 't2', '${now}', '${now}', NULL, NULL, 'f');
    `);
    const { migrateDatabase } = await import("../../../packages/sqlite/dist/migrations/public.js");
    migrateDatabase(connection, PRODUCT_MIGRATION_PLAN, now);
    expect(connection.handle.prepare("SELECT policy, enrollment_state, secret_generation FROM mfa_state").all()).toEqual([{ policy: "required", enrollment_state: "required", secret_generation: 0 }]);
    expect(connection.handle.prepare("SELECT session_id, assurance, password_verified_at_ms, access_epoch FROM session_ext").all()).toEqual([
      { session_id: "s1", assurance: "password", password_verified_at_ms: T0, access_epoch: 3 },
    ]);
    // A session that is not the owner's does not survive the migration.
    expect(connection.handle.prepare("SELECT id FROM session").all()).toEqual([{ id: "s1" }]);
  });

  it("the database refuses a totp session without a TOTP time, an unknown assurance and a half-set factor", async () => {
    const r = await rigOf();
    await passwordSession(r);
    const exec = (sql: string): void => void r.connection.handle.exec(sql);
    expect(() => exec(`UPDATE session_ext SET assurance = 'totp'`)).toThrow(/constraint/i);
    expect(() => exec(`UPDATE session_ext SET assurance = 'admin'`)).toThrow(/constraint/i);
    expect(() => exec(`UPDATE mfa_state SET secret_generation = 1`)).toThrow(/constraint/i);
    expect(() => exec(`UPDATE mfa_state SET pending_challenge_id = 'x'`)).toThrow(/constraint/i);
    expect(() => exec(`INSERT INTO mfa_state (singleton, owner_id, policy, enrollment_state, secret_generation) VALUES (2, 'owner-1', 'required', 'required', 0)`)).toThrow(/constraint/i);
  });

  describe("an integration that does not behave as assumed blocks the start (AUTH_MFA_INCOMPATIBLE)", () => {
    it("the pinned libraries and runtime pass", async () => {
      expect(await checkMfaIntegration()).toEqual({ ok: true });
      expect(readFileSync(path.join(process.cwd(), "pnpm-workspace.yaml"), "utf8")).toMatch(/^ {2}"@better-auth\/utils": 0\.5\.1$/m);
    });

    const hotpOf = (codes: readonly string[]) => (() => ({ hotp: async (counter: number) => codes[counter] ?? "000000", url: () => "otpauth://", totp: async () => "", verify: async () => false })) as unknown as typeof createOTP;

    it("a library without HOTP or URI, with other codes, or not a function; a runtime without AES-256-GCM", async () => {
      expect(await checkMfaIntegration((() => ({})) as unknown as typeof createOTP)).toEqual({ ok: false, code: "AUTH_MFA_INCOMPATIBLE", fields: ["otp.hotp", "otp.url"] });
      expect(await checkMfaIntegration(hotpOf(["755224", "000001"]))).toEqual({ ok: false, code: "AUTH_MFA_INCOMPATIBLE", fields: ["otp.hotp.rfc4226"] });
      expect(await checkMfaIntegration(hotpOf(["755224", "287082"]), () => ["aes-128-cbc"])).toEqual({ ok: false, code: "AUTH_MFA_INCOMPATIBLE", fields: ["crypto.aes-256-gcm"] });
      expect(await checkMfaIntegration(null as unknown as typeof createOTP)).toMatchObject({ ok: false, fields: ["otp.hotp", "otp.url"] });
    });
  });
});
