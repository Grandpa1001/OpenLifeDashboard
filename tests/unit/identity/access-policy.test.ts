// D10.2 — the one access policy of core/identity over F09 (Architektura §9.7, §18.7).
// AC1: every one of the 31 policyCases of F09 gives exactly its allow/status/code; required,
//      disabled and reset policy, enrollment, recovery acknowledgment and the data choice decide
//      independently and in the order of the contract.
// AC2: a step-up factor is fresh at 300000 ms and not at 300001 ms or in the future; trusted
//      and recovery open data but never make a fresh TOTP; the policy takes no input from a client.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideAccess,
  nextActionFor,
  STEP_UP_FRESH_MS,
  type AccessDecision,
  type AccessOperation,
  type IdentityAccessSnapshot,
} from "../../../packages/core/src/modules/identity/public.js";
import { repoRoot } from "../../support/server-process.ts";

type Case = Readonly<{
  id: string;
  task: string;
  operation: AccessOperation;
  patch: Partial<IdentityAccessSnapshot>;
  expected: Readonly<{ allow: boolean; httpStatus: number; code?: string }>;
}>;
type Fixture = Readonly<{ nowMs: number; baseline: IdentityAccessSnapshot; policyCases: readonly Case[] }>;

const fixture = JSON.parse(readFileSync(path.join(repoRoot, "tests/fixtures/cases/auth-v1.cases.json"), "utf8")) as Fixture;
const { baseline, nowMs } = fixture;
const withState = (patch: Partial<IdentityAccessSnapshot>): IdentityAccessSnapshot => ({ ...baseline, ...patch });
const denial = (decision: AccessDecision): string => (decision.allow ? "allow" : decision.code);

