// The real HTTP application of apps/server, composed in the test process on a real database file
// (D13.2). It exists for one thing the black-box tests cannot do: stop a request between its
// middleware and its unit of work and let something else happen first (a sign-out, a change of the
// access epoch). The stop is a hook on the unit of work, owned by this harness; no production code
// has a test entry point. Everything else is the production composition of apps/server/src/main.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
import { bindCatalogReader, bindConfigBindingCounts, bindDashboardStore, bindDependentWidgets } from "../../packages/sqlite/dist/adapters/dashboard/public.js";
import { bindDictionaryLookup, bindDictionaryStore } from "../../packages/sqlite/dist/adapters/dictionaries/public.js";
import { bindConfigStore } from "../../packages/sqlite/dist/adapters/configuration/public.js";
import { bindColumnDictionaryLinks, bindIdempotencyStore, bindRecordStore, bindRegistryStore, bindTableColumns, bindTableRebuild, bindRegistryTables } from "../../packages/sqlite/dist/adapters/registries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../packages/core/dist/modules/registries/public.js";
import { createWidgetCatalog } from "../../apps/server/dist/adapters/widget-catalog.js";
import { createStructurePlanSigner } from "../../apps/server/dist/adapters/structure-plan-signer.js";
import { createDatabaseSnapshots } from "../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openMaintenanceGate } from "../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { DESIGN_POLICY } from "../../apps/server/dist/bootstrap/design-policy.js";
import { sha256Hex } from "../../apps/server/dist/adapters/crypto/sha256-hex.js";
import { createUuidV7 } from "../../apps/server/dist/adapters/ids/uuid-v7.js";
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { createLiveHub } from "../../apps/server/dist/adapters/events/live-hub.js";
import { bindSystemTableReader } from "../../apps/server/dist/adapters/system-tables.js";
import { bindOwnerPreferencesStore } from "../../packages/sqlite/dist/adapters/settings/owner-preferences.js";
import { bindAppSettingStore } from "../../packages/sqlite/dist/adapters/settings/app-settings.js";
import { createEffectiveSettings } from "../../apps/server/dist/bootstrap/effective-settings.js";
import { liveLimits } from "../../apps/server/dist/bootstrap/live-limits.js";
import { resolveSettings } from "../../packages/core/dist/modules/settings/public.js";
import { SETTINGS_CATALOG } from "@openlife/contracts/settings";
import { openDatabase, type SqliteConnection } from "../../packages/sqlite/dist/connection/open-database.js";
import { initializeDatabase, PRODUCT_MIGRATION_PLAN } from "../../packages/sqlite/dist/migrations/public.js";
import { createUnitOfWork } from "../../packages/sqlite/dist/transactions/unit-of-work.js";
import { scratchDir } from "./scratch.ts";

export const HARNESS_ORIGIN = "http://localhost:8080";
export const HARNESS_EMAIL = "owner@example.test";
export const HARNESS_PASSWORD = "a passphrase for the harness";
const INSTANCE_ID = "5a1e9c47-3b2d-4f60-8c1a-7d4e2b9f0a13";

const opened: SqliteConnection[] = [];
const leases: Array<() => void> = [];
/** Closes every database a harness opened and releases its writer lease; call it from afterEach. */
export function closeHarnesses(): void {
  for (const connection of opened.splice(0)) if (connection.handle.open) connection.close();
  for (const release of leases.splice(0)) release();
}

export type HarnessReply = Readonly<{ status: number; text: string; json: () => unknown; setCookies: string[]; cookie: string | null }>;

/** `announce` replaces what the routes tell the streams after a commit, to try an announcement that fails (D38). */
export type HarnessOptions = Readonly<{
  pingIntervalMs?: number;
  streamsPerSession?: number;
  announce?: (event: LiveEvent) => void;
  /** Environment overrides of the options, by key: they lock the options they name (D41). */
  environment?: Readonly<Record<string, unknown>>;
}>;

