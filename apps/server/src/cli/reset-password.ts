// `node apps/server/dist/cli/reset-password.js [--installation <dir>]` — sets a new password for
// the installation's owner (Architektura §4.8, §9.6, §9.8; D09.4). The new password arrives only
// as `{"password": "..."}` on stdin and is hashed by the shared PasswordHasher before the unit of
// work. Like create-owner it runs under the writer lease on a current database (a running app
// means INSTANCE_BUSY and no change). One transaction replaces the credential, raises the access
// epoch, ends every session of the owner and writes the `owner.password_reset` audit entry; if
// any part fails nothing changes. Exit 0 prints the new epoch and the number of ended sessions.
import { randomUUID } from "node:crypto";
import { resetPasswordInputSchema } from "@openlife/contracts/http/identity";
import { resetOwnerPassword } from "@openlife/core/identity";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindOwnerWriters, bindSignInStores } from "@openlife/sqlite/adapters/identity";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { createPasswordHasher } from "../adapters/auth/password-hasher.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { openCommandSession } from "../bootstrap/command-session.js";
import { readJsonInput, refuse as refuseCommand } from "./command-io.js";
import { parseCommandOptions } from "./command-options.js";

const EVENT = "reset-password.failed";
function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  return refuseCommand(EVENT, code, fields, details);
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const input = await readJsonInput(EVENT, resetPasswordInputSchema);
const requestId = randomUUID();
// Hashing is asynchronous and costly, so it happens before the unit of work (§9.8).
const passwordHash = await createPasswordHasher().hash(input.password);
const opened = openCommandSession({ env: process.env, installationDir: options.installationDir });
if (!opened.ok) {
  refuse(opened.code, opened.fields);
}
const { session } = opened;
try {
  const unit = createUnitOfWork(session.connection, (tx) => {
    const { owners, credentials } = bindOwnerWriters(tx);
    return { owners, credentials, sessions: bindSignInStores(tx).sessions, audit: bindAppendAudit(tx) };
  });
  const reset = unit.run((ports) => resetOwnerPassword(ports, { passwordHash, requestId, now: new Date().toISOString() }));
  if (!reset.ok) {
    refuse(reset.error.code, reset.error.fields ?? []);
  }
  console.log(JSON.stringify({ event: "owner.password_reset", accessEpoch: reset.value.value.accessEpoch, revokedSessions: reset.value.value.revokedSessions, requestId }));
} catch (error) {
  // The unit has rolled back; the error is described by class and code only.
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  session.close();
}
