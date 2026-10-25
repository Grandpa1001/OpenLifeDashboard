// D06.3 — the shutdown sequence (Architektura §15.2) with a fake clock.
// AC1: steps run one after another in the given order, each reported; the success event comes
//      only after the last step, then exit 0; a second signal changes nothing.
// AC2: past the deadline the process exits 1 naming the step it was stuck in and NEVER reports
//      success, even when that step finishes later; a failing step ends with exit 1 and a code
//      only (no message) and the later steps (the lease) are not run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownStep } from "../../../apps/server/src/bootstrap/shutdown.js";

const TIMEOUT_MS = 15_000;
type Reported = { event: string; stream: "stdout" | "stderr"; [key: string]: unknown };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function harness(steps: readonly ShutdownStep[]) {
  const reported: Reported[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    steps,
    timeoutMs: TIMEOUT_MS,
    report: (event, stream) => reported.push({ ...(event as { event: string }), stream }),
    exit: (code) => void exits.push(code),
  });
  return { shutdown, reported, exits, events: () => reported.map((entry) => entry.event) };
}

const recording = (calls: string[], name: string): ShutdownStep => ({ name, run: () => void calls.push(name) });

describe("D06.3-AC1 an orderly stop", () => {
  it("runs the steps in order, reports each, reports success after the last and exits 0", async () => {
    const calls: string[] = [];
    const h = harness(["readiness", "http", "logger", "database", "lease"].map((name) => recording(calls, name)));
    await h.shutdown("SIGTERM");
    expect(calls).toEqual(["readiness", "http", "logger", "database", "lease"]);
    expect(h.reported).toEqual([
      { event: "server.stopping", signal: "SIGTERM", stream: "stdout" },
      ...calls.map((step) => ({ event: "shutdown.step", step, stream: "stdout" })),
      { event: "server.stopped", stream: "stdout" },
    ]);
    expect(h.exits).toEqual([0]);
    // The deadline was cleared: nothing fires later.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(h.exits).toEqual([0]);
  });

  it("waits for an asynchronous step before the next one starts", async () => {
    const calls: string[] = [];
    let finishHttp: () => void = () => undefined;
    const h = harness([
      recording(calls, "readiness"),
      { name: "http", run: () => new Promise<void>((resolve) => void (finishHttp = resolve)) },
      recording(calls, "database"),
    ]);
    const running = h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual(["readiness"]);
    expect(h.events()).not.toContain("server.stopped");
    finishHttp();
    await running;
    expect(calls).toEqual(["readiness", "database"]);
    expect(h.exits).toEqual([0]);
  });

  it("readiness is withdrawn before anything asynchronous happens", async () => {
    const calls: string[] = [];
    const h = harness([recording(calls, "readiness"), { name: "http", run: () => new Promise<void>(() => undefined) }]);
    void h.shutdown("SIGTERM");
    expect(calls).toEqual(["readiness"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["readiness"]);
  });

  it("a second signal during the stop is ignored: one sequence, one exit", async () => {
    const calls: string[] = [];
    let finishHttp: () => void = () => undefined;
    const h = harness([{ name: "http", run: () => new Promise<void>((resolve) => void (finishHttp = resolve)) }, recording(calls, "lease")]);
    const first = h.shutdown("SIGTERM");
    await h.shutdown("SIGINT");
    finishHttp();
    await first;
    expect(h.events().filter((event) => event === "server.stopping")).toHaveLength(1);
    expect(calls).toEqual(["lease"]);
    expect(h.exits).toEqual([0]);
  });
});

describe("D06.3-AC2 a stop that does not succeed", () => {
  it("past the deadline: exit 1 naming the stuck step, and no success even if it finishes later", async () => {
    const calls: string[] = [];
    let finishHttp: () => void = () => undefined;
    const h = harness([
      recording(calls, "readiness"),
      { name: "http", run: () => new Promise<void>((resolve) => void (finishHttp = resolve)) },
      recording(calls, "database"),
      recording(calls, "lease"),
    ]);
    const running = h.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(h.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exits).toEqual([1]);
    expect(h.reported.at(-1)).toEqual({ event: "server.stop_timeout", timeoutMs: TIMEOUT_MS, step: "http", stream: "stderr" });

    // The stuck step finally returns: the process is already ending and claims nothing.
    finishHttp();
    await running;
    expect(h.events()).not.toContain("server.stopped");
    expect(h.events().filter((event) => event === "shutdown.step")).toEqual(["shutdown.step"]);
    expect(calls).toEqual(["readiness"]);
    expect(h.exits).toEqual([1]);
  });

  it("a step that throws: exit 1 with a class name only, later steps do not run", async () => {
    const calls: string[] = [];
    const h = harness([
      recording(calls, "readiness"),
      {
        name: "database",
        run: () => {
          throw new RangeError("password=hunter2 in /private/path");
        },
      },
      recording(calls, "lease"),
    ]);
    await h.shutdown("SIGTERM");
    expect(h.reported.at(-1)).toEqual({ event: "server.stop_failed", step: "database", error: "RangeError", stream: "stderr" });
    expect(JSON.stringify(h.reported)).not.toMatch(/hunter2|private/);
    expect(h.events()).not.toContain("server.stopped");
    expect(calls).toEqual(["readiness"]);
    expect(h.exits).toEqual([1]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(h.exits).toEqual([1]);
  });

  it("an asynchronous failure is handled the same way", async () => {
    const h = harness([{ name: "http", run: () => Promise.reject(new Error("socket reset by peer")) }]);
    await h.shutdown("SIGTERM");
    expect(h.reported.at(-1)).toEqual({ event: "server.stop_failed", step: "http", error: "Error", stream: "stderr" });
    expect(h.exits).toEqual([1]);
  });

  it("a thrown value that is not an error is reported as such, never its content", async () => {
    const h = harness([{ name: "http", run: () => Promise.reject("token abc123") }]);
    await h.shutdown("SIGTERM");
    expect(h.reported.at(-1)).toMatchObject({ event: "server.stop_failed", error: "NonErrorThrown" });
    expect(JSON.stringify(h.reported)).not.toContain("abc123");
  });
});
