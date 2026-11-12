// The checks of `doctor` (Architektura §15.3; D44.4). Offline: the environment, the metadata of the
// installation, the options, the storage and the database, each by the same function the server starts with.
// Online: the public health of the running app, nothing else. `doctor` repairs nothing and publishes
// nothing: it opens no writer, takes no lease, and runs no migration. The one thing it writes is the probe
// file the storage preflight puts in each folder and removes at once. A check says pass, warn, fail or
// skipped (its inputs failed), with a code and the names of the fields, never a value of the environment.
import { integerSetting } from "@openlife/core/settings";
import { inspectDatabase, PRODUCT_MIGRATION_PLAN } from "@openlife/sqlite/migrations";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths, type WorkingPaths } from "../adapters/filesystem/installation-paths.js";
import { runStoragePreflight } from "../adapters/filesystem/storage-preflight.js";
import { parseEnvironment, type EnvironmentConfig } from "../bootstrap/environment.js";
import { checkInstallMode, readInstanceMetadata, type InstanceMetadata } from "../bootstrap/instance-metadata.js";
import { INTERNAL_PORT } from "../bootstrap/runtime-defaults.js";
import { resolveBootstrapSettings } from "../bootstrap/settings.js";
import { HEALTH_PATH_FOR_DOCTOR, ONLINE_CHECK_TIMEOUT_MS } from "./doctor-constants.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export type DoctorCheck = Readonly<{
  id: string;
  status: CheckStatus;
  /** A stable code of the failure or of the warning. */
  code?: string;
  /** Names of the fields or folders the code speaks of; never values. */
  fields?: readonly string[];
  /** Facts that are safe to print (a schema version, a status code). */
  facts?: Readonly<Record<string, string | number | boolean>>;
}>;

export type CheckGroup = Readonly<{ ok: boolean; checks: readonly DoctorCheck[] }>;

const group = (checks: readonly DoctorCheck[]): CheckGroup => ({ ok: checks.every((check) => check.status !== "fail"), checks });
const pass = (id: string, facts?: DoctorCheck["facts"]): DoctorCheck => ({ id, status: "pass", ...(facts === undefined ? {} : { facts }) });
const fail = (id: string, code: string, fields: readonly string[]): DoctorCheck => ({ id, status: "fail", code, fields });
const skipped = (id: string): DoctorCheck => ({ id, status: "skipped" });

export type OfflineInputs = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  /** An installation folder outside a container; absent = the fixed container paths. */
  installationDir?: string | undefined;
}>;

export function runOfflineChecks(inputs: OfflineInputs): CheckGroup {
  const working: WorkingPaths = inputs.installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(inputs.installationDir);
  const checks: DoctorCheck[] = [];

  const parsed = parseEnvironment(inputs.env);
  const environment: EnvironmentConfig | null = parsed.ok ? parsed.config : null;
  checks.push(parsed.ok ? pass("environment", { installMode: parsed.config.installMode }) : fail("environment", parsed.code, parsed.fields));

  const read = readInstanceMetadata(working.instanceFile);
  // The mode of the metadata is compared with the environment's only when the environment is readable.
  const checked = read.ok && environment !== null ? checkInstallMode(read.metadata, environment.installMode) : read;
  const metadata: InstanceMetadata | null = read.ok && checked.ok ? read.metadata : null;
  checks.push(checked.ok ? pass("instance", { instanceId: checked.metadata.instanceId }) : fail("instance", checked.code, checked.fields));

  const options = environment === null ? null : resolveBootstrapSettings(environment.overrides);
  checks.push(options === null ? skipped("options") : options.ok ? pass("options") : fail("options", options.code, options.fields));

  const reserveMiB = options !== null && options.ok ? integerSetting(options.settings, "backup.diskReserveMiB") : undefined;
  if (reserveMiB === undefined) {
    checks.push(skipped("storage"), skipped("logs"));
  } else {
    const preflight = runStoragePreflight(working, reserveMiB);
    checks.push(preflight.ok ? pass("storage") : fail("storage", preflight.code, preflight.fields));
    // The logs are an optional sink: their folder failing is a warning, as at the start of the server.
    checks.push(!preflight.ok ? skipped("logs") : preflight.degraded.length > 0 ? { id: "logs", status: "warn", code: "LOG_SINK_UNAVAILABLE", fields: preflight.degraded } : pass("logs"));
  }

  if (metadata === null || environment === null) {
    checks.push(skipped("database"));
  } else {
    const inspection = inspectDatabase(working.database, PRODUCT_MIGRATION_PLAN, { instanceId: metadata.instanceId, busyTimeoutMs: environment.dbBusyTimeoutMs });
    if (inspection.kind === "current") checks.push(pass("database", { schemaVersion: inspection.schemaVersion }));
    else if (inspection.kind === "refused") checks.push(fail("database", inspection.code, inspection.fields));
    else checks.push(fail("database", inspection.kind === "empty" ? "DATABASE_MISSING" : "DATABASE_NOT_CURRENT", ["database"]));
  }
  return group(checks);
}

export type OnlineInputs = Readonly<{
  /** The address of the running app as the process can reach it. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

/** The default address of the app from inside its container. */
export const defaultOnlineUrl = (): string => `http://127.0.0.1:${INTERNAL_PORT}`;

/** The address is an http(s) origin without credentials, or null. */
export function onlineOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" ? url.origin : null;
  } catch {
    return null;
  }
}

export async function runOnlineChecks(inputs: OnlineInputs): Promise<CheckGroup> {
  const origin = onlineOrigin(inputs.baseUrl);
  if (origin === null) return group([fail("health", "URL_INVALID", ["url"])]);
  try {
    const response = await (inputs.fetch ?? fetch)(`${origin}${HEALTH_PATH_FOR_DOCTOR}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(inputs.timeoutMs ?? ONLINE_CHECK_TIMEOUT_MS) });
    const body: unknown = await response.json().catch(() => undefined);
    const status = typeof body === "object" && body !== null ? Reflect.get(body, "status") : undefined;
    if (response.status === 200 && status === "ok") return group([pass("health", { httpStatus: 200 })]);
    return group([{ id: "health", status: "fail", code: response.status === 503 ? "HEALTH_UNAVAILABLE" : "HEALTH_UNEXPECTED", facts: { httpStatus: response.status } }]);
  } catch (error) {
    return group([fail("health", error instanceof Error && error.name === "TimeoutError" ? "HEALTH_TIMEOUT" : "CONNECTION_FAILED", [])]);
  }
}
