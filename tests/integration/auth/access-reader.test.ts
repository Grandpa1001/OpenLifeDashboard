// D10.2 — the IdentityAccessReader on a real database and the status over real HTTP
// (Architektura §9.7, §18.7). The reader maps what the database says to the snapshot of the
// policy; a missing row is the state that denies. The state of a complete second factor is
// arranged in SQL where D11 does not exist yet (the recovery acknowledgment, the data choice),
// everything else is built by the production use cases.
// AC1: the snapshot of each situation is read from the database and decided by the one policy;
//      the status the browser gets follows the same decision and the live database.
// AC2: nothing a client sends changes the actor or the decision; step-up freshness follows the
//      injected clock at its boundary; trust without a device is refused.
import path from "node:path";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { afterEach, describe, expect, it } from "vitest";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { createOwner, decideAccess, nextActionFor, signInWithPassword, STEP_UP_FRESH_MS, type IdentityAccessSnapshot } from "../../../packages/core/dist/modules/identity/public.js";
import { bindAppendAudit } from "../../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindIdentityAccessReader } from "../../../packages/sqlite/dist/adapters/identity/access-reader.js";
import { bindMfaStore } from "../../../packages/sqlite/dist/adapters/identity/mfa-store.js";
import { bindOwnerWriters } from "../../../packages/sqlite/dist/adapters/identity/owner-writers.js";
import { bindSignInStores } from "../../../packages/sqlite/dist/adapters/identity/sign-in-ports.js";
import { bindTrustedDeviceStore } from "../../../packages/sqlite/dist/adapters/identity/trusted-device-store.js";
import { openDatabase, type SqliteConnection } from "../../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../../packages/sqlite/dist/transactions/unit-of-work.js";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "../../support/server-process.ts";
import { scratchDir } from "../../support/scratch.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const INSTANCE_ID = "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d48";
const EMAIL = "owner@example.test";
const PASSWORD = "a passphrase for the reader";
const T0 = Date.parse("2026-10-26T12:00:00.000Z");
const hasher = createPasswordHasher();

const open: SqliteConnection[] = [];
const running: ServerProcess[] = [];
afterEach(async () => {
  for (const connection of open.splice(0)) if (connection.handle.open) connection.close();
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
});

const done = <T>(value: T) => ({ value, invalidations: [] });

async function rigOf(options: { owner?: boolean } = {}) {
  const clock = { now: T0 };
  const connection = openDatabase(path.join(scratchDir("openlife-access-"), "app.db"), { role: "writer", busyTimeoutMs: 5000 });
  open.push(connection);
  initializeDatabase(connection, PRODUCT_MIGRATION_PLAN, { instanceId: INSTANCE_ID, createdAt: new Date(T0).toISOString() });
  const unit = createUnitOfWork(connection, (tx) => ({
    ...bindSignInStores(tx),
    ...bindOwnerWriters(tx),
    owners: bindOwnerWriters(tx).owners,
    mfa: bindMfaStore(tx),
    trusted: bindTrustedDeviceStore(tx), access: bindIdentityAccessReader(tx, () => clock.now),
    audit: bindAppendAudit(tx),
  }));
  if (options.owner !== false) {
    expect(unit.run((ports) => createOwner(ports, { ownerId: "owner-1", email: EMAIL, passwordHash: "", requestId: "req-0", now: new Date(T0).toISOString() })).ok).toBe(true);
    connection.handle.prepare("UPDATE account SET password = ?").run(await hasher.hash(PASSWORD));
  }
  let sequence = 0;
  const signIn = async (): Promise<string> => {
    sequence += 1;
    const outcome = await signInWithPassword(
      { unit, verifier: hasher, decoyHash: "unused", nowMs: () => clock.now, newSessionId: () => `session-${sequence}`, newSessionToken: () => `token-${sequence}` },
      { email: EMAIL, password: PASSWORD, accountKey: `account-${sequence}`, ipKey: `ip-${sequence}`, ip: null, userAgent: null, requestId: `req-${sequence}`, trustedTokenHash: null },
    );
    if (outcome.kind !== "granted") throw new Error("not granted");
    return `session-${sequence}`;
  };
  const snapshot = (sessionId: string, patch: { ownerId?: string; accessEpoch?: number } = {}): IdentityAccessSnapshot => {
    const read = unit.run((ports) => done(ports.access.current({ ownerId: patch.ownerId ?? "owner-1", sessionId, requestId: "req", accessEpoch: patch.accessEpoch ?? 1 })));
    if (!read.ok) throw new Error("read failed");
    return read.value.value;
  };
  const sql = (statement: string): void => void connection.handle.exec(statement);
  return { clock, unit, signIn, snapshot, sql, connection };
}

