// Readiness check of the second-factor integration (Architektura §9.7, §9.8; D10.1): the server
// is ready only if the pinned libraries behave as the MFA design assumes. A library that lacks
// a step-aware HOTP, answers an RFC 4226 vector differently or a runtime without AES-256-GCM
// blocks the start with AUTH_MFA_INCOMPATIBLE and names the capability, like a schema that does
// not match (AUTH_SCHEMA_INCOMPATIBLE). Nothing is repaired or replaced silently.
import { getCiphers } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import type { OtpLibrary } from "./totp.js";

export type MfaCapabilityCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "AUTH_MFA_INCOMPATIBLE"; fields: readonly string[] }>;

/** RFC 4226 Appendix D: the secret "12345678901234567890" gives these codes for counters 0 and 1. */
const RFC4226_SECRET = Buffer.from("12345678901234567890", "ascii");
const RFC4226_CODES = ["755224", "287082"] as const;

export async function checkMfaIntegration(library: OtpLibrary = createOTP, ciphers: () => readonly string[] = getCiphers): Promise<MfaCapabilityCheck> {
  const problems: string[] = [];
  if (!ciphers().includes("aes-256-gcm")) {
    problems.push("crypto.aes-256-gcm");
  }
  const otp = typeof library === "function" ? library(RFC4226_SECRET, { digits: 6, period: 30 }) : undefined;
  if (typeof otp?.hotp !== "function") {
    problems.push("otp.hotp");
  } else {
    const produced = await Promise.all(RFC4226_CODES.map((_, counter) => otp.hotp(counter)));
    if (produced.some((code, index) => code !== RFC4226_CODES[index])) {
      problems.push("otp.hotp.rfc4226");
    }
  }
  if (typeof otp?.url !== "function") {
    problems.push("otp.url");
  }
  return problems.length === 0 ? { ok: true } : { ok: false, code: "AUTH_MFA_INCOMPATIBLE", fields: problems };
}
