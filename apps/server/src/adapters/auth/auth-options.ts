// Better Auth options of this installation (Architektura §9.2, §9.6, §9.8): the one place that
// configures the pinned library. Result of the D09.1 PoC with better-auth 1.7.13 on a real
// database file (tests/integration/auth/adapter-poc.test.ts):
// - its API write paths are not used for owner/session/audit writes: sign-in inserts the session
//   in autocommit, and a failing session after-hook leaves that session committed;
// - its getSession is not the authoritative reader: it updates the session on refresh and
//   deletes an expired one, a hidden write also while maintenance holds the database;
// - its scrypt hasher normalizes passwords with NFKC; the shared PasswordHasher replaces it.
// The adapter therefore writes the Better Auth tables in the application's synchronous unit of
// work (D09.2+) and uses the library for the schema of those tables and its crypto primitives.
import type { BetterAuthOptions } from "better-auth";
import { PASSWORD_MAX_CODE_POINTS } from "@openlife/contracts/http/identity";
import type { PasswordHasher } from "./password-hasher.js";

/** The parts that decide the schema: the auth tables must match exactly these options. */
export const AUTH_SCHEMA_OPTIONS = {
  emailAndPassword: {
    enabled: true,
    // No public registration: the owner exists only through the create-owner CLI (§9.2).
    disableSignUp: true,
  },
} as const satisfies BetterAuthOptions;

export type AuthRuntimeInputs = Readonly<{
  hasher: PasswordHasher;
  baseUrl: string;
  secret: string;
  /** instanceId of control/instance.json: the cookie prefix of this installation (§9.6). */
  instanceId: string;
}>;

/** Cookie names of this installation; derived from the stable instanceId, never from the port. */
export function authCookiePrefix(instanceId: string): string {
  return `openlife-${instanceId.replaceAll("-", "").slice(0, 12)}`;
}

export function createAuthOptions(inputs: AuthRuntimeInputs): BetterAuthOptions {
  return {
    ...AUTH_SCHEMA_OPTIONS,
    baseURL: inputs.baseUrl,
    secret: inputs.secret,
    emailAndPassword: {
      ...AUTH_SCHEMA_OPTIONS.emailAndPassword,
      // The length rule is the contract's (code points); the library counts UTF-16 units, so its
      // bounds only must not refuse a valid password: 128 emoji are 256 units.
      minPasswordLength: 1,
      maxPasswordLength: PASSWORD_MAX_CODE_POINTS * 2,
      password: {
        hash: (password) => inputs.hasher.hash(password),
        verify: ({ hash, password }) => inputs.hasher.verify(hash, password),
      },
    },
    session: {
      // Every request reads the server state (§9.6): no cookie cache, no refresh write on read.
      cookieCache: { enabled: false },
      disableSessionRefresh: true,
    },
    advanced: { cookiePrefix: authCookiePrefix(inputs.instanceId) },
    telemetry: { enabled: false },
  };
}
