// The updater process (Architektura §11.2.1, §12.1; D52.5): the composition root. It reads its few settings from the
// environment the Compose service gives it, opens the journal in its own control folder, finds its own project's app
// through the scope of the Docker adapter and listens on the internal network. It never starts without a token of
// the right shape, and it refuses a journal it cannot read. Nothing of the token is printed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { UPDATER_PORT } from "@openlife/contracts/updates/protocol";
import { UPDATE_STATE_FILE } from "@openlife/contracts/updates/state";
import { createEngineClient } from "./docker/engine-client.js";
import { createProjectScope, ScopeError } from "./docker/project-scope.js";
import { createReleasePreparer } from "./install/prepare-release.js";
import { openJournal } from "./journal/journal.js";
import type { UpdaterLogger } from "./logging.js";
import { createUpdaterServer, type AppView } from "./server/updater-server.js";

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
const logger: UpdaterLogger = { log: (event) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...event })) };
const appView = async (): Promise<AppView> => {
  try {
    const app = await scope.findApp();
    const state = (await scope.inspectApp(app.id)).State;
    return { running: state.Running, health: state.Health?.Status ?? null };
  } catch (error) {
    // The status answers without the app, and the log says why in a code, never in the text of the error (it may name a path).
    const code = error instanceof ScopeError ? error.code : (error as NodeJS.ErrnoException).code ?? "ENGINE_UNAVAILABLE";
    logger.log({ level: "warn", event: "updater.app_view_failed", code: String(code) });
    return null;
  }
};

const installer = createReleasePreparer({ journal, catalogDir: CONTROL_DIR, scope, nowIso: () => new Date().toISOString(), logger });
const server = createUpdaterServer({ token, journal, appView, nowMs: Date.now, startedAtMs: Date.now(), logger, installer });
server.listen(UPDATER_PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "updater.listening", port: UPDATER_PORT })));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
