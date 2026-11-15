// `node apps/server/dist/cli/backup-verify.js [--installation <dir>]` with `{"snapshot": "<package directory>"}` on
// stdin — verifies one copy in the backup folder in full and says whether this build could restore it (Scope §5.6;
// Architektura §11.3.3 point 1; D50.1). The package is checked as a restore would check it (set of files,
// checksums, meta, integrity of the database and, for a bundle, the header of the export) and then read against
// the code: a copy of a newer schema than this build knows is refused, a copy of an older one is restorable and
// says that the first start migrates it, a copy of another installation says so. Like the catalog it only
// reads: no lease, no database of the installation, nothing is repaired or removed, so it runs beside a running
// app and beside a damaged installation. A refusal names a code and fields, never a value.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { backupVerifyInputSchema } from "@openlife/contracts/backups/database-snapshot";
import { assessRestorable } from "@openlife/core/maintenance";
import { PRODUCT_MIGRATION_PLAN, targetSchemaVersion } from "@openlife/sqlite/migrations";
import { verifyDatabaseSnapshot } from "../adapters/filesystem/database-snapshots.js";
import { CONTAINER_WORKING_PATHS, installationWorkingPaths } from "../adapters/filesystem/installation-paths.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { loadBootstrapConfig } from "../bootstrap/bootstrap-config.js";
import { readJsonInput, refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "backup-verify.failed";
function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const input = await readJsonInput(EVENT, backupVerifyInputSchema);
const workingPaths = options.installationDir === undefined ? CONTAINER_WORKING_PATHS : installationWorkingPaths(options.installationDir);
const bootstrap = loadBootstrapConfig({ env: process.env, instanceFile: workingPaths.instanceFile });
if (!bootstrap.ok) {
  refuse(bootstrap.code, bootstrap.fields);
}
try {
  const verification = verifyDatabaseSnapshot(path.join(workingPaths.backups, input.snapshot));
  if (!verification.ok) {
    refuse(verification.code, verification.fields);
  }
  const { meta } = verification;
  const assessment = assessRestorable({ instanceId: meta.instanceId, schemaVersion: meta.schemaVersion }, { instanceId: bootstrap.config.paths.instanceId, codeSchemaVersion: targetSchemaVersion(PRODUCT_MIGRATION_PLAN) });
  if (!assessment.restorable) {
    refuse("SNAPSHOT_UNSUITABLE", assessment.problems);
  }
  console.log(
    JSON.stringify({
      event: "backup.verified",
      snapshot: input.snapshot,
      scope: meta.scope,
      reason: meta.reason,
      startedAt: meta.startedAt,
      schemaVersion: meta.schemaVersion,
      appVersion: meta.appVersion,
      sameInstallation: assessment.sameInstallation,
      migrationNeeded: assessment.migrationNeeded,
      requestId: randomUUID(),
    }),
  );
} catch (error) {
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
}
