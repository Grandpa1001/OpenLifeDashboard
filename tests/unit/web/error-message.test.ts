// D12.1 — what a failure says to the owner: a translation key chosen by a stable code only, and
// where each next step of the server lives in the SPA.
import { NEXT_ACTIONS } from "@openlife/contracts/http/identity";
import { API_ERROR_CODES } from "@openlife/contracts/http/errors";
import { describe, expect, it } from "vitest";
import { describeFailure, type ErrorKey } from "../../../apps/web/src/lib/failures/error-message.js";
import { routeForNextAction } from "../../../apps/web/src/lib/session/route-for-next-action.js";
import enErrors from "../../../apps/web/src/locales/en/errors.json" with { type: "json" };

const api = (code: string, extra: { retryAfterSeconds?: number | null; requestId?: string | null } = {}) =>
  describeFailure({ kind: "api", status: 400, code: code as never, requestId: extra.requestId ?? null, retryAfterSeconds: extra.retryAfterSeconds ?? null });

describe("D12.1 failure texts", () => {
  it("a known code selects its own text and carries the request id for the log", () => {
    expect(api("INVALID_CREDENTIALS", { requestId: "req-7" })).toEqual({ key: "INVALID_CREDENTIALS", requestId: "req-7", lockSeconds: null });
    expect(api("MFA_INVALID_CODE").key).toBe("MFA_INVALID_CODE");
  });

  it("a lock says how many whole minutes to wait, at least one, and exposes the seconds", () => {
    expect(api("AUTH_LOCKED", { retryAfterSeconds: 900 })).toMatchObject({ key: "AUTH_LOCKED", minutes: 15, lockSeconds: 900 });
    expect(api("AUTH_LOCKED", { retryAfterSeconds: 61 })).toMatchObject({ minutes: 2, lockSeconds: 61 });
    expect(api("AUTH_LOCKED", { retryAfterSeconds: 1 })).toMatchObject({ minutes: 1 });
    expect(api("RATE_LIMITED", { retryAfterSeconds: 30 })).toMatchObject({ key: "RATE_LIMITED", minutes: 1 });
    // A lock the server did not time is still a lock: one minute is the safe reading.
    expect(api("AUTH_LOCKED")).toMatchObject({ minutes: 1, lockSeconds: 60 });
  });

  it("a code the client does not have a text for, and a code that only looks like one, is the general text", () => {
    for (const code of ["UNKNOWN", "TEAPOT", "constructor", "__proto__", "toString", ""]) {
      expect(api(code).key).toBe("UNKNOWN");
    }
  });

  it("no connection and an answer off the contract have their own texts", () => {
    expect(describeFailure({ kind: "network" }).key).toBe("NETWORK");
    expect(describeFailure({ kind: "invalid-response", status: 200 }).key).toBe("INVALID_RESPONSE");
  });

  it("every key it can return has a text (plural keys have their forms) in the English file", () => {
    const keys: readonly ErrorKey[] = ["INVALID_CREDENTIALS", "AUTH_LOCKED", "RATE_LIMITED", "MFA_INVALID_CODE", "ENROLLMENT_CHANGED", "AUTH_REQUIRED", "VALIDATION_FAILED", "AUTH_UNAVAILABLE", "ORIGIN_FORBIDDEN", "INTERNAL_ERROR", "NETWORK", "INVALID_RESPONSE", "UNKNOWN"];
    const texts = new Set(Object.keys(enErrors));
    for (const key of keys) {
      expect(texts.has(key) || texts.has(`${key}_one`), key).toBe(true);
    }
  });

  it("every code the API can answer a screen of this version with either has a text or falls to the general one", () => {
    const withoutText = API_ERROR_CODES.filter((code) => api(code).key === "UNKNOWN");
    // These are answers of routes the sign-in screens do not call (setup, the policy's own denials).
    expect(withoutText.sort()).toEqual(["NOT_FOUND", "RECOVERY_ACK_REQUIRED", "MFA_REQUIRED", "SETUP_DATA_ALREADY_CHOSEN", "SETUP_DATA_REQUIRED", "STEP_UP_REQUIRED"].sort());
  });
});

describe("D12.1 routes of the next steps", () => {
  it("every next action of the server has a route, and the sign-in states lead where they belong", () => {
    for (const action of NEXT_ACTIONS) {
      expect(["/login", "/mfa", "/setup", "/main"]).toContain(routeForNextAction(action));
    }
    expect(routeForNextAction("login")).toBe("/login");
    expect(routeForNextAction("mfa_challenge")).toBe("/mfa");
    expect(routeForNextAction("ready")).toBe("/main");
    expect(routeForNextAction("create_owner")).toBe("/setup");
    expect(routeForNextAction("mfa_enrollment")).toBe("/setup");
    expect(routeForNextAction("recovery_ack")).toBe("/setup");
    expect(routeForNextAction("setup_data")).toBe("/setup");
  });
});
