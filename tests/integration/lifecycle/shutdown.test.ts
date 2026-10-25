// D06.3 — the real server process stopped by signals (Architektura §15.2).
// AC1: SIGTERM withdraws readiness first, stops accepting connections, lets a request that was in
//      progress finish (it is answered 503 unavailable by the withdrawn readiness), and then
//      flushes the logger, closes the database and gives up the writer lease LAST — shown by the
//      order of the events and by the lease becoming free only after the WAL is gone. Exit 0.
// AC2: a request that never finishes keeps the stop waiting until the 15 s deadline; the process
//      then exits 1 without the success event, the lease is free at once (the kernel released it),
//      and the next start finds an intact database.
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWriterLease } from "../../../apps/server/dist/adapters/filesystem/writer-lease.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { freshTestInstance, outputEvent, startBuiltServer, waitForExit, type ServerProcess } from "../../support/server-process.ts";

const DEADLINE_MS = 15_000;
const STEPS = ["readiness", "http", "logger", "database", "lease"];

type Event = { event?: string; [key: string]: unknown };
const eventsOf = (output: string): Event[] =>
  output.split("\n").flatMap((entry) => {
    try {
      const value: unknown = JSON.parse(entry);
      return typeof value === "object" && value !== null ? [value as Event] : [];
    } catch {
      return [];
    }
  });

/** A request whose headers are sent only in part: the server sees a request in progress. */
async function openUnfinishedRequest(server: ServerProcess) {
  const port = Number(new URL(server.baseUrl).port);
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  socket.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // The server must have READ these bytes before the test goes on, or it would take the
  // connection for idle. A full request on a new connection cannot be answered before the
  // server has read what was already waiting on this one, so its answer is the proof; waiting for
  // a fixed time instead fails on a loaded machine.
  expect((await fetch(`${server.baseUrl}/api/health`)).status).toBe(200);
  return {
    port,
    socket,
    /** Sends the rest of the headers and resolves with the whole response. */
    async complete(): Promise<string> {
      socket.write("\r\n");
      await closed;
      return received;
    },
  };
}

