// D37.2 — the live stream of one tab (Scope §5.4 S11; Architektura §7.6, §10): the states it goes through,
// the wait before each new attempt, the return of a tab, the session that has ended, and nothing left
// behind after it stops. The browser's pieces are a fake host with its own clock.
import type { LiveEvent } from "@openlife/contracts/http/stream";
import { STREAM_PING_INTERVAL_MS } from "@openlife/contracts/http/stream";
import { describe, expect, it } from "vitest";
import { RECONNECT_DELAYS_MS, RESUME_QUIET_LIMIT_MS, STREAM_SILENCE_LIMIT_MS } from "../../../apps/web/src/lib/live/limits.js";
import { startLiveStream, type LiveHost, type LiveState } from "../../../apps/web/src/lib/live/live-stream.js";

type Source = { handlers: { onEvent: (event: LiveEvent) => void; onError: () => void }; closed: boolean };

function rig(session: () => boolean | null = () => true) {
  let time = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sources: Source[] = [];
  const resumes = new Set<() => void>();
  const states: LiveState[] = [];
  let resyncs = 0;
  let sessionLost = 0;
  const host: LiveHost = {
    now: () => time,
    setTimeout: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, run });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    open: (handlers) => {
      const source: Source = { handlers, closed: false };
      sources.push(source);
      return { close: () => (source.closed = true) };
    },
    onResume: (run) => {
      resumes.add(run);
      return () => void resumes.delete(run);
    },
    sessionHolds: () => Promise.resolve(session()),
  };
  const stop = startLiveStream(host, { onState: (state) => states.push(state), onResync: () => (resyncs += 1), onSessionLost: () => (sessionLost += 1) });
  /** Moves the clock and runs every timer that falls due, in order, letting the answers of the server settle between them. */
  const advance = async (ms: number): Promise<void> => {
    const end = time + ms;
    for (;;) {
      await Promise.resolve();
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      time = Math.max(time, due[1].at);
      due[1].run();
    }
    time = end;
    await Promise.resolve();
    await Promise.resolve();
  };
  const current = (): Source => sources[sources.length - 1]!;
  return {
    stop,
    advance,
    current,
    sources,
    states,
    timers: () => timers.size,
    listeners: () => resumes.size,
    open: () => sources.filter((source) => !source.closed).length,
    resyncs: () => resyncs,
    sessionLost: () => sessionLost,
    resume: () => resumes.forEach((run) => run()),
    ready: () => current().handlers.onEvent({ type: "ready" }),
    ping: () => current().handlers.onEvent({ type: "ping" }),
    fail: () => current().handlers.onError(),
    state: () => states[states.length - 1],
  };
}

describe("D37.2 the states of the stream", () => {
  it("one connection from the start: connecting, then live at `ready`, and no refresh for a first connection", () => {
    const stream = rig();
    expect(stream.sources).toHaveLength(1);
    expect(stream.state()).toBe("connecting");
    stream.ready();
    expect(stream.state()).toBe("live");
    stream.ping();
    expect(stream.state()).toBe("live");
    expect(stream.resyncs()).toBe(0);
    expect(stream.open()).toBe(1);
    stream.stop();
  });

  it("a lost stream is offline at once, tried again after growing waits, and after its return the data is read again once", async () => {
    const stream = rig();
    stream.ready();
    stream.fail();
    await stream.advance(0);
    expect(stream.state()).toBe("offline");
    expect(stream.open()).toBe(0);

    // Each failed attempt waits longer than the one before, up to the last wait of the list.
    const waits = [...RECONNECT_DELAYS_MS, RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1]!];
    for (const [attempt, wait] of waits.entries()) {
      await stream.advance(wait - 1);
      expect(stream.sources, `before the wait ${attempt + 1}`).toHaveLength(attempt + 1);
      await stream.advance(1);
      expect(stream.sources, `after the wait ${attempt + 1}`).toHaveLength(attempt + 2);
      stream.fail();
      await stream.advance(0);
    }
    expect(stream.state()).toBe("offline");
    expect(stream.resyncs()).toBe(0);

    await stream.advance(waits[waits.length - 1]!);
    stream.ready();
    expect(stream.state()).toBe("live");
    expect(stream.resyncs()).toBe(1);
    stream.ping();
    expect(stream.resyncs()).toBe(1);
    stream.stop();
  });

  it("the waits start again after a stream has been live", async () => {
    const stream = rig();
    stream.fail();
    await stream.advance(RECONNECT_DELAYS_MS[0]!);
    stream.fail();
    await stream.advance(RECONNECT_DELAYS_MS[1]!);
    stream.ready();
    stream.fail();
    await stream.advance(0);
    const before = stream.sources.length;
    await stream.advance(RECONNECT_DELAYS_MS[0]!);
    expect(stream.sources).toHaveLength(before + 1);
    stream.stop();
  });

  it("a stream that goes silent is taken for lost after two pings and the slack, not before", async () => {
    const stream = rig();
    stream.ready();
    await stream.advance(STREAM_PING_INTERVAL_MS);
    stream.ping();
    await stream.advance(STREAM_SILENCE_LIMIT_MS - 1);
    expect(stream.state()).toBe("live");
    await stream.advance(1);
    expect(stream.state()).toBe("offline");
    expect(stream.open()).toBe(0);
    stream.stop();
  });
});

