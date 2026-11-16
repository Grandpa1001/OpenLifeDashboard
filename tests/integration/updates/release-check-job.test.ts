// D53.3 — the job that checks the releases in the process, on a fake clock and a fake checker (Architektura §11.1).
// AC1: a look makes a request only when the option is on and the policy says one is due (never done, or a day after the
//      last success, and not during a backoff); one request at a time whoever asks; a newer release is told to the
//      streams once, not at every check; "Check now" works whatever the option says, is refused for the cooldown and
//      while the source asked to wait, and an ordinary backoff does not stop it.
// AC2: a failure is a code in the log and in the state, never a throw; the state is in the shape of the contract with the
//      next check, the retry time and the last failure; stopping waits for the request that is going on; an
//      installation with no source says so and does nothing.
import { afterEach, describe, expect, it } from "vitest";
import { updatesStatusSchema } from "@openlife/contracts/http/updates";
import { afterFailure, afterSuccess, availability, CHECK_INTERVAL_MS, INITIAL_CHECK_STATE, MANUAL_COOLDOWN_MS, type CheckState, type Release } from "../../../packages/core/src/modules/updates/public.js";
import { createReleaseCheckJob, createUnconfiguredUpdates, type ReleaseCheckJob } from "../../../apps/server/dist/workers/release-check.js";
import type { CheckOutcome, ReleaseChecker } from "../../../apps/server/dist/adapters/updates/release-checker.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const release = (version: string): Release => ({ version, tag: `v${version}`, publishedAt: "2026-11-10T12:00:00.000Z", notes: `notes ${version}`, url: `https://github.com/owner/name/releases/tag/v${version}` });

/** A checker whose answers the test scripts; it applies the policy of the core to its state as the real one does. */
function fakeChecker(clock: { now: number }, current = "1.0.0") {
  const state = { value: INITIAL_CHECK_STATE as CheckState, releases: [] as Release[], error: null as string | null, calls: 0, next: { kind: "updated", releases: [release("1.2.0")] } as { kind: "updated"; releases: Release[] } | { kind: "unchanged" } | { kind: "failed"; code: string; failure: "network" | "rate_limited" | "server" | "invalid"; retryAfterMs?: number }, gate: null as Promise<void> | null };
  const checker: ReleaseChecker = {
    snapshot: () => ({ releases: state.releases, availability: availability(current, state.releases), state: state.value, lastErrorCode: state.error }),
    run: async (): Promise<CheckOutcome> => {
      state.calls += 1;
      await state.gate;
      const answer = state.next;
      let status: CheckOutcome["status"];
      if (answer.kind === "updated") {
        state.releases = answer.releases;
        state.value = afterSuccess(state.value, clock.now);
        state.error = null;
        status = "updated";
      } else if (answer.kind === "unchanged") {
        state.value = afterSuccess(state.value, clock.now);
        state.error = null;
        status = "unchanged";
      } else {
        state.value = afterFailure(state.value, clock.now, answer.failure, answer.retryAfterMs ?? null);
        state.error = answer.code;
        status = "failed";
      }
      return { status, code: status === "failed" ? ((state.error ?? "CHECK_FAILED") as never) : null, releases: state.releases, availability: availability(current, state.releases), state: state.value, cacheWriteFailed: false };
    },
  };
  return { checker, state };
}

