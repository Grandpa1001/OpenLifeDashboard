// `node apps/server/dist/cli/backup-list.js [--installation <dir>]` — the catalog of the backup folder (Scope §5.6;
// Architektura §11.4; D48.3): one JSON object with the copies found, each `completed`, `invalid` (with the part
// that failed) or `incomplete` (left in staging). It only reads: no lease, no database, nothing is deleted or
// repaired, so it runs beside a running app. A package is verified in full, so a large folder takes a while.
import { randomUUID } from "node:crypto";
import { listBackups } from "../adapters/filesystem/backup-catalog.js";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths } from "../adapters/filesystem/installation-paths.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { loadBootstrapConfig } from "../bootstrap/bootstrap-config.js";
import { refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "backup-list.failed";
function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const workingPaths = options.installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(options.installationDir);
const bootstrap = loadBootstrapConfig({ env: process.env, instanceFile: workingPaths.instanceFile });
if (!bootstrap.ok) {
  refuse(bootstrap.code, bootstrap.fields);
}
try {
  const backups = listBackups(workingPaths.backups, bootstrap.config.paths.instanceId);
  console.log(JSON.stringify({ event: "backup.listed", backups, requestId: randomUUID() }));
} catch (error) {
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
}
