// The server of the updater (Architektura §11.2.1; D52.5): one route for commands and one for the health of the
// container, on the internal network of the installation and never published. A request is read to a bound, taken
// apart by `verifyCommand`, and only a verified envelope reaches the journal. The answer is a status or a code and
// nothing of the request; the log holds events and codes and never the token, the signature or a body. A command
// whose time is before the start of this process is refused as stale: the table of nonces lives in memory, so the
// commands the process might have seen before a restart must not be accepted again.
import http from "node:http";
import { UPDATER_BODY_MAX_BYTES, UPDATER_CLOCK_SKEW_MS, UPDATER_COMMAND_METHOD, UPDATER_COMMAND_PATH, UPDATER_HEALTH_PATH, UPDATER_SIGNATURE_HEADER, type UpdaterEnvelope, type UpdaterStatus } from "@openlife/contracts/updates/protocol";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { ReleasePreparer } from "../install/prepare-release.js";
import type { ProgressHandler } from "../install/progress.js";
import type { ReleaseSwitcher } from "../install/switch-release.js";
import type { Journal } from "../journal/journal.js";
import type { UpdaterLogEvent, UpdaterLogger } from "../logging.js";
import { createReplayCache } from "../protocol/replay-cache.js";
import { verifyCommand } from "../protocol/verify-command.js";
import { beginInstall } from "../state-machine/begin.js";
import { initialRecord } from "../state-machine/transitions.js";

const REPLAY_CAPACITY = 10_000;

export type AppView = Readonly<{ running: boolean; health: string | null }> | null;
export type { UpdaterLogEvent, UpdaterLogger };

export type UpdaterServerOptions = Readonly<{
  token: string;
  journal: Journal;
  /** The app of this project as Docker shows it, or null when it is not exactly one; never throws into a request. */
  appView: () => Promise<AppView>;
  nowMs: () => number;
  startedAtMs: number;
  logger: UpdaterLogger;
  /** Drives an accepted operation through its first steps in the background; the command is answered before they are done. */
  installer: ReleasePreparer;
  /** What the app reports between the pull and the switch: quiet, copy taken, or given up (D54.2). */
  progress: ProgressHandler;
  /** Replaces the app by the release once the copy is taken (D55.1). */
  switcher: ReleaseSwitcher;
}>;

const statusOf = (record: UpdateRecord, app: AppView): UpdaterStatus => ({ state: record.state, operationId: record.operationId, fence: record.fence, targetRelease: record.targetRelease, error: record.error, app });

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  response.end(text);
}

/** The body of a request up to the bound; a larger one is cut and reported, never held. */
function readBody(request: http.IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > UPDATER_BODY_MAX_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    request.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), tooLarge }));
    request.on("error", () => resolve({ text: "", tooLarge: true }));
  });
}

