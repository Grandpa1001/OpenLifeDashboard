// `node apps/server/dist/cli/create-owner.js [--installation <dir>]` — creates the owner of an
// installation (Architektura §4.8, §9.8; D09.2). The e-mail and the password arrive only as one
// JSON object on stdin, never in arguments or the environment, and appear in no output: the
// password is hashed by the shared PasswordHasher before the unit of work, and the stored value
// is the PHC hash. The command runs under the writer lease like the server (a running app means
// INSTANCE_BUSY and no change), only on a current database, and writes the account, the owner
// singleton and the `owner.created` audit entry in one transaction. Exit 0 prints the owner id;
// every refusal exits 1 with a stable code and field names, never values.
import { randomUUID } from "node:crypto";
import { createOwner } from "@openlife/core/identity";
import { createUnitOfWork } from "@openlife/sqlite/transactions";
import { bindAppendAudit } from "@openlife/sqlite/adapters/audit";
import { bindOwnerWriters } from "@openlife/sqlite/adapters/identity";
import { ownerCredentialsSchema, type OwnerCredentials } from "@openlife/contracts/http/identity";
import { createPasswordHasher } from "../adapters/auth/password-hasher.js";
import { describeError } from "../adapters/logging/describe-error.js";
import { openCommandSession } from "../bootstrap/command-session.js";
import { parseCommandOptions } from "./command-options.js";
import { readStdin, StdinTooLargeError } from "./read-stdin.js";

/** The JSON of a valid credential pair is far below this; more is not a credential. */
const MAX_INPUT_BYTES = 16 * 1024;

function refuse(code: string, fields: readonly string[], details: Readonly<Record<string, unknown>> = {}): never {
  console.error(JSON.stringify({ event: "create-owner.failed", code, fields, ...details }));
  process.exit(1);
}

/** Field names only: the issue paths of the contract, never the rejected values. */
async function readCredentials(): Promise<OwnerCredentials> {
  let raw: string;
  try {
    raw = await readStdin(process.stdin, MAX_INPUT_BYTES);
  } catch (error) {
    return refuse("INPUT_INVALID", [error instanceof StdinTooLargeError ? "input" : "stdin"]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return refuse("INPUT_INVALID", ["input"]);
  }
  const parsed = ownerCredentialsSchema.safeParse(json);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "input")));
    return refuse("INPUT_INVALID", [...fields]);
  }
  return parsed.data;
}

const options = parseCommandOptions(process.argv.slice(2));
if (!options.ok) {
  refuse("USAGE", ["arguments"]);
}
const credentials = await readCredentials();
const requestId = randomUUID();
// Hashing is asynchronous and costly, so it happens before the unit of work (§9.8).
const passwordHash = await createPasswordHasher().hash(credentials.password);
const opened = openCommandSession({ env: process.env, installationDir: options.installationDir });
if (!opened.ok) {
  refuse(opened.code, opened.fields);
}
const { session } = opened;
try {
  const unit = createUnitOfWork(session.connection, (tx) => ({ ...bindOwnerWriters(tx), audit: bindAppendAudit(tx) }));
  const created = unit.run((ports) =>
    createOwner(ports, { ownerId: randomUUID(), email: credentials.email, passwordHash, requestId, now: new Date().toISOString() }),
  );
  if (!created.ok) {
    refuse(created.error.code, created.error.fields ?? []);
  }
  console.log(JSON.stringify({ event: "owner.created", ownerId: created.value.value.ownerId, requestId }));
} catch (error) {
  // The unit has rolled back; the error is described by class and code only.
  refuse("COMMAND_FAILED", [], { error: describeError(error) });
} finally {
  session.close();
}
