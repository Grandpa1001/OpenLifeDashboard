// D54.3 — the operation `update` of the maintenance gate and the barrier of the writes (Architektura §4.8, §11.2.2; DEV §9.53).
// AC1: from the first phase of the operation every route that can write is refused with MAINTENANCE before any route, sign-in or
//      body is looked at (every method of the inventory but GET, with a session as well as without), nothing of the data
//      changes, a read still answers and says that maintenance is on, and the same routes work again once the operation is
//      closed; an app that finds the operation still active after a restart stays closed instead of opening its writes.
// AC2: a write taken before the operation finishes before the app is quiet, none passes after it, the gate carries the
//      operation with the fence the updater is told, the phases are recorded one by one, a wait that runs out opens the writes
//      again, another operation is not begun over a running one, and a write that fails is no longer counted.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { UPDATE_MAINTENANCE_HEADER } from "../../../apps/server/dist/http/middleware/update-barrier.js";
import { createUpdateOperation } from "../../../apps/server/dist/workers/update-operation.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness } from "../../support/app-harness.ts";
import { ROUTE_INVENTORY } from "../../support/route-inventory.ts";
import { freshTestInstance, outputEvent, runServerEntry, startBuiltServer, waitForExit } from "../../support/server-process.ts";

afterEach(closeHarnesses);

const RELEASE = "1.2.3";
const concrete = (route: string): string => route.replace(/:[A-Za-z]+/g, "x");
const signIn = (h: AppHarness) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD });

/** Every row of every table, hashed: "nothing of the data changed" is a comparison. */
function dataHash(h: AppHarness): string {
  const tables = h.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return createHash("sha256").update(JSON.stringify(tables.map(({ name }) => [name, h.rows(`SELECT * FROM "${name}" ORDER BY rowid`)]))).digest("hex");
}

function updating(h: AppHarness, drainTimeoutMs = 1000) {
  return createUpdateOperation({ gate: h.gate, barrier: h.updateBarrier, nowMs: Date.now, newOperationId: randomUUID, drainTimeoutMs });
}

