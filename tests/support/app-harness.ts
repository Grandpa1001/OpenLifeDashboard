// The real HTTP application of apps/server, composed in the test process on a real database file
// (D13.2). It exists for one thing the black-box tests cannot do: stop a request between its
// middleware and its unit of work and let something else happen first (a sign-out, a change of the
// access epoch). The stop is a hook on the unit of work, owned by this harness; no production code
// has a test entry point. Everything else is the production composition of apps/server/src/main.ts.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { createApp } from "../../apps/server/dist/bootstrap/create-app.js";
import { createReadiness } from "../../apps/server/dist/bootstrap/readiness.js";
import { createAttemptKeys } from "../../apps/server/dist/adapters/auth/attempt-keys.js";
import { createMfaCrypto } from "../../apps/server/dist/adapters/auth/mfa-crypto.js";
import { createPasswordHasher } from "../../apps/server/dist/adapters/auth/password-hasher.js";
import { createSessionCookies, createTrustedDeviceCookies } from "../../apps/server/dist/adapters/auth/session-cookie.js";
import { createTechnicalLogger } from "../../apps/server/dist/adapters/logging/technical-logger.js";
import { createRateLimiter } from "../../apps/server/dist/http/middleware/fixed-window-limit.js";
import { createOwner } from "../../packages/core/dist/modules/identity/public.js";
import { bindAppendAudit } from "../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindIdentityAccessReader } from "../../packages/sqlite/dist/adapters/identity/access-reader.js";
import { bindMfaStore } from "../../packages/sqlite/dist/adapters/identity/mfa-store.js";
import { bindOwnerWriters } from "../../packages/sqlite/dist/adapters/identity/owner-writers.js";
import { bindRecoveryCodeStore } from "../../packages/sqlite/dist/adapters/identity/recovery-store.js";
import { bindSetupStateStore } from "../../packages/sqlite/dist/adapters/identity/setup-state.js";
import { bindSignInStores } from "../../packages/sqlite/dist/adapters/identity/sign-in-ports.js";
import { bindTrustedDeviceStore } from "../../packages/sqlite/dist/adapters/identity/trusted-device-store.js";
import { bindOwnerPreferencesStore } from "../../packages/sqlite/dist/adapters/settings/owner-preferences.js";
import { openDatabase, type SqliteConnection } from "../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../packages/sqlite/dist/transactions/unit-of-work.js";
import { scratchDir } from "./scratch.ts";

export const HARNESS_ORIGIN = "http://localhost:8080";
export const HARNESS_EMAIL = "owner@example.test";
export const HARNESS_PASSWORD = "a passphrase for the harness";
const INSTANCE_ID = "5a1e9c47-3b2d-4f60-8c1a-7d4e2b9f0a13";

const opened: SqliteConnection[] = [];
/** Closes every database a harness opened; call it from afterEach. */
export function closeHarnesses(): void {
  for (const connection of opened.splice(0)) if (connection.handle.open) connection.close();
}

export type HarnessReply = Readonly<{ status: number; text: string; json: () => unknown; setCookies: string[]; cookie: string | null }>;

export async function createAppHarness() {
  const dir = scratchDir("openlife-harness-");
  const connection = openDatabase(path.join(dir, "app.db"), { role: "writer", busyTimeoutMs: 5000 });
  opened.push(connection);
  initializeDatabase(connection, PRODUCT_MIGRATION_PLAN, { instanceId: INSTANCE_ID, createdAt: new Date().toISOString() });
  const inner = createUnitOfWork(connection, (tx) => ({
    ...bindSignInStores(tx),
    ...bindOwnerWriters(tx),
    mfa: bindMfaStore(tx),
    recovery: bindRecoveryCodeStore(tx),
    trusted: bindTrustedDeviceStore(tx),
    setup: bindSetupStateStore(tx),
    preferences: bindOwnerPreferencesStore(tx),
    access: bindIdentityAccessReader(tx, Date.now),
    audit: bindAppendAudit(tx),
  }));
  const hasher = createPasswordHasher();

  // The owner, through the production use case.
  const created = inner.run((ports) => createOwner(ports, { ownerId: "owner-1", email: HARNESS_EMAIL, passwordHash: "", requestId: "req-0", now: new Date().toISOString() }));
  if (!created.ok) throw new Error("the harness could not create its owner");
  connection.handle.prepare("UPDATE account SET password = ?").run(await hasher.hash(HARNESS_PASSWORD));

  /** Runs once, just before the next unit of work begins: the moment between a request's middleware and its commit. */
  let beforeNextRun: (() => void) | null = null;
  const unit = {
    run: ((work) => {
      const hook = beforeNextRun;
      beforeNextRun = null;
      hook?.();
      return inner.run(work);
    }) as typeof inner.run,
    read: inner.read.bind(inner),
  };

  const lines: string[] = [];
  const logger = createTechnicalLogger({ identity: { service: "openlife-harness", appVersion: "0.0.0", instanceId: INSTANCE_ID }, minLevel: "debug", now: () => new Date(), sinks: [{ write: (line: string) => void lines.push(line) }] });
  const secret = randomBytes(32).toString("hex");
  const keys = createAttemptKeys(secret);
  const cookies = createSessionCookies({ instanceId: INSTANCE_ID, secret });
  const trustedDeviceCookies = createTrustedDeviceCookies({ instanceId: INSTANCE_ID, secret });
  const mfaCrypto = createMfaCrypto(randomBytes(32).toString("hex"));
  const clientIp = () => "127.0.0.1";
  const common = { nowMs: Date.now, newId: randomUUID, newSessionToken: () => randomBytes(32).toString("base64url"), logger, allowedOrigin: HARNESS_ORIGIN, secureCookies: false, cookies, keys, clientIp };
  const app = createApp({
    webRoot: dir,
    indexHtml: "<!doctype html>",
    newRequestId: randomUUID,
    logger,
    readiness: createReadiness(),
    nowMs: () => performance.now(),
    identity: { ...common, unit, verifier: hasher, decoyHash: await hasher.hash("decoy"), trustedDevice: { cookies: trustedDeviceCookies, hash: mfaCrypto.hashTrustedDeviceToken }, loginLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000, nowMs: Date.now }) },
    mfaEnrollment: { ...common, unit, crypto: mfaCrypto },
    mfaVerification: { ...common, unit, crypto: mfaCrypto, trustedDeviceCookies },
    setup: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, logger },
  });

  async function request(method: string, route: string, body?: unknown, init: { cookie?: string | null; origin?: string | null } = {}): Promise<HarnessReply> {
    const headers: Record<string, string> = {};
    const origin = init.origin === undefined ? HARNESS_ORIGIN : init.origin;
    if (origin !== null) headers["Origin"] = origin;
    if (init.cookie) headers["Cookie"] = init.cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await app.request(route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const setCookies = response.headers.getSetCookie();
    return { status: response.status, text, json: () => JSON.parse(text) as unknown, setCookies, cookie: setCookies[0]?.split(";")[0] ?? null };
  }

  return {
    request,
    /** The technical log lines written so far. */
    logLines: (): readonly string[] => lines,
    /** The next unit of work starts only after `action` has run (once). */
    interruptNextWrite(action: () => void): void {
      beforeNextRun = action;
    },
    /** Something that happens elsewhere: a unit of work of its own. */
    elsewhere: inner,
    rows: <T>(sql: string): T[] => connection.handle.prepare(sql).all() as T[],
    sql: (statement: string): void => void connection.handle.exec(statement),
    connection,
  };
}

export type AppHarness = Awaited<ReturnType<typeof createAppHarness>>;
