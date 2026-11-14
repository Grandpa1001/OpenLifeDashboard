// `node apps/server/dist/cli/backup-create.js [--installation <dir>]` — takes a copy of the whole installation
// on request: a package of scope `bundle` (the database and the export of the same state, checksums and meta)
// with the reason `manual` in the backup folder (Scope §5.6; Architektura §11.3, §11.4; D48.2). It takes no
// input. Like the other commands it runs under the writer lease on a current database, so a running app means
// INSTANCE_BUSY and no copy; the copy is built in staging and published only after the same verification a
// restore runs, so a refusal or a failure leaves no package and no staging. The output names the package, its
// scope and size and never a value of the owner's data.
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createDatabaseSnapshots } from "../adapters/filesystem/database-snapshots.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { openCommandSession } from "../bootstrap/command-session.js";
import { readBuildInfo } from "../bootstrap/build-info.js";
import { exportOfCopy } from "../portability/bundle-export.js";
import { refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "backup-create.failed";
function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const requestId = randomUUID();
const opened = openCommandSession({ env: process.env, installationDir: options.installationDir });
if (!opened.ok) {
  refuse(opened.code, opened.fields);
}
const { session } = opened;
try {
  const build = readBuildInfo();
  const busyTimeoutMs = session.busyTimeoutMs;
  const snapshots = createDatabaseSnapshots(session.connection, {
    backupsDir: session.backupsDir,
    reserveMiB: session.reserveMiB,
    instanceId: session.instanceId,
    build,
    now: () => new Date().toISOString(),
    newSnapshotId: randomUUID,
    exportOfCopy: (copyFile, exportedAt) => exportOfCopy(copyFile, { busyTimeoutMs, appVersion: build.appVersion, exportedAt }),
  });
  const snapshotResult = await snapshots.create({ reason: "manual", scope: "bundle", operationId: randomUUID(), fence: 0 });
  if (!snapshotResult.ok) {
    refuse(snapshotResult.code, []);
  }
  const { snapshotId } = snapshotResult;
  const name = readdirSync(session.backupsDir).find((entry) => entry.endsWith(`-${snapshotId}`));
  const bytes = name === undefined ? 0 : readdirSync(path.join(session.backupsDir, name)).reduce((sum, file) => sum + statSync(path.join(session.backupsDir, name, file)).size, 0);
  console.log(JSON.stringify({ event: "backup.created", scope: "bundle", reason: "manual", snapshotId, directory: name ?? null, bytes, requestId }));
} catch (error) {
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  session.close();
}