async function connectionRefused(port: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    const refused = await new Promise<boolean>((resolve) => {
      const probe = net.connect(port, "127.0.0.1");
      probe.once("connect", () => (probe.destroy(), resolve(false)));
      probe.once("error", () => resolve(true));
    });
    if (refused) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("D06.3-AC1 an orderly stop", () => {
  it("withdraws readiness, finishes the request in progress, then closes everything in order and exits 0", async () => {
    const instance = freshTestInstance();
    const server = await startBuiltServer({ installation: instance });
    expect((await fetch(`${server.baseUrl}/api/health`)).status).toBe(200);
    const inProgress = await openUnfinishedRequest(server);

    server.child.kill("SIGTERM");
    server.child.kill("SIGTERM"); // a second signal during the stop is ignored
    expect(await connectionRefused(inProgress.port, 5000)).toBe(true);
    expect(server.child.exitCode, "the request in progress keeps the process alive").toBeNull();

    // The request that began before the signal is finished — and sees readiness withdrawn.
    const finishedAt = Date.now();
    const response = await inProgress.complete();
    expect(response.split("\r\n")[0]).toBe("HTTP/1.1 503 Service Unavailable");
    expect(response).toContain('{"status":"unavailable"}');
    expect(response.toLowerCase()).toContain("cache-control: no-store");

    const exit = await waitForExit(server.child, server.output, DEADLINE_MS);
    expect(exit.code).toBe(0);
    // The connection became idle after the stop began: it is closed at once, not after the 5 s
    // keep-alive timeout of the HTTP server.
    expect(Date.now() - finishedAt).toBeLessThan(2000);
    const events = eventsOf(exit.output).filter((entry) => ["server.stopping", "shutdown.step", "server.stopped"].includes(entry.event ?? ""));
    expect(events).toEqual([
      { event: "server.stopping", signal: "SIGTERM" },
      ...STEPS.map((step) => ({ event: "shutdown.step", step })),
      { event: "server.stopped" },
    ]);
    expect(exit.output).not.toContain("stop_timeout");
  });

  it("the lease is given up last: when it becomes free the WAL is already gone and the database is intact", async () => {
    const instance = freshTestInstance();
    const server = await startBuiltServer({ installation: instance });
    await fetch(`${server.baseUrl}/api/nothing`);
    const maintenance = path.join(instance.dir, "control", "maintenance");
    const databaseFile = path.join(instance.dir, "data", "app.db");
    expect(existsSync(`${databaseFile}-wal`), "a running writer has its WAL").toBe(true);

    server.child.kill("SIGTERM");
    // Take the lease the instant it is free: nothing of the open database may still be there.
    let atLease: { wal: boolean; shm: boolean } | undefined;
    const deadline = Date.now() + DEADLINE_MS;
    while (atLease === undefined && Date.now() < deadline) {
      const lease = acquireWriterLease(maintenance);
      if (lease.ok) {
        atLease = { wal: existsSync(`${databaseFile}-wal`), shm: existsSync(`${databaseFile}-shm`) };
        lease.lease.release();
      }
    }
    expect(atLease).toEqual({ wal: false, shm: false });
    const exit = await waitForExit(server.child, server.output, DEADLINE_MS);
    expect(exit.code).toBe(0);

    const reader = openDatabase(databaseFile, { role: "writer", busyTimeoutMs: 5000 });
    expect(reader.handle.pragma("integrity_check", { simple: true })).toBe("ok");
    reader.close();
    // The log was flushed before the process ended.
    const lines = readFileSync(path.join(instance.dir, "data", "logs", "app", "app.jsonl"), "utf8").split("\n").filter((entry) => entry !== "");
    expect(lines.map((entry) => JSON.parse(entry) as Event).filter((entry) => entry.event === "http.request")).toHaveLength(1);
  });

  it("SIGINT stops the same way", async () => {
    const server = await startBuiltServer();
    server.child.kill("SIGINT");
    const exit = await waitForExit(server.child, server.output, DEADLINE_MS);
    expect(exit.code).toBe(0);
    expect(outputEvent(exit.output, "server.stopping")).toEqual({ event: "server.stopping", signal: "SIGINT" });
    expect(outputEvent(exit.output, "server.stopped")).toEqual({ event: "server.stopped" });
  });
});

describe("D06.3-AC2 a stop that cannot finish", () => {
  it("a request that never finishes: exit 1 at the 15 s deadline, no success, intact database on the next start", async () => {
    const instance = freshTestInstance();
    const server = await startBuiltServer({ installation: instance });
    await openUnfinishedRequest(server);

    const signalled = Date.now();
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, DEADLINE_MS + 10_000);
    const elapsed = Date.now() - signalled;
    expect(exit.code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 500);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 5000);

    const events = eventsOf(exit.output);
    expect(events.find((entry) => entry.event === "server.stop_timeout")).toEqual({ event: "server.stop_timeout", timeoutMs: DEADLINE_MS, step: "http" });
    expect(events.map((entry) => entry.event)).not.toContain("server.stopped");
    expect(events.filter((entry) => entry.event === "shutdown.step").map((entry) => entry["step"])).toEqual(["readiness"]);

    // The kernel released the lease with the process; the database was never closed cleanly.
    const lease = acquireWriterLease(path.join(instance.dir, "control", "maintenance"));
    expect(lease.ok).toBe(true);
    if (lease.ok) lease.lease.release();
    const next = await startBuiltServer({ installation: instance });
    expect(outputEvent(next.output(), "bootstrap.ready")?.["database"]).toEqual({ schemaVersion: 1, created: false });
    expect(outputEvent(next.output(), "bootstrap.ready")?.["maintenance"]).toEqual({ generation: 1, initialized: false });
    next.child.kill("SIGTERM");
    expect((await waitForExit(next.child, next.output, DEADLINE_MS)).code).toBe(0);
    const database = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    expect(database.handle.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(database.handle.pragma("foreign_key_check")).toEqual([]);
    database.close();
  }, 60_000);
});
