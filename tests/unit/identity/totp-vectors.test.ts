// D10.3-AC1 — the TOTP verifier against the published vectors of RFC 4226 (Appendix D) and RFC
// 6238 (Appendix B, SHA-1, secret "12345678901234567890"). The library computes the codes; the
// product's verifier fixes 6 digits, 30 s and the window, and returns the matching step.
import { createOTP } from "@better-auth/utils/otp";
import { describe, expect, it } from "vitest";
import { createTotp, TOTP_PARAMETERS, totpStepAt } from "../../../apps/server/src/adapters/auth/totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");
const SECRET = RFC_SECRET.toString("base64url");
const totp = createTotp();

/** RFC 4226 Appendix D: HOTP values for counters 0…9 (6 digits). */
const RFC4226 = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
/** RFC 6238 Appendix B, SHA-1 column: time in seconds → 8-digit code. */
const RFC6238: ReadonlyArray<readonly [number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("D10.3-AC1 RFC vectors", () => {
  it.each(RFC4226.map((code, counter) => [counter, code] as const))("RFC 4226 counter %i gives %s", async (counter, code) => {
    expect(await createOTP(RFC_SECRET, { digits: 6, period: 30 }).hotp(counter)).toBe(code);
  });

  it.each(RFC6238)("RFC 6238 at %i s gives %s with 8 digits (the library)", async (seconds, code) => {
    expect(await createOTP(RFC_SECRET, { digits: 8, period: 30 }).hotp(Math.floor(seconds / 30))).toBe(code);
  });

  it.each(RFC6238)("at %i s the product's 6-digit code is the last six digits of %s, and the verifier returns that time step", async (seconds, code) => {
    expect(TOTP_PARAMETERS).toMatchObject({ digits: 6, periodSeconds: 30, windowSteps: 1 });
    expect(await totp.verify(SECRET, code.slice(-6), seconds * 1000)).toBe(Math.floor(seconds / 30));
  });

  it("the window is one step either side of each vector and no more", async () => {
    for (const [seconds, code] of RFC6238) {
      const six = code.slice(-6);
      // The clock one step later or earlier still accepts the vector's code, two steps away does not.
      expect(await totp.verify(SECRET, six, (seconds + 30) * 1000)).toBe(Math.floor(seconds / 30));
      expect(await totp.verify(SECRET, six, (seconds - 30) * 1000)).toBe(Math.floor(seconds / 30));
      expect(await totp.verify(SECRET, six, (seconds + 60) * 1000)).toBeNull();
      expect(await totp.verify(SECRET, six, (seconds - 60) * 1000)).toBeNull();
    }
  });

  it("the step changes exactly at the 30-second boundary of the injected clock", () => {
    expect(totpStepAt(0)).toBe(0);
    expect(totpStepAt(29_999)).toBe(0);
    expect(totpStepAt(30_000)).toBe(1);
    expect(totpStepAt(59_000)).toBe(1);
  });

  it("a code of another secret, a code with a letter and a code of the wrong length are not accepted", async () => {
    const other = Buffer.from("another-secret-of-20", "ascii").toString("base64url");
    const now = 1111111111 * 1000;
    const foreign = await createOTP(Buffer.from(other, "base64url"), { digits: 6, period: 30 }).hotp(Math.floor(1111111111 / 30));
    expect(foreign).not.toBe("050471");
    expect(await totp.verify(SECRET, foreign, now)).toBeNull();
    for (const bad of ["05047a", "50471", "0504711", "", "      "]) {
      expect(await totp.verify(SECRET, bad, now)).toBeNull();
    }
  });
});
