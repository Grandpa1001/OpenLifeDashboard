// D10.3 — the adapters that make the second factor safe, on a real database file (Architektura
// §9.7, §9.8). The steps are those of tests/support/mfa-prototype.ts; the adapters and the
// database are the production ones; time is controlled.
// AC1: of parallel requests with the same TOTP step exactly one promotes (the replay ledger is a
//      compare-and-set), steps only move forward, and key, generation and nonce of the sealed
//      secret are checked.
// AC2: a failing audit rolls back the consumption of the step and the promotion, and no new
//      session exists before the commit; reading a session writes nothing, also while the
//      database refuses writes (maintenance); a database of an earlier version migrates with its
//      owner, sessions and audit intact.
import path from "node:path";
import { betterAuth } from "better-auth";
import { makeSignature } from "better-auth/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix, createAuthOptions } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { createSecretBox } from "../../../apps/server/dist/adapters/auth/secret-box.js";
import { totpStepAt } from "../../../apps/server/dist/adapters/auth/totp.js";
import { decideAccess, readIdentityStatus, signOut } from "../../../packages/core/dist/modules/identity/public.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, migrateDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { closeRigs, createIdentityRig, done, RIG_INSTANCE_ID, RIG_T0 as T0, type IdentityRig } from "../../support/identity-rig.ts";
import { activateSecret, beginEnrollment, box, codeAt, confirmEnrollment, promoteWithTotp, PROTOTYPE_KEY } from "../../support/mfa-prototype.ts";
import { scratchDir } from "../../support/scratch.ts";

const opened: SqliteConnection[] = [];
afterEach(() => {
  closeRigs();
  for (const connection of opened.splice(0)) if (connection.handle.open) connection.close();
});

const mfaRows = (r: IdentityRig) => r.rows<{ last_used_step: number | null }>("SELECT last_used_step FROM mfa_state")[0]?.last_used_step ?? null;
const auditCount = (r: IdentityRig, action: string): number => r.rows<{ n: number }>(`SELECT count(*) AS n FROM audit_log WHERE action = '${action}'`)[0]?.n ?? -1;

