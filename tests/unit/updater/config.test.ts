// D56.2 — the option of the installation that sets the time the new app has to start (Architektura §11.2.2, §14): unset is the constant of the
// protocol, a whole number of seconds from 60 to 900 is taken, and anything else is refused (the updater then does not start).
import { describe, expect, it } from "vitest";
import { START_TIMEOUT_ENV, startTimeoutOf } from "../../../apps/updater/src/config.js";
import { START_TIMEOUT_MS } from "../../../apps/updater/src/install/update-limits.js";

describe("D56.2-AC1 the time to start is unset, a whole number of seconds in the range, or refused", () => {
  it("takes the constant of the protocol when unset or empty", () => {
    expect(startTimeoutOf({})).toEqual({ ok: true, ms: START_TIMEOUT_MS });
    expect(startTimeoutOf({ [START_TIMEOUT_ENV]: "" })).toEqual({ ok: true, ms: START_TIMEOUT_MS });
    expect(START_TIMEOUT_MS).toBe(180_000);
  });

  it("takes the edges of the range and the values between", () => {
    for (const [value, ms] of [["60", 60_000], ["180", 180_000], ["900", 900_000], ["301", 301_000]] as const) expect(startTimeoutOf({ [START_TIMEOUT_ENV]: value }), value).toEqual({ ok: true, ms });
  });

  it("refuses what is outside the range or is not a whole number of seconds", () => {
    for (const value of ["59", "901", "0", "-60", "1e3", "180.5", " 180", "180 ", "abc", "999999", "０１８０"]) expect(startTimeoutOf({ [START_TIMEOUT_ENV]: value }), value).toEqual({ ok: false });
  });
});