describe("D10.2-AC1 F09 policy cases", () => {
  it("the fixture has the 31 cases of D10.2 and the baseline is a complete owner session", () => {
    expect(fixture.policyCases).toHaveLength(31);
    expect(new Set(fixture.policyCases.map((item) => item.id)).size).toBe(31);
    expect(fixture.policyCases.every((item) => item.task === "D10.2")).toBe(true);
    expect(decideAccess(baseline, "data", nowMs)).toEqual({ allow: true, httpStatus: 200 });
  });

  it.each(fixture.policyCases.map((item) => [item.id, item] as const))("%s", (_id, item) => {
    const decision = decideAccess(withState(item.patch), item.operation, nowMs);
    expect({ allow: decision.allow, httpStatus: decision.httpStatus, ...(decision.allow ? {} : { code: decision.code }) }).toEqual(item.expected);
  });

  it("an answer is the first failing check in the order identity → acknowledgment → factor → data → freshness", () => {
    const ordered: ReadonlyArray<readonly [string, Partial<IdentityAccessSnapshot>]> = [
      ["AUTH_REQUIRED", { sessionState: "revoked", enrollmentState: "awaiting_recovery_ack", assurance: "password", dataChoice: "unselected", totpVerifiedAtMs: null }],
      ["RECOVERY_ACK_REQUIRED", { enrollmentState: "awaiting_recovery_ack", assurance: "password", dataChoice: "unselected", totpVerifiedAtMs: null }],
      ["MFA_REQUIRED", { assurance: "password", dataChoice: "unselected", totpVerifiedAtMs: null }],
      ["SETUP_DATA_REQUIRED", { assurance: "recovery", dataChoice: "unselected", totpVerifiedAtMs: null }],
      ["STEP_UP_REQUIRED", { assurance: "recovery", totpVerifiedAtMs: null }],
    ];
    for (const [code, patch] of ordered) {
      expect(denial(decideAccess(withState(patch), "step_up", nowMs))).toBe(code);
    }
  });

  it("each identity failure alone gives AUTH_REQUIRED, whatever the factor, acknowledgment or data choice", () => {
    const failures: ReadonlyArray<Partial<IdentityAccessSnapshot>> = [
      { ownerExists: false },
      { ownerMatches: false },
      { epochMatches: false },
      { sessionState: "missing" },
      { sessionState: "expired" },
      { sessionState: "revoked" },
    ];
    for (const failure of failures) {
      for (const operation of ["data", "step_up", "setup_data_choice"] as const) {
        expect(decideAccess(withState({ ...failure, assurance: "password", enrollmentState: "required", dataChoice: "imported" }), operation, nowMs)).toMatchObject({ code: "AUTH_REQUIRED", httpStatus: 401 });
      }
    }
  });

  it("the recovery acknowledgment blocks every factor, every operation and every policy but a missing session", () => {
    for (const assurance of ["password", "totp", "trusted", "recovery"] as const) {
      for (const operation of ["data", "step_up", "setup_data_choice"] as const) {
        expect(denial(decideAccess(withState({ enrollmentState: "awaiting_recovery_ack", assurance, trustedState: "valid" }), operation, nowMs))).toBe("RECOVERY_ACK_REQUIRED");
      }
    }
  });

  it("under a required policy the data open exactly for a TOTP, a recovery code or a valid trust, once enrollment is complete", () => {
    const factors: ReadonlyArray<readonly [Partial<IdentityAccessSnapshot>, boolean]> = [
      [{ assurance: "totp" }, true],
      [{ assurance: "recovery", totpVerifiedAtMs: null }, true],
      [{ assurance: "trusted", trustedState: "valid", totpVerifiedAtMs: null }, true],
      [{ assurance: "trusted", trustedState: "expired", totpVerifiedAtMs: null }, false],
      [{ assurance: "trusted", trustedState: "revoked", totpVerifiedAtMs: null }, false],
      [{ assurance: "trusted", trustedState: "not_used", totpVerifiedAtMs: null }, false],
      [{ assurance: "password", totpVerifiedAtMs: null }, false],
      [{ assurance: "password" }, false],
      [{ assurance: "totp", totpVerifiedAtMs: null }, false],
    ];
    for (const [patch, allowed] of factors) {
      expect(decideAccess(withState(patch), "data", nowMs).allow, JSON.stringify(patch)).toBe(allowed);
    }
    expect(denial(decideAccess(withState({ enrollmentState: "required" }), "data", nowMs))).toBe("MFA_REQUIRED");
  });

  it("with MFA off a password session opens the data, and a reset needs the factor again whatever the session proved", () => {
    expect(decideAccess(withState({ mfaPolicy: "disabled", assurance: "password", totpVerifiedAtMs: null, enrollmentState: "required" }), "data", nowMs).allow).toBe(true);
    for (const assurance of ["password", "totp", "trusted", "recovery"] as const) {
      expect(denial(decideAccess(withState({ mfaPolicy: "reset_required", assurance, trustedState: "valid" }), "data", nowMs))).toBe("MFA_REQUIRED");
    }
  });

  it("the data choice is independent of the factor: unselected, empty and imported change only the data operations", () => {
    expect(denial(decideAccess(withState({ dataChoice: "unselected" }), "data", nowMs))).toBe("SETUP_DATA_REQUIRED");
    expect(decideAccess(withState({ dataChoice: "empty" }), "data", nowMs).allow).toBe(true);
    expect(decideAccess(withState({ dataChoice: "imported" }), "data", nowMs).allow).toBe(true);
    // Choosing empty again is idempotent; imported is never replaced.
    expect(decideAccess(withState({ dataChoice: "empty" }), "setup_data_choice", nowMs).allow).toBe(true);
    expect(denial(decideAccess(withState({ dataChoice: "imported" }), "setup_data_choice", nowMs))).toBe("SETUP_DATA_ALREADY_CHOSEN");
  });
});