export async function createAppHarness(options: HarnessOptions = {}) {
  const dir = scratchDir("openlife-harness-");
  // The writer lease and the maintenance gate as the bootstrap takes them, before the database exists.
  const workingPaths = { maintenance: path.join(dir, "maintenance"), database: path.join(dir, "app.db"), backups: path.join(dir, "backup") };
  mkdirSync(workingPaths.maintenance);
  mkdirSync(workingPaths.backups);
  const writer = acquireWriterLease(workingPaths.maintenance);
  if (!writer.ok) throw new Error(`the harness could not take the writer lease: ${writer.code}`);
  leases.push(() => writer.lease.release());
  const gate = openMaintenanceGate(writer.lease, workingPaths);
  if (!gate.ok) throw new Error(`the harness could not open the gate: ${gate.code}`);
  const connection = openDatabase(workingPaths.database, { role: "writer", busyTimeoutMs: 5000 });
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
    appSettings: bindAppSettingStore(tx),
    registries: bindRegistryStore(tx),
    records: bindRecordStore(tx),
    columns: bindTableColumns(tx),
    tables: bindRegistryTables(tx),
    rebuild: bindTableRebuild(tx),
    dictionaries: bindDictionaryStore(tx),
    dictionaryLookup: bindDictionaryLookup(tx),
    columnLinks: bindColumnDictionaryLinks(tx),
    config: bindConfigStore(tx),
    configBindings: bindConfigBindingCounts(tx),
    dashboard: bindDashboardStore(tx),
    catalog: bindCatalogReader(tx),
    dependents: bindDependentWidgets(tx),
    idempotency: bindIdempotencyStore(tx),
    access: bindIdentityAccessReader(tx, Date.now),
    audit: bindAppendAudit(tx),
    systemTables: bindSystemTableReader(tx),
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
  const planSigner = createStructurePlanSigner(randomBytes(32).toString("hex"));
  const structure = { unit, nowMs: Date.now, signer: planSigner, limits: DEFAULT_REGISTRY_LIMITS };
  const snapshots = createDatabaseSnapshots(connection, {
    backupsDir: workingPaths.backups,
    reserveMiB: 0,
    instanceId: INSTANCE_ID,
    build: { appVersion: "0.0.0", buildRevision: "harness", imageDigest: null },
    now: () => new Date().toISOString(),
    newSnapshotId: randomUUID,
  });
  // The effective options as the server composes them (D41.3): the limits below read them at each use.
  const environment = options.environment ?? {};
  const initial = resolveSettings(SETTINGS_CATALOG, { database: {}, environment });
  if (!initial.ok) throw new Error(`the harness environment does not fit the catalog: ${initial.fields.join(", ")}`);
  const effectiveSettings = createEffectiveSettings({ catalog: SETTINGS_CATALOG, environment, readStored: () => inner.read((ports) => ports.appSettings.readAll()), initial: initial.settings, onInvalid: () => undefined });
  const limits = liveLimits(effectiveSettings);
  const hub = createLiveHub({ perSession: options.streamsPerSession ?? 5 });
  const clientIp = () => "127.0.0.1";
  const common = { nowMs: Date.now, newId: randomUUID, newSessionToken: () => randomBytes(32).toString("base64url"), logger, allowedOrigin: HARNESS_ORIGIN, secureCookies: false, cookies, keys, clientIp };
  const app = createApp({
    webRoot: dir,
    indexHtml: "<!doctype html>",
    newRequestId: randomUUID,
    logger,
    readiness: createReadiness(),
    nowMs: () => performance.now(),
    identity: { ...common, onSessionEnded: hub.closeToken, unit, verifier: hasher, decoyHash: await hasher.hash("decoy"), trustedDevice: { cookies: trustedDeviceCookies, hash: mfaCrypto.hashTrustedDeviceToken }, loginLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000, nowMs: Date.now }) },
    mfaEnrollment: { ...common, unit, crypto: mfaCrypto },
    mfaVerification: { ...common, unit, crypto: mfaCrypto, trustedDeviceCookies },
    setup: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, logger },
    registries: { unit, summaries: unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, newId: createUuidV7(), limits: limits.registry, logger },
    records: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, newId: createUuidV7(), hash: sha256Hex, limits: limits.registry, recordMaxBytes: limits.recordMaxBytes, logger },
    structure: { ...structure, gate: gate.gate, snapshots, newId: createUuidV7(), newOperationId: randomUUID, cookies, allowedOrigin: HARNESS_ORIGIN, logger },
    dictionaries: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, newId: createUuidV7(), limits: limits.dictionary, logger },
    config: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, newId: createUuidV7(), limits: limits.config, logger },
    systemTables: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, logger },
    screens: { dashboard: { unit, nowMs: Date.now, newId: createUuidV7(), policy: DESIGN_POLICY, widgets: createWidgetCatalog() }, cookies, allowedOrigin: HARNESS_ORIGIN, logger },
    settings: { unit, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, environment, refresh: effectiveSettings.refresh, logger },
    announce: options.announce ?? hub.publish,
    stream: { unit, hub, cookies, allowedOrigin: HARNESS_ORIGIN, nowMs: Date.now, pingIntervalMs: options.pingIntervalMs ?? 25_000, logger },
  });

  async function request(method: string, route: string, body?: unknown, init: { cookie?: string | null; origin?: string | null; headers?: Record<string, string> } = {}): Promise<HarnessReply> {
    const headers: Record<string, string> = { ...init.headers };
    const origin = init.origin === undefined ? HARNESS_ORIGIN : init.origin;
    if (origin !== null) headers["Origin"] = origin;
    if (init.cookie) headers["Cookie"] = init.cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await app.request(route, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await response.text();
    const setCookies = response.headers.getSetCookie();
    return { status: response.status, text, json: () => JSON.parse(text) as unknown, setCookies, cookie: setCookies[0]?.split(";")[0] ?? null };
  }

  /** A request whose answer is not read to the end: a live stream stays open for the test to read event by event. */
  const open = (route: string, init: { cookie?: string | null } = {}): Promise<Response> => Promise.resolve(app.request(route, { method: "GET", headers: init.cookie ? { Cookie: init.cookie } : {} }));

  return {
    request,
    open,
    /** The hub of the live stream, to publish an event as a commit will (D38) and to count the streams. */
    hub,
    /** The technical log lines written so far. */
    logLines: (): readonly string[] => lines,
    /** The next unit of work starts only after `action` has run (once). */
    interruptNextWrite(action: () => void): void {
      beforeNextRun = action;
    },
    /** Something that happens elsewhere: a unit of work of its own. */
    elsewhere: inner,
    /** The dependencies of the structure use cases as the app has them, for the check of a plan no route makes yet (D26.2; D28–D30 call it under the writer). */
    structure,
    /** The maintenance gate of the harness, to read the operations the routes record. */
    gate: gate.gate,
    /** The folder of the copies the routes take (D29). */
    backupsDir: workingPaths.backups,
    /** The session token a `name=value` cookie of this app carries, or null. */
    sessionToken: (cookie: string): Promise<string | null> => cookies.verify(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))),
    rows: <T>(sql: string): T[] => connection.handle.prepare(sql).all() as T[],
    sql: (statement: string): void => void connection.handle.exec(statement),
    connection,
  };
}

export type AppHarness = Awaited<ReturnType<typeof createAppHarness>>;
