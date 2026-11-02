// The writer of a stopped installation, held in the test process as the server holds it: its lease,
// its gate, its database and its folder of copies, with `pomiary` (text 12 and abc) made through the
// API of the built server first. The tests of the operation of a change of the structure run on it
// (D27.2, D29.1, D30.1).
import { randomUUID } from "node:crypto";
import { IDEMPOTENCY_KEY_HEADER, registryRecordsPath } from "@openlife/contracts/http/records";
import { REGISTRIES_PATH, registryListSchema } from "@openlife/contracts/http/registries";
import { expect } from "vitest";
import { createDatabaseSnapshots } from "../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { installationWorkingPaths } from "../../apps/server/dist/adapters/filesystem/installation-paths.js";
import { openMaintenanceGate } from "../../apps/server/dist/adapters/filesystem/maintenance-gate.js";
import { acquireWriterLease } from "../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { createStructureOperation, type StructureOperationDependencies } from "../../apps/server/dist/workers/rebuild-operation.js";
import type { DatabaseSnapshotPort } from "../../packages/core/dist/modules/maintenance/public.js";
import { changeColumnType, deleteRegistry, type RegistryDeletionDependencies, type RegistryDeletionInput, type RegistryDeletionPorts, type RegistryStore, type RegistryTables, type TableRebuild, type TypeChangeDependencies, type TypeChangeInput, type TypeChangePorts } from "../../packages/core/dist/modules/registries/public.js";
import { bindAppendAudit } from "../../packages/sqlite/dist/adapters/audit/append-audit.js";
import { bindDictionaryLookup } from "../../packages/sqlite/dist/adapters/dictionaries/public.js";
import { bindRecordStore, bindRegistryStore, bindRegistryTables, bindTableRebuild } from "../../packages/sqlite/dist/adapters/registries/public.js";
import { bindOwnerPreferencesStore } from "../../packages/sqlite/dist/adapters/settings/owner-preferences.js";
import { openDatabase, type SqliteConnection } from "../../packages/sqlite/dist/connection/open-database.js";
import { createUnitOfWork } from "../../packages/sqlite/dist/transactions/unit-of-work.js";
import { installation, post, query, readyOwner, send, stopServer, type Installation } from "./auth-http.ts";

const connections: SqliteConnection[] = [];
const releases: Array<() => void> = [];
/** Closes the databases and releases the leases of the writers made so far; call it from afterEach. */
export function closeWriters(): void {
  for (const connection of connections.splice(0)) if (connection.handle.open) connection.close();
  for (const release of releases.splice(0)) release();
}

/** An installation whose owner made `pomiary` (text 12 and abc) through the API; the server is stopped. */
export async function stopped(keyPrefix: string): Promise<{ setup: Installation; registry: { id: string; columnId: string; ownerId: string } }> {
  const setup = await installation();
  const cookie = (await readyOwner(setup)).sessionCookie;
  expect((await post(setup.server, REGISTRIES_PATH, { symbol: "pomiary", displayName: "Pomiary", columns: [{ symbol: "wynik", displayName: "Wynik", type: "text", typeOptions: {}, defaultValue: null, required: false }] }, { cookie })).status).toBe(201);
  for (const [index, wynik] of ["12", "abc"].entries()) {
    expect((await post(setup.server, registryRecordsPath("pomiary"), { schemaRevision: 1, values: { wynik } }, { cookie, headers: { [IDEMPOTENCY_KEY_HEADER]: `${keyPrefix}-add-${index}` } })).status).toBe(201);
  }
  const registry = registryListSchema.parse((await send(setup.server, "GET", REGISTRIES_PATH, undefined, { cookie })).json()).registries[0]!;
  await stopServer(setup.server);
  const ownerId = query<{ id: string }>(setup.instance, 'SELECT id FROM "user"')[0]!.id;
  return { setup, registry: { id: registry.id, columnId: registry.columns[0]!.id, ownerId } };
}

export type WriterOptions = Readonly<{
  /** Wraps the adapter of the rebuild, to fail it after its stages. */
  rebuild?: (inner: TableRebuild) => TableRebuild;
  /** Wraps the drop of a table and the store of the catalog, to fail a deletion after a stage (D30.1). */
  tables?: (inner: RegistryTables) => RegistryTables;
  registries?: (inner: RegistryStore) => RegistryStore;
  /** Wraps the copies, to fail one or to act while it is made. */
  snapshots?: (inner: DatabaseSnapshotPort) => DatabaseSnapshotPort;
  /** backup.diskReserveMiB of the copies; 1 unless a test needs more than the disk has. */
  reserveMiB?: number;
}>;

/** The writer of the stopped installation in this process: its lease, its gate, its database and its copies. */
export function writerOf(setup: Installation, options: WriterOptions = {}) {
  const paths = installationWorkingPaths(setup.instance.dir);
  const writer = acquireWriterLease(paths.maintenance);
  if (!writer.ok) throw new Error(`the lease was not acquired: ${writer.code}`);
  releases.push(() => writer.lease.release());
  const opened = openMaintenanceGate(writer.lease, paths);
  if (!opened.ok) throw new Error(`the gate did not open: ${opened.code}`);
  const connection = openDatabase(paths.database, { role: "writer", busyTimeoutMs: 5000 });
  connections.push(connection);
  const unit = createUnitOfWork(connection, (tx) => ({
    registries: (options.registries ?? ((inner) => inner))(bindRegistryStore(tx)),
    records: bindRecordStore(tx),
    tables: (options.tables ?? ((inner) => inner))(bindRegistryTables(tx)),
    dictionaryLookup: bindDictionaryLookup(tx),
    preferences: bindOwnerPreferencesStore(tx),
    rebuild: (options.rebuild ?? ((inner) => inner))(bindTableRebuild(tx)),
    audit: bindAppendAudit(tx),
  }));
  const snapshots = createDatabaseSnapshots(connection, {
    backupsDir: paths.backups,
    reserveMiB: options.reserveMiB ?? 1,
    instanceId: setup.instance.instanceId,
    build: { appVersion: "0.0.0-test", buildRevision: "test", imageDigest: null },
    now: () => new Date().toISOString(),
    newSnapshotId: randomUUID,
  });
  return { gate: opened.gate, unit, connection, snapshots: (options.snapshots ?? ((inner) => inner))(snapshots) };
}

/** The change of a column's type as the route runs it, without its session: the copy pre_type_change, then the rebuild (D27.2, D29.1). */
export function createRebuildOperation(deps: StructureOperationDependencies<TypeChangePorts> & Readonly<{ change: Omit<TypeChangeDependencies, "nowMs"> }>) {
  const operation = createStructureOperation(deps);
  return (input: TypeChangeInput) => operation(input, (ports, nowMs) => changeColumnType(ports, { ...deps.change, nowMs }, input), "pre_type_change");
}

/** The deletion of a registry as the route runs it, without its session: the copy pre_delete, then the unit (D30.1). */
export function createDeletionOperation(deps: StructureOperationDependencies<RegistryDeletionPorts> & Readonly<{ change: Omit<RegistryDeletionDependencies, "nowMs"> }>) {
  const operation = createStructureOperation(deps);
  return (input: RegistryDeletionInput) => operation(input, (ports, nowMs) => deleteRegistry(ports, { ...deps.change, nowMs }, input), "pre_delete");
}