const started: ReleaseCheckJob[] = [];
afterEach(async () => {
  for (const job of started.splice(0)) await job.stop();
});
function jobOf(over: { enabled?: () => boolean; clock?: { now: number }; announce?: (version: string) => void; tickMs?: number; firstDelayMs?: number } = {}) {
  const clock = over.clock ?? { now: NOW };
  const fake = fakeChecker(clock);
  const logs: Array<{ level: string; event: string; code?: string }> = [];
  const announced: string[] = [];
  const job = createReleaseCheckJob({
    checker: fake.checker,
    currentVersion: "1.0.0",
    enabled: over.enabled ?? (() => true),
    nowMs: () => clock.now,
    announce: over.announce ?? ((version) => void announced.push(version)),
    logger: { log: (event) => void logs.push(event) },
    tickMs: over.tickMs ?? 20,
    firstDelayMs: over.firstDelayMs ?? 5,
  });
  started.push(job);
  return { job, fake, clock, logs, announced };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("D53.3-AC1 when the job asks, what it tells and what Check now may do", () => {
  it("asks soon after the start when the option is on, once a day after, and tells the streams of the newer release once", async () => {
    const { job, fake, clock, announced } = jobOf();
    job.start();
    await wait(80);
    expect(fake.state.calls).toBe(1);
    expect(announced).toEqual(["1.2.0"]);
    // Nothing more within the day, though the clock is looked at every tick.
    expect(fake.state.calls).toBe(1);
    clock.now += CHECK_INTERVAL_MS;
    await wait(80);
    expect(fake.state.calls).toBe(2);
    // The same release found again is not told again.
    expect(announced).toEqual(["1.2.0"]);
    fake.state.next = { kind: "updated", releases: [release("1.3.0"), release("1.2.0")] };
    clock.now += CHECK_INTERVAL_MS;
    await wait(80);
    expect(announced).toEqual(["1.2.0", "1.3.0"]);
  });

  it("does not ask while the option is off or a backoff holds the check, and asks when the option is turned on", async () => {
    let on = false;
    const { job, fake, clock } = jobOf({ enabled: () => on });
    job.start();
    await wait(80);
    expect(fake.state.calls).toBe(0);
    on = true;
    await wait(80);
    expect(fake.state.calls).toBe(1);
    fake.state.next = { kind: "failed", code: "SERVER_ERROR", failure: "server" };
    clock.now += CHECK_INTERVAL_MS;
    await wait(80);
    const callsAfterFailure = fake.state.calls;
    expect(callsAfterFailure).toBe(2);
    // The backoff holds it: the day has passed but the five minutes have not.
    await wait(100);
    expect(fake.state.calls).toBe(callsAfterFailure);
  });

  it("makes one request for any number of askers at once", async () => {
    const { job, fake } = jobOf();
    let release_: () => void = () => undefined;
    fake.state.gate = new Promise<void>((resolve) => void (release_ = resolve));
    const first = job.service.checkNow();
    const second = job.service.checkNow();
    await wait(20);
    expect(fake.state.calls).toBe(1);
    release_();
    expect(await first).toMatchObject({ ok: true, outcome: "updated" });
    expect(await second).toMatchObject({ ok: true });
    expect(fake.state.calls).toBe(1);
  });

  it("lets Check now ask with the option off, refuses it for the cooldown and while the source asked to wait, and not for an ordinary backoff", async () => {
    const { job, fake, clock } = jobOf({ enabled: () => false });
    const first = await job.service.checkNow();
    expect(first).toMatchObject({ ok: true, outcome: "updated", status: { enabled: false, available: true, latest: { version: "1.2.0" } } });
    expect(await job.service.checkNow()).toEqual({ ok: false, reason: "COOLDOWN", retryAfterSeconds: MANUAL_COOLDOWN_MS / 1000 });
    clock.now += MANUAL_COOLDOWN_MS;
    fake.state.next = { kind: "failed", code: "NETWORK_UNAVAILABLE", failure: "network" };
    expect(await job.service.checkNow()).toMatchObject({ ok: true, outcome: "failed", status: { error: { code: "NETWORK_UNAVAILABLE" } } });
    // An ordinary backoff is on now, and a person who asks is still answered.
    clock.now += MANUAL_COOLDOWN_MS;
    fake.state.next = { kind: "failed", code: "RATE_LIMITED", failure: "rate_limited", retryAfterMs: 40 * 60 * 1000 };
    expect(await job.service.checkNow()).toMatchObject({ ok: true, outcome: "failed" });
    clock.now += MANUAL_COOLDOWN_MS;
    expect(await job.service.checkNow()).toEqual({ ok: false, reason: "RATE_LIMITED", retryAfterSeconds: 40 * 60 - MANUAL_COOLDOWN_MS / 1000 });
    clock.now += 40 * 60 * 1000;
    fake.state.next = { kind: "unchanged" };
    expect(await job.service.checkNow()).toMatchObject({ ok: true, outcome: "unchanged" });
  });
});

describe("D53.3-AC2 a failure stays inside, the state is the contract's, stopping waits, no source is told", () => {
  it("logs a failure with its code and does not throw, and keeps the release it knew in the state", async () => {
    const { job, fake, logs } = jobOf();
    await job.service.checkNow();
    fake.state.next = { kind: "failed", code: "SERVER_ERROR", failure: "server" };
    fake.state.value = { ...fake.state.value, lastAttemptAtMs: null };
    const failed = await job.service.checkNow();
    expect(failed).toMatchObject({ ok: true, outcome: "failed", status: { available: true, latest: { version: "1.2.0" }, error: { code: "SERVER_ERROR" } } });
    expect(logs.filter((entry) => entry.event === "updates.check_failed")).toEqual([{ level: "warn", event: "updates.check_failed", code: "SERVER_ERROR" }]);
    expect(logs.some((entry) => entry.event === "updates.check_done")).toBe(true);
  });

  it("gives the state in the shape of the contract with the next check, the time of the retry and the last failure", async () => {
    const { job, fake, clock } = jobOf();
    expect(updatesStatusSchema.parse(job.service.status())).toMatchObject({ configured: true, enabled: true, current: "1.0.0", available: false, latest: null, checkedAt: null, nextCheckAt: new Date(NOW).toISOString(), error: null, retryAt: null });
    await job.service.checkNow();
    expect(updatesStatusSchema.parse(job.service.status())).toMatchObject({ available: true, checkedAt: new Date(NOW).toISOString(), nextCheckAt: new Date(NOW + CHECK_INTERVAL_MS).toISOString(), retryAt: null, error: null });
    clock.now += MANUAL_COOLDOWN_MS;
    fake.state.next = { kind: "failed", code: "RATE_LIMITED", failure: "rate_limited", retryAfterMs: 30 * 60 * 1000 };
    await job.service.checkNow();
    const limited = updatesStatusSchema.parse(job.service.status());
    expect(limited.retryAt).toBe(new Date(clock.now + 30 * 60 * 1000).toISOString());
    expect(limited.error).toEqual({ code: "RATE_LIMITED" });
    expect(Date.parse(limited.nextCheckAt!)).toBeGreaterThanOrEqual(Date.parse(limited.retryAt!));
  });

  it("shows no next check when the option is off", () => {
    const { job } = jobOf({ enabled: () => false });
    expect(job.service.status()).toMatchObject({ enabled: false, nextCheckAt: null });
  });

  it("waits for the request that is going on when it is stopped, and does not look again", async () => {
    const { job, fake } = jobOf({ firstDelayMs: 1 });
    let release_: () => void = () => undefined;
    fake.state.gate = new Promise<void>((resolve) => void (release_ = resolve));
    job.start();
    await wait(40);
    let stopped = false;
    const stopping = job.stop().then(() => void (stopped = true));
    await wait(30);
    expect(stopped).toBe(false);
    release_();
    await stopping;
    expect(stopped).toBe(true);
    const calls = fake.state.calls;
    await wait(80);
    expect(fake.state.calls).toBe(calls);
  });

  it("answers an installation with no source of releases with its version and no check, and refuses Check now", async () => {
    const none = createUnconfiguredUpdates("1.0.0");
    expect(updatesStatusSchema.parse(none.status())).toEqual({ configured: false, enabled: false, current: "1.0.0", available: false, latest: null, checkedAt: null, nextCheckAt: null, error: null, retryAt: null });
    expect(await none.checkNow()).toEqual({ ok: false, reason: "NOT_CONFIGURED", retryAfterSeconds: null });
  });

  it("does not let a failing announcement fail the check", async () => {
    const { job } = jobOf({ announce: () => { throw new Error("streams gone"); } });
    expect(await job.service.checkNow()).toMatchObject({ ok: true, outcome: "updated" });
  });
});
