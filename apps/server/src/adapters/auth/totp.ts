// TOTP verifier over the library's HOTP (Architektura §9.3, §9.7; D10.1): RFC 6238 with 6
// digits, a 30-second step and a window of one step either side. The algorithm is the library's
// (`createOTP().hotp`, RFC 4226); this module only fixes the parameters, derives the step from an
// injected clock and returns the step that matched, which the replay ledger needs: a library
// `verify` answers yes or no and hides the step. The three candidates are always all compared,
// in constant time.
import { createOTP } from "@better-auth/utils/otp";
import { constantTimeEqual } from "better-auth/crypto";
import { randomBytes } from "node:crypto";

export const TOTP_PARAMETERS = { digits: 6, periodSeconds: 30, windowSteps: 1, secretBytes: 20 } as const;

const CODE = /^\d{6}$/;

export type OtpLibrary = typeof createOTP;

/** The time step of a clock reading. */
export const totpStepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_PARAMETERS.periodSeconds);

export type Totp = Readonly<{
  /** A new secret as base64url of 20 random bytes (160 bits, the RFC 4226 recommendation). */
  generateSecret: () => string;
  /** otpauth:// URI for the authenticator app; shown once, never logged. */
  uri: (secret: string, issuer: string, account: string) => string;
  /** The time step whose code matches, within the window, or null. */
  verify: (secret: string, code: string, nowMs: number) => Promise<number | null>;
}>;

export function createTotp(library: OtpLibrary = createOTP): Totp {
  const otp = (secret: string) => library(Buffer.from(secret, "base64url"), { digits: TOTP_PARAMETERS.digits, period: TOTP_PARAMETERS.periodSeconds });
  return {
    generateSecret: () => randomBytes(TOTP_PARAMETERS.secretBytes).toString("base64url"),
    uri: (secret, issuer, account) => otp(secret).url(issuer, account),
    verify: async (secret, code, nowMs) => {
      const current = totpStepAt(nowMs);
      const generator = otp(secret);
      let matched: number | null = null;
      for (let offset = -TOTP_PARAMETERS.windowSteps; offset <= TOTP_PARAMETERS.windowSteps; offset += 1) {
        const expected = await generator.hotp(current + offset);
        // Every candidate is compared; a malformed code still costs the same.
        if (constantTimeEqual(CODE.test(code) ? code : "x".repeat(TOTP_PARAMETERS.digits), expected) && matched === null) {
          matched = current + offset;
        }
      }
      return matched;
    },
  };
}