describe("D37.2 the return of a tab", () => {
  it("focus, visibility or `online` while offline connects at once, without the wait", async () => {
    const stream = rig();
    stream.ready();
    stream.fail();
    await stream.advance(0);
    expect(stream.sources).toHaveLength(1);
    stream.resume();
    expect(stream.sources).toHaveLength(2);
    expect(stream.state()).toBe("offline");
    stream.ready();
    expect(stream.state()).toBe("live");
    expect(stream.resyncs()).toBe(1);
    stream.stop();
  });

  it("a live stream that spoke a moment ago is left alone; one that has been quiet longer than a ping is connected again and the data read again", async () => {
    const stream = rig();
    stream.ready();
    await stream.advance(RESUME_QUIET_LIMIT_MS - 1);
    stream.resume();
    expect(stream.sources).toHaveLength(1);

    await stream.advance(2);
    stream.resume();
    expect(stream.sources).toHaveLength(2);
    expect(stream.sources[0]!.closed).toBe(true);
    expect(stream.state()).toBe("connecting");
    stream.ready();
    expect(stream.state()).toBe("live");
    expect(stream.resyncs()).toBe(1);
    stream.stop();
  });

  it("the late word of a connection that was replaced changes nothing", async () => {
    const stream = rig();
    stream.fail();
    await stream.advance(0);
    const old = stream.current();
    stream.resume();
    stream.ready();
    expect(stream.state()).toBe("live");
    old.handlers.onError();
    old.handlers.onEvent({ type: "ready" });
    await stream.advance(0);
    expect(stream.state()).toBe("live");
    expect(stream.open()).toBe(1);
    stream.stop();
  });
});

describe("D37.2 the session that has ended", () => {
  it("a lost stream with a session the server no longer holds stops for good and tells the application once", async () => {
    let holds: boolean | null = true;
    const stream = rig(() => holds);
    stream.ready();
    holds = false;
    stream.fail();
    await stream.advance(0);
    expect(stream.sessionLost()).toBe(1);
    expect(stream.state()).toBe("idle");
    expect(stream.timers()).toBe(0);
    expect(stream.listeners()).toBe(0);
    expect(stream.open()).toBe(0);
    await stream.advance(60_000);
    stream.resume();
    expect(stream.sources).toHaveLength(1);
    expect(stream.sessionLost()).toBe(1);
  });

  it("a server that cannot be asked, or that still holds the session, does not end the stream", async () => {
    for (const holds of [true, null]) {
      const stream = rig(() => holds);
      stream.fail();
      await stream.advance(RECONNECT_DELAYS_MS[0]!);
      expect(stream.sources, String(holds)).toHaveLength(2);
      expect(stream.sessionLost()).toBe(0);
      stream.stop();
    }
  });
});

describe("D37.2 nothing is left behind", () => {
  it("stopping closes the connection and leaves no timer and no listener, also in the middle of a wait", async () => {
    const stream = rig();
    stream.ready();
    stream.fail();
    await stream.advance(0);
    expect(stream.timers()).toBe(1);
    stream.stop();
    expect(stream.timers()).toBe(0);
    expect(stream.listeners()).toBe(0);
    expect(stream.open()).toBe(0);
    expect(stream.state()).toBe("idle");
    stream.stop();
  });

  it("many cycles of loss and return keep one connection, one silence timer and one listener", async () => {
    const stream = rig();
    stream.ready();
    for (let cycle = 0; cycle < 40; cycle += 1) {
      stream.fail();
      await stream.advance(0);
      stream.resume();
      stream.ready();
      stream.resume();
    }
    expect(stream.open()).toBe(1);
    expect(stream.timers()).toBe(1);
    expect(stream.listeners()).toBe(1);
    expect(stream.state()).toBe("live");
    expect(stream.resyncs()).toBe(40);
    stream.stop();
    expect(stream.timers()).toBe(0);
    expect(stream.listeners()).toBe(0);
  });
});
