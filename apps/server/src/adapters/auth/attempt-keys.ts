// Keys of the persistent failure buckets (Architektura §9.8): an HMAC of the normalized e-mail or
// of the client IP, so the database holds neither, a foreign e-mail gets a bucket exactly like
// the owner's, and the table cannot be reversed by guessing addresses without the secret.
import { createHmac } from "node:crypto";

export type AttemptKeys = Readonly<{
  account: (normalizedEmail: string) => string;
  ip: (address: string) => string;
}>;

export function createAttemptKeys(secret: string): AttemptKeys {
  const key = (kind: string, subject: string): string => `password:${kind}:${createHmac("sha256", secret).update(`${kind}\0${subject}`).digest("hex")}`;
  return { account: (email) => key("account", email), ip: (address) => key("ip", address) };
}
