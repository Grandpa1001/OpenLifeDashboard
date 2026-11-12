// The in-process hub of the live stream (Architektura §10, §13.4; D37): who listens, how many streams a
// session holds, and the events sent to them. An event is published only after the commit it tells of
// (D38 does the publishing); nothing is kept for a listener that is not there, so a tab that connects
// again reads its data again.
import type { LiveEvent } from "@openlife/contracts/http/stream";

/** One open stream: where its events go and how it is ended. */
export type LiveListener = Readonly<{
  sessionId: string;
  /** The cookie token the stream was opened with, so that ending the session can end its streams. */
  token: string;
  send: (event: LiveEvent) => void;
  close: () => void;
}>;

/** What a route calls once a change is committed: tells the open streams of it (D38). */
export type Announce = (event: LiveEvent) => void;

export type LiveHub = Readonly<{
  /** Registers a listener unless its session already holds the most; the returned function removes it. */
  subscribe: (listener: LiveListener) => { accepted: true; unsubscribe: () => void } | { accepted: false };
  /** Sends the event to every open stream. */
  publish: (event: LiveEvent) => void;
  /** Ends the streams opened with this token (the session ended). */
  closeToken: (token: string) => void;
  /** Ends every stream (the server stops). */
  closeAll: () => void;
  /** Streams held by the session now. */
  count: (sessionId: string) => number;
  /** Streams open now, of every session. */
  total: () => number;
}>;

export function createLiveHub(options: Readonly<{ perSession: number }>): LiveHub {
  const bySession = new Map<string, Set<LiveListener>>();
  const remove = (listener: LiveListener): void => {
    const held = bySession.get(listener.sessionId);
    if (held === undefined) return;
    held.delete(listener);
    if (held.size === 0) bySession.delete(listener.sessionId);
  };
  const close = (listeners: readonly LiveListener[]): void => {
    for (const listener of listeners) {
      remove(listener);
      listener.close();
    }
  };
  return {
    subscribe: (listener) => {
      const held = bySession.get(listener.sessionId) ?? new Set<LiveListener>();
      if (held.size >= options.perSession) return { accepted: false };
      held.add(listener);
      bySession.set(listener.sessionId, held);
      return { accepted: true, unsubscribe: () => remove(listener) };
    },
    publish: (event) => {
      for (const held of [...bySession.values()]) {
        for (const listener of [...held]) {
          try {
            listener.send(event);
          } catch {
            // A stream that cannot be written to is gone; its own cleanup removes it, the others still get the event.
            close([listener]);
          }
        }
      }
    },
    closeToken: (token) => close([...bySession.values()].flatMap((held) => [...held]).filter((listener) => listener.token === token)),
    closeAll: () => close([...bySession.values()].flatMap((held) => [...held])),
    count: (sessionId) => bySession.get(sessionId)?.size ?? 0,
    total: () => [...bySession.values()].reduce((sum, held) => sum + held.size, 0),
  };
}
