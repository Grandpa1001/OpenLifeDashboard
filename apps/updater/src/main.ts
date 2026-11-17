// The updater process (Architektura §11.2.1, §12.1; D52.5): the composition root. It reads its few settings from the
// environment the Compose service gives it, opens the journal in its own control folder, finds its own project's app
// through the scope of the Docker adapter and listens on the internal network. It never starts without a token of
// the right shape, and it refuses a journal it cannot read. Nothing of the token is printed.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { UPDATER_PORT } from "@openlife/contracts/updates/protocol";
import { UPDATE_STATE_FILE } from "@openlife/contracts/updates/state";
import { START_TIMEOUT_ENV, startTimeoutOf } from "./config.js";
import { createEngineClient } from "./docker/engine-client.js";
import { createProjectScope, ScopeError } from "./docker/project-scope.js";
import { createReleasePreparer } from "./install/prepare-release.js";
import { createProgressHandler } from "./install/progress.js";
import { recoverOnStart } from "./install/recover.js";
import { createRollbackRunner } from "./install/roll-back.js";
import { createReleaseSwitcher } from "./install/switch-release.js";
import { openJournal } from "./journal/journal.js";
import type { UpdaterLogger } from "./logging.js";
import { createPreviousSelection } from "./release/previous-selection.js";
import { createUpdaterServer, type AppView } from "./server/updater-server.js";

const SOCKET = "/var/run/docker.sock";
const CONTROL_DIR = "/control";
const BACKUP_DIR = "/backup";
const TOKEN = /^[0-9a-f]{64}$/i;
const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

function fail(code: string, fields: readonly string[]): never {
  console.error(JSON.stringify({ event: "updater.start_failed", code, fields }));
  process.exit(1);
}

const startTimeout = startTimeoutOf(process.env);
if (!startTimeout.ok) fail("CONFIG_INVALID", [START_TIMEOUT_ENV]);
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
const rollback = createRollbackRunner({ journal, controlDir: CONTROL_DIR, scope, nowIso: () => new Date().toISOString(), logger });
const progress = createProgressHandler({ journal, catalogDir: CONTROL_DIR, backupDir: BACKUP_DIR, previousSelection: createPreviousSelection({ controlDir: CONTROL_DIR, scope }), onStopped: (record) => void rollback.run(record),
  discardPrevious: async (replacement) => {
    // Only the replaced app is removed, and only once the swap has finished (the new container is on the journal).
    if (replacement.nextId !== null) await scope.discardPrevious({ ...replacement, nextId: replacement.nextId });
  }, nowIso: () => new Date().toISOString() });
const switcher = createReleaseSwitcher({ journal, catalogDir: CONTROL_DIR, scope, nowIso: () => new Date().toISOString(), logger, onStopped: (record) => void rollback.run(record), watchScope: scope, startTimeoutMs: startTimeout.ms });
const server = createUpdaterServer({ token, journal, appView, nowMs: Date.now, startedAtMs: Date.now(), logger, installer, progress, switcher });
server.listen(UPDATER_PORT, "0.0.0.0", () => console.log(JSON.stringify({ event: "updater.listening", port: UPDATER_PORT })));
// What the journal says was going on when the updater last stopped is settled now, before anything else asks: no state opens the writes by default.
void recoverOnStart({ journal, rollback, switcher, discardPrevious: async (replacement) => { if (replacement.nextId !== null) await scope.discardPrevious({ ...replacement, nextId: replacement.nextId }); }, nowIso: () => new Date().toISOString(), logger });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
