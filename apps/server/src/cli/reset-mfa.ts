// `node apps/server/dist/cli/reset-mfa.js [--installation <dir>]` — removes the owner's second
// factor and requires a new enrollment at the next sign-in (Architektura §4.8, §9.6, §9.8; D11.4).
// It takes no input: there is nothing to type and no secret to pass. Like create-owner it runs
// under the writer lease on a current database (a running app means INSTANCE_BUSY and no change).
// One transaction clears the factor, ends every session, revokes every trusted device, raises the
// access epoch and writes the `owner.mfa_reset` audit entry; the password, the owner's data and
// the choice of the starting data stay. If any part fails nothing changes.
import { randomUUID } from "node:crypto";
import { resetOwnerMfa } from "@openlife/core/identity";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindMfaStore, bindOwnerWriters, bindRecoveryCodeStore, bindSignInStores, bindTrustedDeviceStore } from "@openlife/sqlite/adapters/identity";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { describeError } from "../adapters/logging/describe-error.js";
import { openCommandSession } from "../bootstrap/command-session.js";
import { refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "reset-mfa.failed";
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
  const unit = createUnitOfWork(session.connection, (tx) => ({
    owners: bindOwnerWriters(tx).owners,
    mfa: bindMfaStore(tx),
    recovery: bindRecoveryCodeStore(tx),
    sessions: bindSignInStores(tx).sessions,
    trusted: bindTrustedDeviceStore(tx),
    audit: bindAppendAudit(tx),
  }));
  const reset = unit.run((ports) => resetOwnerMfa(ports, { requestId, now: new Date().toISOString(), nowMs: Date.now() }));
  if (!reset.ok) {
    refuse(reset.error.code, reset.error.fields ?? []);
  }
  const { accessEpoch, revokedSessions, revokedDevices } = reset.value.value;
  console.log(JSON.stringify({ event: "owner.mfa_reset", accessEpoch, revokedSessions, revokedDevices, requestId }));
} catch (error) {
  // The unit has rolled back; the error is described by class and code only.
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  session.close();
}