describe("D54.3-AC1 every route that can write is refused while the update holds the installation", () => {
  const writes = ROUTE_INVENTORY.filter((entry) => entry.method !== "GET");

  it("refuses every method of the inventory but GET with MAINTENANCE, with a session and without, and changes nothing", async () => {
    const h = await createAppHarness();
    const cookie = (await signIn(h)).cookie ?? "";
    expect(cookie).not.toBe("");
    expect(writes.length).toBeGreaterThan(20);
    // Before the operation the same routes are not refused for maintenance: the table is not a table of refusals that anything would give.
    const before = await Promise.all(writes.map((entry) => h.request(entry.method, concrete(entry.path), {}, { cookie })));
    expect(before.some((reply) => reply.status !== 503)).toBe(true);
    for (const reply of before) expect(reply.text).not.toContain("MAINTENANCE");

    const started = await updating(h).quiesce(RELEASE);
    expect(started.ok).toBe(true);
    const hash = dataHash(h);
    for (const entry of writes) {
      for (const withSession of [true, false]) {
        const reply = await h.request(entry.method, concrete(entry.path), {}, withSession ? { cookie } : {});
        expect([reply.status, (reply.json() as { code: string }).code], `${entry.method} ${entry.path}`).toEqual([503, "MAINTENANCE"]);
        expect(reply.headers.get(UPDATE_MAINTENANCE_HEADER), `${entry.method} ${entry.path}`).toBe("update");
      }
    }
    // A body that is not JSON and another origin are refused for the same reason, before anything about them is looked at.
    expect((await h.request("POST", "/api/auth/sign-in/email", "not json", { origin: "http://evil.example" })).status).toBe(503);
    expect(dataHash(h)).toBe(hash);
    expect(h.updateBarrier.inFlight()).toBe(0);
  });

  it("answers a read and the health probe, and says on each that maintenance is on", async () => {
    const h = await createAppHarness();
    const cookie = (await signIn(h)).cookie ?? "";
    await updating(h).quiesce(RELEASE);
    for (const route of ["/api/health", "/api/v1/identity/status"]) {
      const reply = await h.request("GET", route, undefined, { cookie });
      expect(reply.status, route).toBeLessThan(500);
      expect(reply.headers.get(UPDATE_MAINTENANCE_HEADER), route).toBe("update");
    }
    expect((await h.request("GET", "/api/health")).json()).toEqual({ status: "ok" });
  });

  it("works again, with the same routes, once the operation is closed, and no header is left", async () => {
    const h = await createAppHarness();
    const op = updating(h);
    const started = await op.quiesce(RELEASE);
    if (!started.ok) throw new Error("not quiet");
    expect((await signIn(h)).status).toBe(503);
    op.reopen(started.operationId, started.fence);
    const reply = await signIn(h);
    expect(reply.status).toBe(200);
    expect(reply.headers.get(UPDATE_MAINTENANCE_HEADER)).toBeNull();
    expect(h.gate.current()).toMatchObject({ activeOperation: null });
  });

  it("is still refused by an app that starts and finds the operation active, which stays closed", async () => {
    const instance = freshTestInstance();
    const first = await startBuiltServer({ installation: instance });
    first.child.kill("SIGTERM");
    expect((await waitForExit(first.child, first.output, 15_000)).code).toBe(0);
    const stateFile = path.join(instance.dir, "control", "maintenance", "state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { generation: number };
    const operation = { operationId: randomUUID(), reason: "update", phase: "backing_up", startedAt: new Date().toISOString(), targetRelease: RELEASE };
    writeFileSync(stateFile, `${JSON.stringify({ formatVersion: 1, generation: state.generation + 1, activeOperation: operation })}\n`);
    const exit = await runServerEntry(["--port", "0", "--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env });
    expect(exit.code, exit.output).toBe(1);
    expect(exit.output).not.toContain('"server.listening"');
    expect(outputEvent(exit.output, "bootstrap.failed")).toMatchObject({ code: "MAINTENANCE_RECOVERY_REQUIRED", fields: ["activeOperation"] });
    // Nothing was reconciled: the operation is still there for the way that began it.
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({ activeOperation: { operationId: operation.operationId, reason: "update", phase: "backing_up" } });
  });
});

describe("D54.3-AC2 the writes taken before it end before the app is quiet, and none passes after", () => {
  /** A small app with the barrier and a write that waits until the test lets it go, on the gate of a real harness. */
  function slowApp(h: AppHarness) {
    const app = new Hono();
    const events: string[] = [];
    const release: Array<() => void> = [];
    app.use("*", h.updateBarrier.middleware as never);
    app.post("/slow", async (c) => {
      await new Promise<void>((resolve) => release.push(resolve));
      events.push("write finished");
      return c.json({ ok: true });
    });
    app.post("/fails", () => {
      throw new Error("a write that fails");
    });
    app.get("/read", (c) => c.json({ ok: true }));
    return { app, events, release, letGo: () => release.splice(0).forEach((resolve) => resolve()) };
  }

  it("waits for the write in flight, refuses the next one at once, and says quiet only after the first has ended", async () => {
    const h = await createAppHarness();
    const { app, events, letGo } = slowApp(h);
    const inFlight = app.request("/slow", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.updateBarrier.inFlight()).toBe(1);

    const quiet = updating(h).quiesce(RELEASE).then((result) => {
      events.push("quiet");
      return result;
    });
    // The gate holds the operation at once, with the fence the updater is told, while the write is still going.
    expect(h.gate.current()).toMatchObject({ generation: 1, activeOperation: { reason: "update", phase: "quiescing", targetRelease: RELEASE } });
    expect((await app.request("/slow", { method: "POST" })).status).toBe(503);
    expect(events).toEqual([]);

    letGo();
    expect((await inFlight).status).toBe(200);
    const result = await quiet;
    expect(events).toEqual(["write finished", "quiet"]);
    expect(result).toMatchObject({ ok: true, fence: h.gate.current().generation });
    expect(h.updateBarrier.inFlight()).toBe(0);
    // After it none passes, and a read does.
    expect((await app.request("/slow", { method: "POST" })).status).toBe(503);
    expect((await app.request("/read")).status).toBe(200);
    expect(events).toEqual(["write finished", "quiet"]);
  });

  it("is quiet at once when nothing is in flight, and a write that fails is not counted any more", async () => {
    const h = await createAppHarness();
    const { app } = slowApp(h);
    const failed = await app.request("/fails", { method: "POST" });
    expect(failed.status).toBe(500);
    expect(h.updateBarrier.inFlight()).toBe(0);
    expect(await updating(h).quiesce(RELEASE)).toMatchObject({ ok: true });
  });

  it("records the phases one by one, refuses another operation over it, and reopens the writes at its end", async () => {
    const h = await createAppHarness();
    const op = updating(h);
    const started = await op.quiesce(RELEASE);
    if (!started.ok) throw new Error("not quiet");
    expect(await op.quiesce("1.3.0")).toEqual({ ok: false, code: "MAINTENANCE" });
    expect(h.gate.current().generation).toBe(started.fence);
    op.enter("backing_up");
    expect(h.gate.current().activeOperation).toMatchObject({ operationId: started.operationId, phase: "backing_up" });
    op.enter("switching");
    expect(h.gate.current().activeOperation).toMatchObject({ phase: "switching", targetRelease: RELEASE });
    expect(() => op.reopen(started.operationId, started.fence + 1)).toThrow();
    expect(() => op.reopen(randomUUID(), started.fence)).toThrow();
    op.reopen(started.operationId, started.fence);
    expect(h.gate.current().activeOperation).toBeNull();
    expect(() => op.enter("switching")).toThrow();
    // The next operation has a larger fence.
    expect(await op.quiesce(RELEASE)).toMatchObject({ ok: true, fence: started.fence + 1 });
  });

  it("opens the writes again and says so when the writes in flight do not end in time", async () => {
    const h = await createAppHarness();
    const { app, letGo } = slowApp(h);
    const stuck = app.request("/slow", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await updating(h, 30).quiesce(RELEASE)).toEqual({ ok: false, code: "DRAIN_TIMEOUT" });
    expect(h.gate.current().activeOperation).toBeNull();
    letGo();
    await stuck;
    expect((await signIn(h)).status).toBe(200);
  });
});
