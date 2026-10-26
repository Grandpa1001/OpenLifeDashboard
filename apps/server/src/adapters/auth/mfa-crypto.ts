// MfaCrypto of the server (Architektura §9.3, §9.7; D11.1): the secret box, the pinned OTP
// verifier and the recovery codes behind the port core/identity asks for. The manual key is the
// secret as the authenticator app shows it for typing, taken from the library's own URI so that
// the two can never disagree.
import { createHash, randomBytes } from "node:crypto";
import type { MfaCrypto } from "@openlife/core/identity";
import { createRecoveryCodes } from "./recovery-codes.js";
import { createSecretBox } from "./secret-box.js";
import { createTotp } from "./totp.js";

/** The issuer shown in the authenticator app. */
export const TOTP_ISSUER = "OpenLifeDashboard";

export function createMfaCrypto(appEncryptionKeyHex: string): MfaCrypto {
  const box = createSecretBox(appEncryptionKeyHex);
  const totp = createTotp();
  const recovery = createRecoveryCodes(appEncryptionKeyHex);
  return {
    generateSecret: totp.generateSecret,
    describeSecret: (secret, account) => {
      const otpauthUri = totp.uri(secret, TOTP_ISSUER, account);
      const key = new URL(otpauthUri).searchParams.get("secret") ?? "";
      return { otpauthUri, manualKey: key.replace(/(.{4})(?=.)/g, "$1 ") };
    },
    seal: box.seal,
    open: box.open,
    verify: totp.verify,
    newRecoveryCodes: recovery.generate,
    hashRecoveryCode: recovery.hash,
    // 256 random bits: a plain hash is enough to keep the token itself out of the database.
    newTrustedDeviceToken: () => randomBytes(32).toString("base64url"),
    hashTrustedDeviceToken: (token) => createHash("sha256").update(token).digest("hex"),
  };
}
