// control/instance.json v1 (Architektura §14.5): the installation's identity and descriptive
// host metadata. Read-only for the app: nothing here creates, repairs or rewrites the file, so
// an invalid or missing file can never yield a new identity.
import { readFileSync } from "node:fs";
import type { InstallMode } from "./environment.js";

export type HostPlatform = "posix" | "windows";

export type InstanceMetadata = Readonly<{
  formatVersion: 1;
  /** Random UUIDv4, separate from domain UUIDv7 identifiers. */
  instanceId: string;
  installMode: InstallMode;
  composeProjectName: string;
  hostPlatform: HostPlatform;
  /** Absolute host path, descriptive only: never opened inside the container. */
  installationPath: string;
  createdAt: string;
}>;

export type InstanceMetadataResult =
  | Readonly<{ ok: true; metadata: InstanceMetadata }>
  | Readonly<{ ok: false; code: "INSTANCE_METADATA_INVALID"; fields: readonly string[] }>;

/** Field reported when the file itself is missing or not a JSON object. */
export const INSTANCE_FILE_FIELD = "instance.json";

const FORMAT_VERSION = 1;
const FIELDS = ["formatVersion", "instanceId", "installMode", "composeProjectName", "hostPlatform", "installationPath", "createdAt"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_NAME = /^openlife-[0-9a-f]{12}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ABSOLUTE_PATH: Readonly<Record<HostPlatform, RegExp>> = {
  posix: /^\/(?!.*\0)/,
  // Drive letter or UNC share; a root-relative "\folder" depends on the current drive.
  windows: /^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)(?!.*\0)/,
};

const invalid = (...fields: string[]): InstanceMetadataResult => ({
  ok: false,
  code: "INSTANCE_METADATA_INVALID",
  fields: [...new Set(fields)].sort(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const matching = (value: unknown, pattern: RegExp | undefined): string | undefined =>
  typeof value === "string" && pattern?.test(value) ? value : undefined;

/** Date.parse rolls 2026-02-31 over to March; a real timestamp survives a round trip. */
function isRealTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function parseInstanceMetadata(value: unknown): InstanceMetadataResult {
  if (!isRecord(value)) {
    return invalid(INSTANCE_FILE_FIELD);
  }
  // Other fields have no defined meaning in an unknown format version.
  if (value["formatVersion"] !== FORMAT_VERSION) {
    return invalid("formatVersion");
  }
  const instanceId = matching(value["instanceId"], UUID_V4);
  const mode = value["installMode"];
  const installMode = mode === "local" || mode === "server" ? mode : undefined;
  const composeProjectName = matching(value["composeProjectName"], PROJECT_NAME);
  const platform = value["hostPlatform"];
  const hostPlatform = platform === "posix" || platform === "windows" ? platform : undefined;
  const installationPath = matching(value["installationPath"], hostPlatform ? ABSOLUTE_PATH[hostPlatform] : undefined);
  const createdAt = matching(value["createdAt"], UTC_TIMESTAMP);

  const problems = Object.keys(value).filter((key) => !FIELDS.includes(key));
  if (!instanceId) problems.push("instanceId");
  if (!installMode) problems.push("installMode");
  if (!composeProjectName) problems.push("composeProjectName");
  if (!hostPlatform) problems.push("hostPlatform");
  // A path can only be judged against a known platform; an unknown one is reported alone.
  if (hostPlatform && !installationPath) problems.push("installationPath");
  if (!createdAt || !isRealTimestamp(createdAt)) problems.push("createdAt");
  if (problems.length > 0 || !instanceId || !installMode || !composeProjectName || !hostPlatform || !installationPath || !createdAt) {
    return invalid(...problems);
  }
  return {
    ok: true,
    metadata: { formatVersion: FORMAT_VERSION, instanceId, installMode, composeProjectName, hostPlatform, installationPath, createdAt },
  };
}

/** Reads the file without creating or changing anything; any read problem is invalid metadata. */
export function readInstanceMetadata(file: string): InstanceMetadataResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return invalid(INSTANCE_FILE_FIELD);
  }
  try {
    return parseInstanceMetadata(JSON.parse(text));
  } catch {
    return invalid(INSTANCE_FILE_FIELD);
  }
}

/** The install mode recorded at installation must match the environment (Architektura §14.5). */
export function checkInstallMode(metadata: InstanceMetadata, environmentMode: InstallMode): InstanceMetadataResult {
  return metadata.installMode === environmentMode ? { ok: true, metadata } : invalid("installMode");
}
