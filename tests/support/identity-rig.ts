// A real database file with the identity ports of the production adapters, an owner created by
// the production use case and a controlled clock (DEV §8.3). Tests build on it instead of each
// wiring its own: the sign-in, MFA and access tests all share this composition.
import path from "node:path";
import { createPasswordHasher } from "../../apps/server/dist/adapters/auth/password-hasher.js";
import { createOwner, signInWithPassword, type IdentityAccessSnapshot, type SessionFacts } from "../../packages/core/dist/modules/identity/public.js";
import { bindAppendAudit } from "../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindIdentityAccessReader } from "../../packages/sqlite/dist/adapters/identity/access-reader.js";
import { bindMfaStore } from "../../packages/sqlite/dist/adapters/identity/mfa-store.js";
import { bindOwnerWriters } from "../../packages/sqlite/dist/adapters/identity/owner-writers.js";
import { bindSignInStores } from "../../packages/sqlite/dist/adapters/identity/sign-in-ports.js";
import { openDatabase, type SqliteConnection } from "../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../packages/sqlite/dist/transactions/unit-of-work.js";
import { scratchDir } from "./scratch.ts";

export const RIG_INSTANCE_ID = "4f7d2c9e-8a31-4b6e-9d0f-2c5a7e1b3d48";
export const RIG_EMAIL = "owner@example.test";
export const RIG_PASSWORD = "a passphrase for the rig";
export const RIG_T0 = Date.parse("2026-10-26T12:00:07.000Z");

const hasher = createPasswordHasher();
export const done = <T>(value: T) => ({ value, invalidations: [] });

export type IdentityRig = Awaited<ReturnType<typeof createIdentityRig>>;

/** Connections opened by rigs are closed by `closeRigs`, called from the test's afterEach. */
const opened: SqliteConnection[] = [];
export function closeRigs(): void {
  for (const connection of opened.splice(0)) if (connection.handle.open) connection.close();
}

export async function createIdentityRig(options: { owner?: boolean } = {}) {
  const file = path.join(scratchDir("openlife-rig-"), "app.db");
  const clock = { now: RIG_T0 };
  let connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
  opened.push(connection);
  initializeDatabase(connection, PRODUCT_MIGRATION_PLAN, { instanceId: RIG_INSTANCE_ID, createdAt: new Date(RIG_T0).toISOString() });
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
  if (options.owner !== false) {
    const created = unit.run((ports) => createOwner(ports, { ownerId: "owner-1", email: RIG_EMAIL, passwordHash: "", requestId: "req-0", now: new Date(clock.now).toISOString() }));
    if (!created.ok) throw new Error("the rig could not create its owner");
    connection.handle.prepare("UPDATE account SET password = ?").run(await hasher.hash(RIG_PASSWORD));
  }
  let sequence = 0;
  return {
    file,
    clock,
    get connection(): SqliteConnection {
      return connection;
    },
    get unit() {
      return unit;
    },
    /** A restart: the connection is closed and the file opened again. */
    reopen(): void {
      connection.close();
      connection = openDatabase(file, { role: "writer", busyTimeoutMs: 5000 });
      opened.push(connection);
      unit = unitOn(connection);
    },
    /** Signs the owner in through the production use case; returns the token and the session id. */
    async signIn(): Promise<{ token: string; sessionId: string }> {
      sequence += 1;
      const tag = String(sequence);
      const outcome = await signInWithPassword(
        { unit, verifier: hasher, decoyHash: "unused", nowMs: () => clock.now, newSessionId: () => `session-${tag}`, newSessionToken: () => `token-${tag}` },
        { email: RIG_EMAIL, password: RIG_PASSWORD, accountKey: `account-${tag}`, ipKey: `ip-${tag}`, ip: "127.0.0.1", userAgent: "vitest", requestId: `req-${tag}` },
      );
      if (outcome.kind !== "granted") throw new Error("the rig session was not granted");
      return { token: outcome.token, sessionId: `session-${tag}` };
    },
    facts(token: string): SessionFacts | null {
      return unit.read((ports) => ports.sessions.findActive(token, clock.now));
    },
    snapshot(sessionId: string, actor: { ownerId?: string; accessEpoch?: number } = {}): IdentityAccessSnapshot {
      return unit.read((ports) => ports.access.current({ ownerId: actor.ownerId ?? "owner-1", sessionId, requestId: "req", accessEpoch: actor.accessEpoch ?? 1 }));
    },
    mfa() {
      return unit.read((ports) => ports.mfa.read());
    },
    rows: <T>(sql: string): T[] => connection.handle.prepare(sql).all() as T[],
    sql: (statement: string): void => void connection.handle.exec(statement),
  };
}
