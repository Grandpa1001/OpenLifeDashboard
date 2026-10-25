// node tests/support/uow-crash.ts <database> <marker file> inside|after
// Test-only writer (DEV D04.2-AC2): runs a unit of work on a file database through the built
// adapters and freezes either inside the open transaction (after its first write) or after the
// commit. It writes the marker file synchronously at that point, so the test can SIGKILL it
// exactly there; it never exits by itself.
import { writeFileSync } from "node:fs";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { createUnitOfWork } from "../../packages/sqlite/dist/transactions/unit-of-work.js";
import { bindTestPorts } from "./test-ports.ts";

const [database, marker, moment] = process.argv.slice(2);
if (!database || !marker || (moment !== "inside" && moment !== "after")) {
  console.error("usage: uow-crash <database> <marker file> inside|after");
  process.exit(2);
}
const freeze = (): void => {
  writeFileSync(marker, moment);
  // Blocks the only thread without returning to the event loop: the transaction stays open.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const connection = openDatabase(database, { role: "writer", busyTimeoutMs: 5000 });
const uow = createUnitOfWork(connection, bindTestPorts);
uow.run((ports) => {
  ports.parents.insert("crash-parent", "written before the kill");
  if (moment === "inside") freeze();
  return { value: null, invalidations: [] };
});
freeze();
