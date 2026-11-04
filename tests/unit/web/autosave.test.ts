// D35.1 — the rules of the autosave (Scope §5.4): the growing wait with its jitter, and what a failure
// means for the next try.
import { describe, expect, it } from "vitest";
import { AUTOSAVE_DEBOUNCE_MS, retryDelay, RETRY_STEPS_MS, troubleOf } from "../../../apps/web/src/features/dashboard/lib/autosave.js";

const api = (status: number) => ({ kind: "api" as const, status, code: "UNKNOWN" as const, requestId: null, retryAfterSeconds: null });

describe("D35.1 the autosave", () => {
  it("waits a second after the last change", () => {
    expect(AUTOSAVE_DEBOUNCE_MS).toBe(1000);
  });

  it("waits 1, 2, 4, 8, 16 and then 30 seconds, plus at most a fifth at random", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map((attempt) => retryDelay(attempt, 0))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(retryDelay(0, 0.999)).toBeLessThanOrEqual(1200);
    expect(retryDelay(5, 1)).toBe(36000);
    expect(RETRY_STEPS_MS.at(-1)).toBe(30000);
  });

  it("no network is offline, a server that may answer later is tried again, a refusal is told, a lost session goes to the guard", () => {
    expect(troubleOf({ kind: "network" })).toBe("offline");
    expect(troubleOf({ kind: "invalid-response", status: 502 })).toBe("retrying");
    expect([500, 502, 503, 408, 429].map((status) => troubleOf(api(status)))).toEqual(["retrying", "retrying", "retrying", "retrying", "retrying"]);
    expect([400, 404, 409, 413, 422].map((status) => troubleOf(api(status)))).toEqual(["refused", "refused", "refused", "refused", "refused"]);
    expect([401, 403].map((status) => troubleOf(api(status)))).toEqual(["gate", "gate"]);
  });
});