/** A barrier: every request that reaches it waits until `parties` have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

describe("D10.3-AC1 one step, one promotion", () => {
  it("two requests with the same code both pass the verification, and exactly one promotes", async () => {
    const r = await createIdentityRig();
    const secret = activateSecret(r);
    const first = await r.signIn();
    const second = await r.signIn();
    const step = totpStepAt(r.clock.now);
    const code = await codeAt(secret, step);
    const meeting = barrier(2);

    const results = await Promise.all([
      promoteWithTotp(r, first.token, code, "totp-a", meeting),
      promoteWithTotp(r, second.token, code, "totp-b", meeting),
    ]);
    expect([...results].sort()).toEqual(["promoted", "replayed"]);
    const winner = results[0] === "promoted" ? { old: first, token: "totp-a", loser: second } : { old: second, token: "totp-b", loser: first };
    expect(mfaRows(r)).toBe(step);
    expect(r.facts(winner.token)).toMatchObject({ assurance: "totp", totpVerifiedAtMs: r.clock.now });
    expect(r.facts(winner.old.token)).toBeNull();
    // The loser is refused whole: its session is still the password session it was, no second TOTP session exists.
    expect(r.facts(winner.loser.token)).toMatchObject({ assurance: "password", totpVerifiedAtMs: null });
    expect(r.rows<{ n: number }>("SELECT count(*) AS n FROM session_ext WHERE assurance = 'totp'")[0]?.n).toBe(1);
    expect(auditCount(r, "mfa.verified")).toBe(1);
  });

  it("the same session double-submitted: one promotion, and the loser holds no cookie to issue", async () => {
    const r = await createIdentityRig();
    const secret = activateSecret(r);
    const session = await r.signIn();
    const code = await codeAt(secret, totpStepAt(r.clock.now));
    const meeting = barrier(2);
    const results = await Promise.all([promoteWithTotp(r, session.token, code, "totp-a", meeting), promoteWithTotp(r, session.token, code, "totp-b", meeting)]);
    expect([...results].sort()).toEqual(["promoted", "replayed"]);
    expect(r.rows<{ n: number }>("SELECT count(*) AS n FROM session")[0]?.n).toBe(1);
  });

  it("a consumed step cannot be used again, a later step can, and an earlier step cannot after a later one", async () => {
    const r = await createIdentityRig();
    const secret = activateSecret(r);
    const step = totpStepAt(r.clock.now);
    const first = await r.signIn();
    expect(await promoteWithTotp(r, first.token, await codeAt(secret, step), "totp-1")).toBe("promoted");
    const again = await r.signIn();
    expect(await promoteWithTotp(r, again.token, await codeAt(secret, step), "totp-2")).toBe("replayed");
    // The next step is accepted when the clock reaches the window of it; the one before it is not.
    r.clock.now += 30_000;
    expect(await promoteWithTotp(r, again.token, await codeAt(secret, step), "totp-3")).toBe("replayed");
    expect(await promoteWithTotp(r, again.token, await codeAt(secret, step + 1), "totp-4")).toBe("promoted");
    expect(mfaRows(r)).toBe(step + 1);
  });

  it("the ledger is a compare-and-set: the generation must be the active one and the step strictly greater", async () => {
    const r = await createIdentityRig();
    const consume = (expectedGeneration: number, step: number): boolean => {
      const run = r.unit.run((ports) => done(ports.mfa.consumeStep({ expectedGeneration, step })));
      return run.ok && run.value.value;
    };
    // No active secret: nothing to consume against.
    expect(consume(0, 5)).toBe(false);
    activateSecret(r, 2);
    expect(consume(1, 5)).toBe(false);
    expect(consume(2, 5)).toBe(true);
    expect(consume(2, 5)).toBe(false);
    expect(consume(2, 4)).toBe(false);
    expect(consume(2, 6)).toBe(true);
    expect(mfaRows(r)).toBe(6);
  });

  it("a new secret generation starts a new ledger: the replay of the old generation does not carry over", async () => {
    const r = await createIdentityRig();
    activateSecret(r, 1);
    r.unit.run((ports) => done(ports.mfa.consumeStep({ expectedGeneration: 1, step: 100 })));
    expect(mfaRows(r)).toBe(100);
    // A rotated secret (reset and a new enrollment) resets its ledger with the generation.
    r.sql("UPDATE mfa_state SET last_used_step = NULL");
    activateSecret(r, 2);
    expect(r.unit.run((ports) => done(ports.mfa.consumeStep({ expectedGeneration: 2, step: 50 }))).ok).toBe(true);
    expect(mfaRows(r)).toBe(50);
  });

  it("key, generation and nonce of the sealed secret are all checked: a secret sealed for the wrong generation never confirms", async () => {
    const r = await createIdentityRig();
    const session = await r.signIn();
    // Sealed for generation 0 instead of 1: opening for the generation it will have fails and nothing changes.
    const { secret } = beginEnrollment(r, "challenge-1", 0);
    expect(await confirmEnrollment(r, session.token, "challenge-1", await codeAt(secret, totpStepAt(r.clock.now)), "totp-1")).toBeNull();
    expect(r.mfa()).toMatchObject({ secretGeneration: 0, activeSecret: null });
    expect(r.facts(session.token)?.assurance).toBe("password");

    // A well sealed one confirms; the same envelope opens only for generation 1 and only with the key.
    const good = beginEnrollment(r, "challenge-2");
    expect(await confirmEnrollment(r, session.token, "challenge-2", await codeAt(good.secret, totpStepAt(r.clock.now)), "totp-2")).toBe("totp-2");
    const active = r.mfa()?.activeSecret ?? "";
    expect(box.open(active, { ownerId: "owner-1", generation: 1 })).toBe(good.secret);
    expect(box.open(active, { ownerId: "owner-1", generation: 0 })).toBeNull();
    expect(box.open(active, { ownerId: "owner-1", generation: 2 })).toBeNull();
    expect(createSecretBox("0b1d3f5a7c9e1b3d5f7a9c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b9d").open(active, { ownerId: "owner-1", generation: 1 })).toBeNull();
    expect(createSecretBox(PROTOTYPE_KEY).open(active, { ownerId: "owner-1", generation: 1 })).toBe(good.secret);
  });

  it("every envelope has its own 96-bit nonce", () => {
    const nonces = new Set<string>();
    for (let seal = 0; seal < 2000; seal += 1) {
      const [, nonce = ""] = box.seal("the same secret", { ownerId: "owner-1", generation: 1 }).split(".");
      expect(Buffer.from(nonce, "base64url")).toHaveLength(12);
      nonces.add(nonce);
    }
    expect(nonces.size).toBe(2000);
  });
});

describe("D10.3-AC2 atomic with the audit, and reads write nothing", () => {
  const failAudit = (r: IdentityRig, action: string): void =>
    r.sql(`CREATE TRIGGER fail_${action.replace(".", "_")} BEFORE INSERT ON audit_log WHEN new.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

  it("a failing audit rolls back the consumed step and the promotion: no new session, the step is still usable", async () => {
    const r = await createIdentityRig();
    const secret = activateSecret(r);
    const session = await r.signIn();
    const code = await codeAt(secret, totpStepAt(r.clock.now));
    failAudit(r, "mfa.verified");

    await expect(promoteWithTotp(r, session.token, code, "totp-1")).rejects.toThrow();
    expect(mfaRows(r)).toBeNull();
    expect(r.facts("totp-1")).toBeNull();
    expect(r.facts(session.token)).toMatchObject({ assurance: "password", totpVerifiedAtMs: null });
    expect(auditCount(r, "mfa.verified")).toBe(0);

    // The code was not consumed: once the audit works again the very same code promotes.
    r.sql("DROP TRIGGER fail_mfa_verified");
    expect(await promoteWithTotp(r, session.token, code, "totp-1")).toBe("promoted");
    expect(r.facts("totp-1")?.assurance).toBe("totp");
  });

  it("a failing audit rolls back an enrollment: the pending secret stays, nothing is active, the old session lives", async () => {
    const r = await createIdentityRig();
    const session = await r.signIn();
    const { secret } = beginEnrollment(r, "challenge-1");
    const code = await codeAt(secret, totpStepAt(r.clock.now));
    failAudit(r, "mfa.enrolled");
    await expect(confirmEnrollment(r, session.token, "challenge-1", code, "totp-1")).rejects.toThrow();
    expect(r.mfa()).toMatchObject({ secretGeneration: 0, activeSecret: null, lastUsedStep: null });
    expect(r.mfa()?.pending?.challengeId).toBe("challenge-1");
    expect(r.facts("totp-1")).toBeNull();
    expect(r.facts(session.token)?.assurance).toBe("password");
  });

  it("a session that ends between the verification and the commit rolls the consumed step back", async () => {
    const r = await createIdentityRig();
    const secret = activateSecret(r);
    const session = await r.signIn();
    const code = await codeAt(secret, totpStepAt(r.clock.now));
    await expect(
      promoteWithTotp(r, session.token, code, "totp-1", async () => {
        r.unit.run((ports) => done(ports.sessions.deleteByToken(session.token)));
      }),
    ).rejects.toThrow();
    expect(mfaRows(r)).toBeNull();
    expect(r.facts("totp-1")).toBeNull();
  });

  it("while the database refuses writes, reading a session, its access and the status write nothing and still answer", async () => {
    const r = await createIdentityRig();
    const valid = await r.signIn();
    const aging = await r.signIn();
    r.connection.handle.pragma("query_only = ON");
    const before = r.connection.handle.prepare("SELECT total_changes()").pluck().get();

    expect(r.facts(valid.token)).toMatchObject({ assurance: "password" });
    expect(r.snapshot(valid.sessionId).sessionState).toBe("active");
    expect(readIdentityStatus(r.unit, valid.token, r.clock.now)).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    // An expired session is only reported as ended: nothing deletes it on the way.
    const later = r.clock.now + 30 * 24 * 3600 * 1000;
    expect(readIdentityStatus(r.unit, aging.token, later)).toEqual({ authenticated: false, nextAction: "login" });
    expect(readIdentityStatus(r.unit, "not-a-token", r.clock.now)).toEqual({ authenticated: false, nextAction: "login" });
    expect(decideAccess(r.snapshot(aging.sessionId), "data", later).allow).toBe(false);

    expect(r.connection.handle.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    expect(r.rows<{ n: number }>("SELECT count(*) AS n FROM session")[0]?.n).toBe(2);
    // The guard is real: a write is refused, so a hidden write on a read path would have failed above.
    expect(() => signOut(r.unit, valid.token)).toThrow(/readonly|read-only|query_only/i);
  });

  it("the library cannot refresh or clean a session under the options of the product, also without the right to write", async () => {
    const r = await createIdentityRig();
    const session = await r.signIn();
    const authSecret = "5a0c9f3e7d21b8a64c0e9f1d3b7a5c2e8f4d6b0a1c3e5f7092b4d6f8a0c2e4f6";
    const options = createAuthOptions({ hasher: createPasswordHasher(), baseUrl: "http://127.0.0.1:8080", secret: authSecret, instanceId: RIG_INSTANCE_ID });
    const auth = betterAuth({ ...options, database: r.connection.handle });
    const cookie = `${authCookiePrefix(RIG_INSTANCE_ID)}.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, authSecret)}`)}`;
    // A session of this age would be refreshed by the library's defaults (updateAge); the product disables it.
    r.sql(`UPDATE "session" SET updatedAt = '2020-01-01T00:00:00.000Z', createdAt = '2020-01-01T00:00:00.000Z' WHERE id = '${session.sessionId}'`);
    r.connection.handle.pragma("query_only = ON");
    const before = r.connection.handle.prepare("SELECT total_changes()").pluck().get();
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.session.id).toBe(session.sessionId);
    expect(r.connection.handle.prepare("SELECT total_changes()").pluck().get()).toBe(before);
    expect(options.session?.disableSessionRefresh).toBe(true);
  });
});

describe("D10.3 a database of an earlier version migrates with its owner, sessions and audit intact", () => {
  const OWNER_SESSION_VERSIONS = [3, 4, 5] as const;

  for (const version of OWNER_SESSION_VERSIONS) {
    it(`from version ${version}: the owner's session survives as a password session, the factor is not enrolled, the access reader reads it`, () => {
      const file = path.join(scratchDir("openlife-migrate-"), "app.db");
      const connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
      opened.push(connection);
      initializeDatabase(connection, PRODUCT_MIGRATION_PLAN.slice(0, version), { instanceId: RIG_INSTANCE_ID, createdAt: new Date(T0).toISOString() });
      const now = new Date(T0).toISOString();
      connection.handle.exec(`
        INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('owner-1', 'Owner', 'owner@example.test', 1, NULL, '${now}', '${now}');
        INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('owner-1', 'owner-1', 'credential', 'owner-1', 'hash', '${now}', '${now}');
        INSERT INTO instance_state (singleton, owner_id, access_epoch, owner_created_at) VALUES (1, 'owner-1', 2, '${now}');
        INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id) VALUES ('${now}', 'owner-1', 'owner.created', 'owner', 'owner-1', 'req-0');
      `);
      if (version >= 3) {
        connection.handle.exec(`INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES ('s1', '2999-01-01T00:00:00.000Z', 't1', '${now}', '${now}', NULL, NULL, 'owner-1')`);
      }
      if (version >= 5) {
        connection.handle.exec(`INSERT INTO session_ext (session_id, assurance, password_verified_at_ms, access_epoch) VALUES ('s1', 'password', ${T0}, 2)`);
        connection.handle.exec(`INSERT INTO mfa_state (singleton, owner_id, policy, enrollment_state, secret_generation) VALUES (1, 'owner-1', 'required', 'required', 0)`);
      }

      migrateDatabase(connection, PRODUCT_MIGRATION_PLAN, now);
      expect(connection.handle.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(connection.handle.pragma("foreign_key_check")).toEqual([]);
      expect(connection.handle.prepare("SELECT max(version) FROM schema_migration").pluck().get()).toBe(PRODUCT_MIGRATION_PLAN.length);
      expect(connection.handle.prepare("SELECT action FROM audit_log").all()).toEqual([{ action: "owner.created" }]);
      expect(connection.handle.prepare("SELECT owner_id, access_epoch, data_choice FROM instance_state").all()).toEqual([{ owner_id: "owner-1", access_epoch: 2, data_choice: "unselected" }]);
      expect(connection.handle.prepare("SELECT policy, enrollment_state, secret_generation FROM mfa_state").all()).toEqual([{ policy: "required", enrollment_state: "required", secret_generation: 0 }]);
      expect(connection.handle.prepare("SELECT session_id, assurance, access_epoch FROM session_ext").all()).toEqual([{ session_id: "s1", assurance: "password", access_epoch: 2 }]);
    });
  }
});
