// The live stream's host in the browser: EventSource on the stream path, the real timers, the events of
// the page that mean "look again", and the question to the server about the session.
import { decodeLiveEvent, LIVE_EVENT_NAMES, STREAM_PATH } from "@openlife/contracts/http/stream";
import { fetchIdentityStatus } from "../session/identity-api.js";
import type { LiveHost } from "./live-stream.js";

export function browserLiveHost(): LiveHost {
  return {
    now: () => Date.now(),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (id) => window.clearTimeout(id),
    open: (handlers) => {
      // The browser would reconnect by itself, without a wait and without asking about the session; the manager does it, so the source is closed at the first error.
      const source = new EventSource(STREAM_PATH);
      for (const name of LIVE_EVENT_NAMES) {
        source.addEventListener(name, (message) => {
          const event = decodeLiveEvent(name, (message as MessageEvent<string>).data);
          if (event !== null) handlers.onEvent(event);
        });
      }
      source.onerror = () => handlers.onError();
      return { close: () => source.close() };
    },
    onResume: (run) => {
      const onVisible = (): void => {
        if (document.visibilityState === "visible") run();
      };
      window.addEventListener("focus", run);
      window.addEventListener("online", run);
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        window.removeEventListener("focus", run);
        window.removeEventListener("online", run);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
    sessionHolds: async () => {
      const result = await fetchIdentityStatus();
      if (result.ok) return result.value.nextAction === "ready";
      return result.failure.kind === "api" && (result.failure.status === 401 || result.failure.status === 403) ? false : null;
    },
  };
}