const verdict = (snapshot: IdentityAccessSnapshot, clockMs: number, operation: "data" | "step_up" | "setup_data_choice" = "data"): string => {
  const decision = decideAccess(snapshot, operation, clockMs);
  return decision.allow ? "allow" : decision.code;
};

describe("D10.2-AC1 the snapshot is the database's, the decision is the policy's", () => {
  it("a password session of a new owner: active, MFA required, nothing enrolled, data not chosen", async () => {
    const r = await rigOf();
    const session = await r.signIn();
    expect(r.snapshot(session)).toEqual({
      ownerExists: true,
      ownerMatches: true,
      sessionState: "active",
      epochMatches: true,
      mfaPolicy: "required",
      enrollmentState: "required",
      assurance: "password",
      trustedState: "not_used",
      dataChoice: "unselected",
      totpVerifiedAtMs: null,
      passwordVerifiedAtMs: T0,
    });
    expect(verdict(r.snapshot(session), T0)).toBe("MFA_REQUIRED");
    expect(nextActionFor(r.snapshot(session), T0)).toBe("mfa_enrollment");
  });

  it("the stages of a TOTP session follow the database: acknowledgment, data choice, then data and step-up", async () => {
    const r = await rigOf();
    const old = await r.signIn();
    // A promoted session as the prototype of D10.1 makes it; the acknowledgment and the choice are D11.
    r.sql(`UPDATE session_ext SET assurance = 'totp', totp_verified_at_ms = ${T0} WHERE session_id = '${old}';
           UPDATE mfa_state SET secret_generation = 1, active_secret = 'v1.x.y', enrollment_state = 'awaiting_recovery_ack';`);
    expect(verdict(r.snapshot(old), T0)).toBe("RECOVERY_ACK_REQUIRED");
    expect(nextActionFor(r.snapshot(old), T0)).toBe("recovery_ack");

    r.sql(`UPDATE mfa_state SET enrollment_state = 'complete';`);
    expect(verdict(r.snapshot(old), T0)).toBe("SETUP_DATA_REQUIRED");
    expect(verdict(r.snapshot(old), T0, "setup_data_choice")).toBe("allow");
    expect(nextActionFor(r.snapshot(old), T0)).toBe("setup_data");

    r.sql(`UPDATE instance_state SET data_choice = 'empty';`);
    expect(verdict(r.snapshot(old), T0)).toBe("allow");
    expect(nextActionFor(r.snapshot(old), T0)).toBe("ready");
    // The injected clock decides the step-up: exactly five minutes after the TOTP, and one ms later.
    expect(verdict(r.snapshot(old), T0 + STEP_UP_FRESH_MS, "step_up")).toBe("allow");
    expect(verdict(r.snapshot(old), T0 + STEP_UP_FRESH_MS + 1, "step_up")).toBe("STEP_UP_REQUIRED");
    expect(verdict(r.snapshot(old), T0 - 1, "step_up")).toBe("STEP_UP_REQUIRED");
    r.sql(`UPDATE instance_state SET data_choice = 'imported';`);
    expect(verdict(r.snapshot(old), T0, "setup_data_choice")).toBe("SETUP_DATA_ALREADY_CHOSEN");
  });

  it("a password session of an enrolled owner is asked for the second factor again", async () => {
    const r = await rigOf();
    const session = await r.signIn();
    r.sql(`UPDATE mfa_state SET secret_generation = 1, active_secret = 'v1.x.y', enrollment_state = 'complete'; UPDATE instance_state SET data_choice = 'empty';`);
    expect(verdict(r.snapshot(session), T0)).toBe("MFA_REQUIRED");
    expect(nextActionFor(r.snapshot(session), T0)).toBe("mfa_challenge");
  });

  it("a reset and a switched-off factor are policies of the database, not of the session", async () => {
    const r = await rigOf();
    const session = await r.signIn();
    r.sql(`UPDATE instance_state SET data_choice = 'empty'; UPDATE mfa_state SET policy = 'reset_required';`);
    expect(verdict(r.snapshot(session), T0)).toBe("MFA_REQUIRED");
    r.sql(`UPDATE mfa_state SET policy = 'disabled';`);
    expect(verdict(r.snapshot(session), T0)).toBe("allow");
    // With MFA off the password is the proof: fresh for five minutes.
    expect(verdict(r.snapshot(session), T0 + STEP_UP_FRESH_MS, "step_up")).toBe("allow");
    expect(verdict(r.snapshot(session), T0 + STEP_UP_FRESH_MS + 1, "step_up")).toBe("STEP_UP_REQUIRED");
  });

  it("a revoked, an expired and a rotated session, a stale epoch and a foreign owner are all AUTH_REQUIRED", async () => {
    const r = await rigOf();
    const revoked = await r.signIn();
    r.sql(`DELETE FROM "session" WHERE id = '${revoked}';`);
    expect(r.snapshot(revoked).sessionState).toBe("revoked");
    expect(verdict(r.snapshot(revoked), T0)).toBe("AUTH_REQUIRED");

    const expired = await r.signIn();
    r.clock.now = T0 + 30 * 24 * 3600 * 1000;
    expect(r.snapshot(expired).sessionState).toBe("expired");
    expect(verdict(r.snapshot(expired), r.clock.now)).toBe("AUTH_REQUIRED");

    r.clock.now = T0;
    const stale = await r.signIn();
    r.sql(`UPDATE instance_state SET access_epoch = 2;`);
    expect(r.snapshot(stale, { accessEpoch: 1 }).epochMatches).toBe(false);
    expect(verdict(r.snapshot(stale, { accessEpoch: 1 }), T0)).toBe("AUTH_REQUIRED");
    // The actor claiming the new epoch does not help: the session row carries the old one.
    expect(r.snapshot(stale, { accessEpoch: 2 }).epochMatches).toBe(false);
    r.sql(`UPDATE instance_state SET access_epoch = 1;`);

    const live = await r.signIn();
    expect(r.snapshot(live, { ownerId: "someone-else" }).ownerMatches).toBe(false);
    expect(verdict(r.snapshot(live, { ownerId: "someone-else" }), T0)).toBe("AUTH_REQUIRED");
    expect(r.snapshot("session-that-never-existed").sessionState).toBe("revoked");
  });

  it("a session of a user who is not the owner is refused, and so is any session when there is no owner", async () => {
    const r = await rigOf();
    r.sql(`INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('foreign', 'F', 'f@example.test', 0, NULL, 'x', 'x');
           INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES ('s-foreign', '2999-01-01T00:00:00.000Z', 't', 'x', 'x', NULL, NULL, 'foreign');
           INSERT INTO session_ext (session_id, assurance, password_verified_at_ms, totp_verified_at_ms, access_epoch) VALUES ('s-foreign', 'totp', ${T0}, ${T0}, 1);`);
    const snapshot = r.snapshot("s-foreign", { ownerId: "foreign" });
    expect(snapshot.ownerMatches).toBe(false);
    expect(verdict(snapshot, T0)).toBe("AUTH_REQUIRED");

    const empty = await rigOf({ owner: false });
    expect(empty.snapshot("anything")).toMatchObject({ ownerExists: false, ownerMatches: false, sessionState: "revoked", mfaPolicy: "reset_required", enrollmentState: "required" });
    expect(verdict(empty.snapshot("anything"), T0)).toBe("AUTH_REQUIRED");
    expect(nextActionFor(empty.snapshot("anything"), T0)).toBe("create_owner");
  });

  it("trust without a device store is refused: a trusted session reads as revoked trust and does not open the data", async () => {
    const r = await rigOf();
    const session = await r.signIn();
    r.sql(`UPDATE instance_state SET data_choice = 'empty'; UPDATE mfa_state SET secret_generation = 1, active_secret = 'v1.x.y', enrollment_state = 'complete';
           UPDATE session_ext SET assurance = 'trusted' WHERE session_id = '${session}';`);
    expect(r.snapshot(session)).toMatchObject({ assurance: "trusted", trustedState: "revoked" });
    expect(verdict(r.snapshot(session), T0)).toBe("MFA_REQUIRED");
  });

  it("the reader changes nothing", async () => {
    const r = await rigOf();
    const session = await r.signIn();
    const before = r.connection.handle.prepare("SELECT total_changes()").pluck().get();
    for (let read = 0; read < 3; read += 1) r.snapshot(session);
    expect(r.connection.handle.prepare("SELECT total_changes()").pluck().get()).toBe(before);
  });
});

