// The live stream of one tab (Scope §5.4 S11; Architektura §7.6, §10; D37.2): one connection, the state
// it is in, and the way back when it is lost. The browser's own pieces (EventSource, timers, the events
// of the page, the question to the server) come in as a host, so the logic is the same in the browser
// and under test. An event of data is not handled here; D38 hands them on.
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { RECONNECT_DELAYS_MS, RESUME_QUIET_LIMIT_MS, STREAM_SILENCE_LIMIT_MS } from "./limits.js";

/** `connecting`: the first attempt; `live`: the server said `ready` and keeps pinging; `offline`: lost, trying again; `idle`: not started or stopped. */
export type LiveState = "idle" | "connecting" | "live" | "offline";

export type LiveConnection = Readonly<{ close: () => void }>;

export type LiveHost = Readonly<{
  now: () => number;
  setTimeout: (run: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  /** Opens the stream; the connection reports every event it decodes and the one error it ends with. */
  open: (handlers: Readonly<{ onEvent: (event: LiveEvent) => void; onError: () => void }>) => LiveConnection;
  /** Calls `run` when the tab comes back, takes the focus or goes online; returns how to stop. */
  onResume: (run: () => void) => () => void;
  /** After a lost stream: does the server still hold the session (`true`), has it ended (`false`), or could it not be asked (`null`)? A stream cannot tell the end of a session from a lost network. */
  sessionHolds: () => Promise<boolean | null>;
}>;

export type LiveCallbacks = Readonly<{
  onState: (state: LiveState) => void;
  /** The stream is back after a loss: what the tab shows may have changed meanwhile, nothing is replayed. */
  onResync: () => void;
  /** The server says the session has ended; the stream is stopped and does not come back. */
  onSessionLost: () => void;
}>;

/** Starts the stream of this tab and returns how to stop it; stopping leaves no timer, no listener and no connection. */
export function startLiveStream(host: LiveHost, callbacks: LiveCallbacks): () => void {
  let state: LiveState = "idle";
  let connection: LiveConnection | null = null;
  let retryTimer: number | null = null;
  let silenceTimer: number | null = null;
  let lastEventAt = host.now();
  let failures = 0;
  let resyncOnReady = false;
  let stopped = false;
  /** Counts the connections and the questions to the server; the answer of an older one is dropped. */
  let epoch = 0;

  const setState = (next: LiveState): void => {
    if (next === state) return;
    state = next;
    callbacks.onState(next);
  };
  const clearTimers = (): void => {
    if (retryTimer !== null) host.clearTimeout(retryTimer);
    if (silenceTimer !== null) host.clearTimeout(silenceTimer);
    retryTimer = null;
    silenceTimer = null;
  };
  const closeConnection = (): void => {
    connection?.close();
    connection = null;
  };
  const armSilence = (): void => {
    if (silenceTimer !== null) host.clearTimeout(silenceTimer);
    silenceTimer = host.setTimeout(() => {
      silenceTimer = null;
      lost();
    }, STREAM_SILENCE_LIMIT_MS);
  };

  function connect(): void {
    clearTimers();
    closeConnection();
    epoch += 1;
    const mine = epoch;
    if (state !== "offline") setState("connecting");
    lastEventAt = host.now();
    armSilence();
    connection = host.open({
      onEvent: (event) => {
        if (mine === epoch) received(event);
      },
      onError: () => {
        if (mine === epoch) lost();
      },
    });
  }

  function received(event: LiveEvent): void {
    lastEventAt = host.now();
    armSilence();
    if (event.type !== "ready") return;
    failures = 0;
    setState("live");
    if (resyncOnReady) {
      resyncOnReady = false;
      callbacks.onResync();
    }
  }

  /** The stream ended or went silent: ask whether the session holds, then try again after the wait of the attempt. */
  function lost(): void {
    clearTimers();
    closeConnection();
    epoch += 1;
    const mine = epoch;
    resyncOnReady = true;
    setState("offline");
    void host.sessionHolds().then((holds) => {
      if (stopped || mine !== epoch) return;
      if (holds === false) {
        stop();
        callbacks.onSessionLost();
        return;
      }
      const wait = RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] ?? 0;
      failures += 1;
      retryTimer = host.setTimeout(() => {
        retryTimer = null;
        connect();
      }, wait);
    });
  }

  const stopResume = host.onResume(() => {
    if (stopped) return;
    if (state === "offline") {
      failures = 0;
      connect();
    } else if (host.now() - lastEventAt > RESUME_QUIET_LIMIT_MS) {
      resyncOnReady = true;
      connect();
    }
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    epoch += 1;
    clearTimers();
    closeConnection();
    stopResume();
    setState("idle");
  }

  connect();
  return stop;
}
