// D37.1 — the hub of the live stream and the events of its contract (Architektura §10, §13.4).
// AC1: an event is written as the wire carries it and read back as the same event; a block that is
//      none of ours, or whose data are not the data of its event, is not an event.
// AC2: a session holds at most the number of streams it is allowed, a closed one frees its place, a
//      stream that cannot be written to is dropped without taking the others down, and ending a token
//      or the server ends exactly the streams it names.
import { decodeLiveEvent, encodeLiveEvent, LIVE_EVENT_NAMES, type LiveEvent } from "@openlife/contracts/http/stream";
import { describe, expect, it } from "vitest";
import { createLiveHub, type LiveListener } from "../../../apps/server/src/adapters/events/live-hub.js";

function listener(sessionId: string, token = `${sessionId}-token`) {
  const sent: LiveEvent[] = [];
  const state = { closed: 0, failing: false };
  const value: LiveListener = {
    sessionId,
    token,
    send: (event) => {
      if (state.failing) throw new Error("not writable");
      sent.push(event);
    },
    close: () => {
      state.closed += 1;
    },
  };
  return { value, sent, state };
}

describe("D37.1-AC1 the events of the contract", () => {
  const EVENTS: readonly LiveEvent[] = [
    { type: "ready" },
    { type: "ping" },
    { type: "data.changed", registry: "reg-1" },
    { type: "config.changed", symbol: "waga" },
    { type: "schema.changed", registry: "reg-1" },
    { type: "layout.changed", screenId: "scr-1" },
    { type: "day.changed" },
    { type: "update.available", version: "1.2.3" },
  ];

  it("every event of the architecture is written as `event:` and `data:` lines and read back as itself", () => {
    expect(EVENTS.map((event) => event.type)).toEqual([...LIVE_EVENT_NAMES]);
    for (const event of EVENTS) {
      const wire = encodeLiveEvent(event);
      expect(wire.endsWith("\n\n")).toBe(true);
      const name = /^event: (.+)$/m.exec(wire)?.[1] ?? "";
      const data = /^data: (.*)$/m.exec(wire)?.[1] ?? "";
      expect(decodeLiveEvent(name, data)).toEqual(event);
    }
    expect(encodeLiveEvent({ type: "data.changed", registry: "reg-1" })).toBe('event: data.changed\ndata: {"registry":"reg-1"}\n\n');
  });

  it("a name that is not ours, data that are not JSON, a missing or an extra field are not events", () => {
    expect(decodeLiveEvent("record.created", "{}")).toBeNull();
    expect(decodeLiveEvent("data.changed", "not json")).toBeNull();
    expect(decodeLiveEvent("data.changed", "[]")).toBeNull();
    expect(decodeLiveEvent("data.changed", "{}")).toBeNull();
    expect(decodeLiveEvent("ping", '{"registry":"reg-1"}')).toBeNull();
    expect(decodeLiveEvent("data.changed", '{"registry":"reg-1","values":{"title":"Dune"}}')).toBeNull();
  });
});

describe("D37.1-AC2 who is listening", () => {
  it("a session holds at most the allowed number of streams, a closed one frees its place and another session is not counted with it", () => {
    const hub = createLiveHub({ perSession: 2 });
    const first = hub.subscribe(listener("s-1").value);
    const second = hub.subscribe(listener("s-1").value);
    expect([first.accepted, second.accepted]).toEqual([true, true]);
    expect(hub.subscribe(listener("s-1").value)).toEqual({ accepted: false });
    expect(hub.subscribe(listener("s-2").value).accepted).toBe(true);
    expect([hub.count("s-1"), hub.count("s-2")]).toEqual([2, 1]);
    if (first.accepted) first.unsubscribe();
    expect(hub.count("s-1")).toBe(1);
    expect(hub.subscribe(listener("s-1").value).accepted).toBe(true);
    expect(hub.count("s-1")).toBe(2);
  });

  it("an event reaches every open stream, and one that cannot be written to is dropped and ended without stopping the rest", () => {
    const hub = createLiveHub({ perSession: 5 });
    const good = listener("s-1");
    const broken = listener("s-2");
    const other = listener("s-3");
    for (const each of [good, broken, other]) hub.subscribe(each.value);
    broken.state.failing = true;
    hub.publish({ type: "data.changed", registry: "reg-1" });
    expect(good.sent).toEqual([{ type: "data.changed", registry: "reg-1" }]);
    expect(other.sent).toEqual([{ type: "data.changed", registry: "reg-1" }]);
    expect(broken.state.closed).toBe(1);
    expect(hub.count("s-2")).toBe(0);
    hub.publish({ type: "day.changed" });
    expect(good.sent).toHaveLength(2);
  });

  it("ending a token ends the streams opened with it and no other; ending all ends every stream once", () => {
    const hub = createLiveHub({ perSession: 5 });
    const a1 = listener("s-1", "token-a");
    const a2 = listener("s-1", "token-a");
    const b = listener("s-2", "token-b");
    for (const each of [a1, a2, b]) hub.subscribe(each.value);
    hub.closeToken("token-a");
    expect([a1.state.closed, a2.state.closed, b.state.closed]).toEqual([1, 1, 0]);
    expect([hub.count("s-1"), hub.count("s-2")]).toEqual([0, 1]);
    hub.closeToken("token-unknown");
    hub.closeAll();
    hub.closeAll();
    expect([a1.state.closed, a2.state.closed, b.state.closed]).toEqual([1, 1, 1]);
    expect(hub.count("s-2")).toBe(0);
  });
});
