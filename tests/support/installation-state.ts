// The state of a Compose test installation read from the host (DEV D07.2, D07.3): the migration
// manifest, the installation ID in the database and instance.json, the maintenance gate, the
// published snapshots and the technical log. Read only while the app of that installation is
// stopped, so the WAL is settled and nothing is assumed from what the app reports.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { verifyDatabaseSnapshot } from "../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";

const HEALTH_POLL_MS = 500;

export const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export type InstallationState = Readonly<{
  manifest: unknown;
  instance: unknown;
  integrity: unknown;
  foreignKeys: unknown;
  gate: unknown;
  instanceJson: string;
  snapshots: readonly Readonly<{ name: string; hashes: readonly string[]; verified: boolean }>[];
  log: string;
}>;

export function readInstallationState(dir: string): InstallationState {
  const reader = openDatabase(path.join(dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  let database: Pick<InstallationState, "manifest" | "instance" | "integrity" | "foreignKeys">;
  try {
    database = {
      manifest: reader.handle.prepare("SELECT version, id, checksum, applied_at FROM schema_migration ORDER BY version").all(),
      instance: reader.handle.prepare("SELECT singleton, instance_id, created_at FROM instance").all(),
      integrity: reader.handle.pragma("integrity_check", { simple: true }),
      foreignKeys: reader.handle.pragma("foreign_key_check"),
    };
  } finally {
    reader.close();
  }
  const backups = path.join(dir, "data", "backup");
  const snapshots = readdirSync(backups)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({
      name,
      hashes: readdirSync(path.join(backups, name)).sort().map((file) => sha256(path.join(backups, name, file))),
      verified: verifyDatabaseSnapshot(path.join(backups, name)).ok,
    }));
  return {
    ...database,
    gate: JSON.parse(readFileSync(path.join(dir, "control", "maintenance", "state.json"), "utf8")),
    instanceJson: sha256(path.join(dir, "control", "instance.json")),
    snapshots,
    log: readLog(dir),
  };
}

/** The active technical log file of the installation, empty when none was written yet. */
export function readLog(dir: string): string {
  const file = path.join(dir, "data", "logs", "app", "app.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Everything of the state but the log, which is expected to grow. */
export const withoutLog = (state: InstallationState) => ({
  manifest: state.manifest,
  instance: state.instance,
  integrity: state.integrity,
  foreignKeys: state.foreignKeys,
  gate: state.gate,
  instanceJson: state.instanceJson,
  snapshots: state.snapshots,
});

export const logLines = (log: string): string[] => log.split("\n").filter((line) => line !== "");

/** The last event of that name in `docker compose logs` output, whose lines carry a service prefix. */
export function lastComposeEvent(output: string, name: string): JsonObject {
  const entries = output.split("\n").filter((line) => line.includes(`"event":"${name}"`));
  const value: unknown = JSON.parse(/\{.*\}/.exec(entries.at(-1) ?? "")?.[0] ?? "{}");
  return isJsonObject(value) ? value : {};
}

export async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  return false;
}
