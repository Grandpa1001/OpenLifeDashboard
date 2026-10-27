// Keys of the persistent failure buckets (Architektura §9.8): an HMAC of the normalized e-mail, of
// the owner's id or of the client IP, so the database holds none of them, a foreign e-mail gets a
// bucket exactly like the owner's, and the table cannot be reversed by guessing addresses without
// the secret. The password and the second factor count in separate buckets.
import { createHmac } from "node:crypto";

export type AttemptKeys = Readonly<{
  /** Password: the bucket of an account by its normalized e-mail, and of a client address. */
  account: (normalizedEmail: string) => string;
  ip: (address: string) => string;
  /** Second factor: the bucket of the owner's account and of a client address. */
  mfaAccount: (ownerId: string) => string;
  mfaIp: (address: string) => string;
}>;

export function createAttemptKeys(secret: string): AttemptKeys {
  const key = (factor: string, kind: string, subject: string): string =>
    `${factor}:${kind}:${createHmac("sha256", secret).update(`${factor}\0${kind}\0${subject}`).digest("hex")}`;
  return {
    account: (email) => key("password", "account", email),
    ip: (address) => key("password", "ip", address),
    mfaAccount: (ownerId) => key("mfa", "account", ownerId),
    mfaIp: (address) => key("mfa", "ip", address),
  };
}
