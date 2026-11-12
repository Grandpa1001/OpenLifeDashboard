// D44.5 — the retention of the audit log, on the unit of work of the harness over a real SQLite database
// (Architektura §11.2; DEV §9.41).
// AC1: the entries older than `audit.retentionDays` are removed, those at the limit and newer stay; the oldest
//      go first and a batch is bounded; a batch that removed something records the count and the retention
//      and nothing of the removed entries; a batch that removed nothing writes nothing.
// AC2: the job removes a backlog in bounded batches and gives the event loop back between them, stops at the
//      bound of a run, does nothing during a maintenance operation, never runs twice at once, reads the
//      option at each run, ends when stopped, and logs a failure with its code without throwing; the entry
//      of the retention is in the log of the Security page under its kind.
import { pruneAuditLog } from "../../../packages/core/dist/modules/audit/public.js";
import { AUDIT_KIND_NAMES, auditLogSchema, SECURITY_AUDIT_PATH } from "@openlife/contracts/http/security";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditRetentionJob } from "../../../apps/server/dist/workers/audit-retention.js";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(() => {
  vi.useRealTimers();
  closeHarnesses();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const MARKER = "MARKER-removed-entry-3c9d";

const insert = (h: AppHarness, at: string, action = "registry.created", details = "{}"): void =>
  h.sql(`INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id, ip, user_agent, details) VALUES ('${at}', NULL, '${action}', '${action.split(".")[0]}', 'e', 'r', '203.0.113.9', '${MARKER}', '${details}')`);
const daysAgo = (days: number, extraMs = 0): string => new Date(NOW - days * DAY_MS + extraMs).toISOString();
const count = (h: AppHarness): number => h.rows<{ n: number }>("SELECT count(*) AS n FROM audit_log")[0]?.n ?? 0;
const prunedEntries = (h: AppHarness) => h.rows<{ details: string; entity_id: string; actor: string | null; ip: string | null; user_agent: string | null }>("SELECT details, entity_id, actor, ip, user_agent FROM audit_log WHERE action = 'audit.pruned' ORDER BY id");
const prune = (h: AppHarness, input: { retentionDays?: number; batchRows?: number } = {}) => pruneAuditLog({ unit: h.elsewhere, nowMs: () => NOW }, { retentionDays: input.retentionDays ?? 90, batchRows: input.batchRows ?? 500, operationId: "op-1" });

describe("D44.5-AC1 what is removed and what is recorded", () => {
  it("removes the entries older than the retention and keeps those at the limit and newer", async () => {
    const h = await createAppHarness();
    const before = count(h);
    insert(h, daysAgo(200));
    insert(h, daysAgo(91));
    insert(h, daysAgo(90, -1000));
    insert(h, daysAgo(90));
    insert(h, daysAgo(89));
    insert(h, daysAgo(0));
    const result = prune(h);
    expect(result).toEqual({ ok: true, value: { deleted: 3 } });
    expect(h.rows<{ at: string }>("SELECT at FROM audit_log WHERE request_id = 'r' ORDER BY at").map((row) => row.at)).toEqual([daysAgo(90), daysAgo(89), daysAgo(0)]);
    // The three removed, the owner's own entries of the harness untouched, one entry of the retention added.
    expect(count(h)).toBe(before + 3 + 1);
  });

  it("removes the oldest first and no more than a batch, so a backlog goes in order", async () => {
    const h = await createAppHarness();
    for (const days of [100, 140, 120, 130, 110, 150, 160]) insert(h, daysAgo(days));
    expect(prune(h, { batchRows: 3 })).toEqual({ ok: true, value: { deleted: 3 } });
    expect(h.rows<{ at: string }>("SELECT at FROM audit_log WHERE request_id = 'r' ORDER BY at").map((row) => row.at)).toEqual([daysAgo(130), daysAgo(120), daysAgo(110), daysAgo(100)]);
    expect(prune(h, { batchRows: 3 })).toEqual({ ok: true, value: { deleted: 3 } });
    expect(prune(h, { batchRows: 3 })).toEqual({ ok: true, value: { deleted: 1 } });
    expect(prune(h, { batchRows: 3 })).toEqual({ ok: true, value: { deleted: 0 } });
  });

  it("records the count and the retention of each batch that removed something, and nothing of what it removed", async () => {
    const h = await createAppHarness();
    for (const days of [100, 110]) insert(h, daysAgo(days), "registry.created", '{"displayName":"' + MARKER + '"}');
    expect(prune(h, { batchRows: 5 }).ok).toBe(true);
    const entries = prunedEntries(h);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.details ?? "{}")).toEqual({ deleted: 2, retentionDays: 90 });
    expect(entries[0]).toMatchObject({ entity_id: "audit", actor: null, ip: null, user_agent: null });
    expect(JSON.stringify(h.rows("SELECT * FROM audit_log WHERE action = 'audit.pruned'"))).not.toContain(MARKER);
  });

  it("writes nothing when nothing was removed, so the entry of the retention is not a reason for the next", async () => {
    const h = await createAppHarness();
    insert(h, daysAgo(10));
    const before = count(h);
    expect(prune(h)).toEqual({ ok: true, value: { deleted: 0 } });
    expect(prune(h)).toEqual({ ok: true, value: { deleted: 0 } });
    expect(count(h)).toBe(before);
    // Its own entry is new, so it stays however many times the retention runs.
    insert(h, daysAgo(120));
    prune(h);
    const withOwnEntry = count(h);
    prune(h);
    expect(count(h)).toBe(withOwnEntry);
    expect(prunedEntries(h)).toHaveLength(1);
  });

  it("refuses a retention or a batch that is not a positive integer and removes nothing", async () => {
    const h = await createAppHarness();
    insert(h, daysAgo(500));
    const before = count(h);
    for (const input of [{ retentionDays: 0 }, { retentionDays: -3 }, { retentionDays: 1.5 }, { batchRows: 0 }, { batchRows: 2.5 }]) {
      expect(prune(h, input), JSON.stringify(input)).toEqual({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    expect(count(h)).toBe(before);
  });
});

function jobOf(h: AppHarness, options: { retentionDays?: () => number; maintenanceActive?: () => boolean; unit?: typeof h.elsewhere; batchRows?: number; maxBatchesPerRun?: number } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  let operation = 0;
  const job = createAuditRetentionJob({
    unit: options.unit ?? h.elsewhere,
    nowMs: () => NOW,
    retentionDays: options.retentionDays ?? (() => 90),
    maintenanceActive: options.maintenanceActive ?? (() => false),
    newOperationId: () => `op-${(operation += 1)}`,
    logger: { log: (line) => void lines.push({ ...line }) },
    ...(options.batchRows === undefined ? {} : { batchRows: options.batchRows }),
    ...(options.maxBatchesPerRun === undefined ? {} : { maxBatchesPerRun: options.maxBatchesPerRun }),
  });
  return { job, lines };
}

describe("D44.5-AC2 the job", () => {
  it("removes a backlog in bounded batches and gives the event loop back between them", async () => {
    const h = await createAppHarness();
    for (let n = 0; n < 25; n += 1) insert(h, daysAgo(100 + n));
    const { job } = jobOf(h, { batchRows: 10 });
    let turns = 0;
    const ticker = setInterval(() => void (turns += 1), 0);
    const removed = await job.run();
    clearInterval(ticker);
    expect(removed).toBe(25);
    expect(h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'")).toHaveLength(0);
    // Three batches (10, 10, 5), one entry for each that removed something.
    expect(prunedEntries(h).map((entry) => (JSON.parse(entry.details) as { deleted: number }).deleted)).toEqual([10, 10, 5]);
    expect(turns).toBeGreaterThan(0);
  });

  it("stops at the bound of a run and finishes the backlog at the next one", async () => {
    const h = await createAppHarness();
    for (let n = 0; n < 25; n += 1) insert(h, daysAgo(100 + n));
    const { job } = jobOf(h, { batchRows: 10, maxBatchesPerRun: 2 });
    expect(await job.run()).toBe(20);
    expect(h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'")).toHaveLength(5);
    expect(await job.run()).toBe(5);
  });

  it("does nothing during a maintenance operation and works again after it", async () => {
    const h = await createAppHarness();
    insert(h, daysAgo(100));
    let busy = true;
    const { job } = jobOf(h, { maintenanceActive: () => busy });
    expect(await job.run()).toBe(0);
    expect(h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'")).toHaveLength(1);
    busy = false;
    expect(await job.run()).toBe(1);
  });

  it("never runs twice at once: a run that is going on is the run", async () => {
    const h = await createAppHarness();
    for (let n = 0; n < 12; n += 1) insert(h, daysAgo(100 + n));
    const { job } = jobOf(h, { batchRows: 5 });
    const [first, second] = await Promise.all([job.run(), job.run()]);
    expect([first, second]).toEqual([12, 12]);
    expect(prunedEntries(h)).toHaveLength(3);
  });

  it("reads the retention at each run, so a change of the option applies from the next one", async () => {
    const h = await createAppHarness();
    insert(h, daysAgo(60));
    let days = 90;
    const { job } = jobOf(h, { retentionDays: () => days });
    expect(await job.run()).toBe(0);
    days = 30;
    expect(await job.run()).toBe(1);
  });

  it("ends at the next batch when stopped, and a run after the stop removes nothing more", async () => {
    const h = await createAppHarness();
    for (let n = 0; n < 30; n += 1) insert(h, daysAgo(100 + n));
    const { job } = jobOf(h, { batchRows: 10 });
    const running = job.run();
    await job.stop();
    const removed = await running;
    expect(removed).toBeLessThan(30);
    const left = h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'").length;
    expect(await job.run()).toBe(0);
    expect(h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'")).toHaveLength(left);
  });

  it("logs a failure with its code and does not throw, and carries on with the next run", async () => {
    const h = await createAppHarness();
    insert(h, daysAgo(100));
    let failing = true;
    const unit = {
      run: ((work) => {
        if (failing) throw new Error(`disk is full ${MARKER}`);
        return h.elsewhere.run(work);
      }) as typeof h.elsewhere.run,
      read: h.elsewhere.read.bind(h.elsewhere),
    };
    const { job, lines } = jobOf(h, { unit });
    expect(await job.run()).toBe(0);
    expect(lines).toEqual([expect.objectContaining({ level: "error", event: "audit.retention_failed", code: "AUDIT_RETENTION_FAILED", operationId: "op-1" })]);
    failing = false;
    expect(await job.run()).toBe(1);
  });

  it("runs once soon after the start and then every hour, and the stop ends the schedule", async () => {
    const h = await createAppHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    insert(h, daysAgo(100));
    const { job } = jobOf(h);
    job.start();
    const left = (): number => h.rows("SELECT 1 FROM audit_log WHERE request_id = 'r'").length;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(left()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(left()).toBe(0);
    insert(h, daysAgo(100));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(left()).toBe(0);
    await job.stop();
    insert(h, daysAgo(100));
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(left()).toBe(1);
  });

  it("shows the entry of the retention under the security kind on the Security page, with the right action", async () => {
    const h = await createAppHarness();
    const password = (await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD })).cookie ?? "";
    const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
    const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secretOf(begun.otpauthUri)) }, { cookie: password });
    const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
    const cookie = confirmed.cookie ?? "";
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie });
    await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie });
    insert(h, new Date(Date.now() - 200 * DAY_MS).toISOString());
    const real = pruneAuditLog({ unit: h.elsewhere, nowMs: Date.now }, { retentionDays: 90, batchRows: 500, operationId: "op-real" });
    expect(real).toEqual({ ok: true, value: { deleted: 1 } });
    expect([...AUDIT_KIND_NAMES]).toContain("security");
    const security = auditLogSchema.parse((await h.request("GET", `${SECURITY_AUDIT_PATH}?kind=security`, undefined, { cookie })).json());
    const entry = security.entries.find((candidate) => candidate.action === "audit.pruned");
    expect(entry).toMatchObject({ action: "audit.pruned", kind: "security", requestId: "op-real", ip: null, userAgent: null });
    expect(entry?.details).toEqual({ deleted: 1, retentionDays: 90 });
  });
});