describe("D10.2-AC2 freshness and trust", () => {
  const verifiedAt = 1_000_000_000_000;
  const stepUp = (patch: Partial<IdentityAccessSnapshot>, at: number) => denial(decideAccess(withState({ totpVerifiedAtMs: verifiedAt, ...patch }), "step_up", at));

  it("a TOTP is fresh at exactly 300000 ms, not at 300001 ms, and not when it lies in the future", () => {
    expect(STEP_UP_FRESH_MS).toBe(300_000);
    expect(stepUp({}, verifiedAt)).toBe("allow");
    expect(stepUp({}, verifiedAt + 299_999)).toBe("allow");
    expect(stepUp({}, verifiedAt + 300_000)).toBe("allow");
    expect(stepUp({}, verifiedAt + 300_001)).toBe("STEP_UP_REQUIRED");
    expect(stepUp({}, verifiedAt - 1)).toBe("STEP_UP_REQUIRED");
  });

  it("with MFA off the same window applies to the password, and a TOTP time does not replace it", () => {
    const off = { mfaPolicy: "disabled", assurance: "password", totpVerifiedAtMs: null } as const;
    const password = (passwordVerifiedAtMs: number | null, at: number) => denial(decideAccess(withState({ ...off, passwordVerifiedAtMs }), "step_up", at));
    expect(password(verifiedAt, verifiedAt + 300_000)).toBe("allow");
    expect(password(verifiedAt, verifiedAt + 300_001)).toBe("STEP_UP_REQUIRED");
    expect(password(verifiedAt, verifiedAt - 1)).toBe("STEP_UP_REQUIRED");
    expect(password(null, verifiedAt)).toBe("STEP_UP_REQUIRED");
    expect(denial(decideAccess(withState({ ...off, passwordVerifiedAtMs: null, totpVerifiedAtMs: verifiedAt }), "step_up", verifiedAt))).toBe("STEP_UP_REQUIRED");
  });

  it("trusted and recovery sessions open data but never pass a step-up, however recent their other timestamps are", () => {
    for (const patch of [{ assurance: "trusted", trustedState: "valid" }, { assurance: "recovery" }] as const) {
      expect(decideAccess(withState({ ...patch, totpVerifiedAtMs: null }), "data", nowMs).allow).toBe(true);
      expect(denial(decideAccess(withState({ ...patch, totpVerifiedAtMs: null, passwordVerifiedAtMs: nowMs }), "step_up", nowMs))).toBe("STEP_UP_REQUIRED");
    }
  });

  it("a password session does not become a TOTP session by a timestamp", () => {
    expect(denial(decideAccess(withState({ assurance: "password", totpVerifiedAtMs: nowMs }), "step_up", nowMs))).toBe("MFA_REQUIRED");
  });

  it("the policy reads only the snapshot and the injected clock: the same input always gives the same answer", () => {
    const snapshot = withState({});
    const first = decideAccess(snapshot, "step_up", nowMs);
    for (let call = 0; call < 3; call += 1) {
      expect(decideAccess(snapshot, "step_up", nowMs)).toEqual(first);
    }
    // A changed clock alone changes a step-up, and never a plain data decision.
    expect(decideAccess(snapshot, "data", nowMs + 10 * STEP_UP_FRESH_MS).allow).toBe(true);
    expect(decideAccess(snapshot, "step_up", nowMs + 10 * STEP_UP_FRESH_MS).allow).toBe(false);
  });
});

describe("D10.2 nextAction follows the same decision", () => {
  const action = (patch: Partial<IdentityAccessSnapshot>) => nextActionFor(withState(patch), nowMs);

  it("maps each denial to the step that resolves it", () => {
    expect(action({})).toBe("ready");
    expect(action({ sessionState: "revoked" })).toBe("login");
    expect(action({ ownerExists: false, ownerMatches: false })).toBe("create_owner");
    expect(action({ assurance: "password", enrollmentState: "required", totpVerifiedAtMs: null })).toBe("mfa_enrollment");
    expect(action({ mfaPolicy: "reset_required", assurance: "password", totpVerifiedAtMs: null })).toBe("mfa_enrollment");
    expect(action({ assurance: "password", totpVerifiedAtMs: null })).toBe("mfa_challenge");
    expect(action({ enrollmentState: "awaiting_recovery_ack" })).toBe("recovery_ack");
    expect(action({ dataChoice: "unselected" })).toBe("setup_data");
    expect(action({ mfaPolicy: "disabled", assurance: "password", totpVerifiedAtMs: null })).toBe("ready");
  });
});
