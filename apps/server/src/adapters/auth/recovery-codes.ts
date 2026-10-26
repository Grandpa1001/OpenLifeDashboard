// Recovery codes (Architektura §9.3; D11.1): 10 one-time codes of 10 characters. A code is drawn
// from a 32-character alphabet without look-alikes (Crockford base32: no I, L, O, U), 50 bits
// each, and shown as two groups of five. Only an HMAC-SHA-256 of the normalized code is stored,
// keyed with a key derived from APP_ENCRYPTION_KEY: the codes are random, so a keyed fast hash is
// enough, and a database copy alone cannot be used to test guesses.
import { createHmac, hkdfSync, randomInt } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_PURPOSE = "openlife/recovery-code/v1";

/** Uppercase, without spaces and hyphens, and the look-alikes read as the digits they resemble. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export const isRecoveryCodeShape = (normalized: string): boolean => normalized.length === RECOVERY_CODE_LENGTH && [...normalized].every((char) => ALPHABET.includes(char));

/** The code as shown to the owner: `XXXXX-XXXXX`. */
export const displayRecoveryCode = (normalized: string): string => `${normalized.slice(0, 5)}-${normalized.slice(5)}`;

export type RecoveryCodes = Readonly<{
  /** A new set: the codes to show once, and their hashes in the same order. */
  generate: () => Readonly<{ codes: readonly string[]; hashes: readonly string[] }>;
  /** The stored form of a code the owner typed, in any accepted spelling; null if it cannot be a code. */
  hash: (typed: string) => string | null;
}>;

export function createRecoveryCodes(keyHex: string): RecoveryCodes {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(keyHex, "hex"), Buffer.alloc(0), KEY_PURPOSE, 32));
  const digest = (normalized: string): string => createHmac("sha256", key).update(normalized).digest("hex");
  return {
    generate: () => {
      const normalized = new Set<string>();
      while (normalized.size < RECOVERY_CODE_COUNT) {
        normalized.add(Array.from({ length: RECOVERY_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
      }
      const list = [...normalized];
      return { codes: list.map(displayRecoveryCode), hashes: list.map(digest) };
    },
    hash: (typed) => {
      const normalized = normalizeRecoveryCode(typed);
      return isRecoveryCodeShape(normalized) ? digest(normalized) : null;
    },
  };
}