export function createUpdaterServer(options: UpdaterServerOptions): http.Server {
  const replay = createReplayCache({ windowMs: 2 * UPDATER_CLOCK_SKEW_MS, maxEntries: REPLAY_CAPACITY });
  /** The operations this process is driving now; after a restart an operation of the journal is driven again when it is asked for again. */
  const driving = new Set<string>();

  /** What the updater does by itself in a state: the pull while the app serves, the switch once the copy is taken. */
  const stepOf = (record: UpdateRecord): ((record: UpdateRecord) => Promise<void>) | null => {
    if (record.state === "checking" || record.state === "pulling") return options.installer.prepare;
    // A switch that has begun (the containers are on the journal) is not made again by asking: what is left of it is for the recovery (D56).
    if (record.state === "switching" && (record.replacement ?? null) === null) return options.switcher.run;
    return null;
  };

  function drive(record: UpdateRecord): void {
    const id = record.operationId;
    const step = stepOf(record);
    if (id === null || step === null || driving.has(id)) return;
    driving.add(id);
    void step(record)
      .catch(() => options.logger.log({ level: "error", event: "updater.step_failed", code: "STEP_FAILED", operationId: id }))
      .finally(() => driving.delete(id));
  }

  /** The record the journal holds, or the first of a new installation; an unreadable journal is no record and nothing is done. */
  function current(): UpdateRecord | null {
    const read = options.journal.read();
    if (!read.ok) return null;
    return read.record ?? initialRecord(new Date(options.nowMs()).toISOString());
  }

  async function command(envelope: UpdaterEnvelope, response: http.ServerResponse): Promise<void> {
    const record = current();
    if (record === null) {
      options.logger.log({ level: "error", event: "updater.journal_unreadable", code: "JOURNAL_UNREADABLE" });
      send(response, 503, { code: "JOURNAL_UNREADABLE" });
      return;
    }
    if (envelope.command.type === "status") {
      send(response, 200, statusOf(record, await options.appView().catch(() => null)));
      return;
    }
    if (envelope.command.type !== "install") {
      const result = await options.progress.handle(envelope);
      if (result === "JOURNAL_UNREADABLE") {
        send(response, 503, { code: "JOURNAL_UNREADABLE" });
        return;
      }
      if (!result.ok) {
        options.logger.log({ level: "warn", event: "updater.progress_refused", code: result.code, operationId: envelope.operationId });
        // A refusal that closed the operation tells the app so with the state, so it can open its writes; the others leave the record as it is.
        send(response, 409, { code: result.code, state: result.record.state, operationId: result.record.operationId, fence: result.record.fence });
        return;
      }
      options.logger.log({ level: "info", event: "updater.progress_accepted", operationId: envelope.operationId });
      drive(result.record);
      send(response, 200, statusOf(result.record, await options.appView().catch(() => null)));
      return;
    }
    const nowIso = new Date(options.nowMs()).toISOString();
    const begun = beginInstall(record, envelope, nowIso);
    if (!begun.ok) {
      options.logger.log({ level: "warn", event: "updater.install_refused", code: begun.code, operationId: envelope.operationId });
      send(response, 409, { code: begun.code });
      return;
    }
    if (begun.resumed) {
      drive(begun.record);
      send(response, 202, statusOf(begun.record, await options.appView().catch(() => null)));
      return;
    }
    // The operation is on the record before anything else happens to it: a crash after this line leaves a record that says so.
    options.journal.write(begun.record);
    options.logger.log({ level: "info", event: "updater.install_begun", operationId: envelope.operationId });
    drive(begun.record);
    send(response, 202, statusOf(begun.record, await options.appView().catch(() => null)));
  }

  return http.createServer((request, response) => {
    void (async () => {
      try {
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (request.method === "GET" && path === UPDATER_HEALTH_PATH) {
          send(response, 200, { status: "ok" });
          return;
        }
        if (path !== UPDATER_COMMAND_PATH) {
          send(response, 404, { code: "NOT_FOUND" });
          return;
        }
        if (request.method !== UPDATER_COMMAND_METHOD) {
          response.setHeader("Allow", UPDATER_COMMAND_METHOD);
          send(response, 405, { code: "METHOD_NOT_ALLOWED" });
          return;
        }
        const body = await readBody(request);
        const signature = request.headers[UPDATER_SIGNATURE_HEADER];
        const verified = body.tooLarge
          ? ({ ok: false, code: "MALFORMED" } as const)
          : verifyCommand({ method: request.method, path, signatureHeader: typeof signature === "string" ? signature : undefined, body: body.text }, { token: options.token, nowMs: options.nowMs(), replay });
        if (!verified.ok) {
          options.logger.log({ level: "warn", event: "updater.command_refused", code: verified.code });
          send(response, verified.code === "MALFORMED" ? 400 : verified.code === "REPLAY_CACHE_FULL" ? 503 : 401, { code: verified.code });
          return;
        }
        if (verified.envelope.issuedAt < options.startedAtMs) {
          options.logger.log({ level: "warn", event: "updater.command_refused", code: "STALE" });
          send(response, 401, { code: "STALE" });
          return;
        }
        await command(verified.envelope, response);
      } catch {
        options.logger.log({ level: "error", event: "updater.request_failed", code: "UPDATER_FAILED" });
        if (!response.headersSent) send(response, 500, { code: "UPDATER_FAILED" });
      }
    })();
  });
}
