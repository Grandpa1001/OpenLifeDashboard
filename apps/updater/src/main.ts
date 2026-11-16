// The updater process (Architektura §11.2.1, §12.1; D52.5): the composition root. It reads its few settings from the
// environment the Compose service gives it, opens the journal in its own control folder, finds its own project's app
// through the scope of the Docker adapter and listens on the internal network. It never starts without a token of
// the right shape, and it refuses a journal it cannot read. Nothing of the token is printed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { UPDATER_PORT } from "@openlife/contracts/updates/protocol";
import { UPDATE_STATE_FILE } from "@openlife/contracts/updates/state";
import { createEngineClient } from "./docker/engine-client.js";
import { createProjectScope } from "./docker/project-scope.js";
import { openJournal } from "./journal/journal.js";
import { createUpdaterServer, type AppView, type UpdaterLogger } from "./server/updater-server.js";

const SOCKET = "/var/run/docker.sock";
const CONTROL_DIR = "/control";
const TOKEN = /^[0-9a-f]{64}$/i;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

function fail(code: string, fields: readonly string[]): never {
  console.error(JSON.stringify({ event: "updater.start_failed", code, fields }));
  process.exit(1);
}

const token = process.env["UPDATER_TOKEN"];
const project = process.env["COMPOSE_PROJECT_NAME"];
if (token === undefined || !TOKEN.test(token)) fail("CONFIG_INVALID", ["UPDATER_TOKEN"]);
if (project === undefined || !PROJECT.test(project)) fail("CONFIG_INVALID", ["COMPOSE_PROJECT_NAME"]);

mkdirSync(CONTROL_DIR, { recursive: true });
const journal = openJournal(CONTROL_DIR);
if (!journal.read().ok) fail("JOURNAL_UNREADABLE", [path.join(CONTROL_DIR, UPDATE_STATE_FILE)]);

const scope = createProjectScope({ client: createEngineClient(SOCKET), project });
const appView = async (): Promise<AppView> => {
  const app = await scope.findApp();
  const state = (await scope.inspectApp(app.id)).State;
  return { running: state.Running, health: state.Health?.Status ?? null };
};
const logger: UpdaterLogger = { log: (event) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event })) };

const server = createUpdaterServer({ token, journal, appView, nowMs: Date.now, startedAtMs: Date.now(), logger });
server.listen(UPDATER_PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "updater.listening", port: UPDATER_PORT })));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