describe("D10.2-AC2 the status over HTTP follows the database; a client cannot supply the context", () => {
  const ORIGIN = "http://localhost:8080";
  const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");

  async function ownerServer(): Promise<{ instance: TestInstance; server: ServerProcess }> {
    const instance = await startedInstallation();
    const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: EMAIL, password: PASSWORD }));
    expect(created.code, created.output).toBe(0);
    const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env } });
    running.push(server);
    return { instance, server };
  }

  const status = async (server: ServerProcess, init: { headers?: Record<string, string>; query?: string } = {}) => {
    const response = await fetch(`${server.baseUrl}/api/v1/identity/status${init.query ?? ""}`, { headers: init.headers ?? {} });
    return identityStatusSchema.parse(await response.json());
  };
  const signIn = (server: ServerProcess) =>
    fetch(`${server.baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });

  it("sign-in and status say what the policy says; a change in the database shows at the next request", async () => {
    const { instance, server } = await ownerServer();
    const granted = await signIn(server);
    expect(identityStatusSchema.parse(await granted.json())).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    const cookie = granted.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    expect(await status(server, { headers: { Cookie: cookie } })).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });

    // The owner enrolled elsewhere (arranged in SQL, D11 does it): the very next status asks for the factor.
    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec(`UPDATE mfa_state SET secret_generation = 1, active_secret = 'v1.x.y', enrollment_state = 'complete'`);
    expect(await status(server, { headers: { Cookie: cookie } })).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    // A raised epoch ends the session at once: the cookie is still well formed, the answer is "not authenticated".
    writer.handle.exec(`UPDATE instance_state SET access_epoch = 2`);
    expect(await status(server, { headers: { Cookie: cookie } })).toEqual({ authenticated: false, nextAction: "login" });
    writer.close();
  });

  it("claims in headers, the query and extra cookies change neither the actor nor the decision", async () => {
    const { server } = await ownerServer();
    const cookie = (await signIn(server)).headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const claims = {
      "X-Owner-Id": "owner-1",
      "X-Session-Id": "session-1",
      "X-Actor": JSON.stringify({ ownerId: "owner-1", assurance: "totp", accessEpoch: 1 }),
      "X-Assurance": "totp",
      Authorization: "Bearer anything",
      "X-Forwarded-User": "owner@example.test",
    };
    const query = "?assurance=totp&ownerId=owner-1&sessionId=x&totpVerifiedAtMs=1&nextAction=ready";
    // Without a session the claims authenticate nobody.
    expect(await status(server, { headers: claims, query })).toEqual({ authenticated: false, nextAction: "login" });
    // With a real password session they do not raise it.
    expect(await status(server, { headers: { ...claims, Cookie: `${cookie}; assurance=totp; mfa=ok` }, query })).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
  });
});
