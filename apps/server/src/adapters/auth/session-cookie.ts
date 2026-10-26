// The session cookie of this installation (Architektura §9.6, §9.8): `<prefix>.session_token`,
// whose value is `<token>.<signature>`; the signature is the library's HMAC of the token with
// BETTER_AUTH_SECRET (D09.1 verified that the library reads the same cookie). The cookie is
// only a pointer: whether a session exists is decided by the database row, so a valid signature
// proves nothing by itself. Attributes are set by the HTTP layer.
import { constantTimeEqual, makeSignature } from "better-auth/crypto";
import { authCookiePrefix } from "./auth-options.js";

export type SignedCookie = Readonly<{
  /** Cookie name of this installation. */
  name: string;
  /** Value to store for a token. */
  sign: (token: string) => Promise<string>;
  /** The token of a cookie value whose signature is valid; null for anything else. */
  verify: (value: string | undefined) => Promise<string | null>;
}>;

/** The signed cookie of a name: a session pointer, or the token of a trusted device (D11.2). */
export function createSignedCookie(name: string, secret: string): SignedCookie {
  return {
    name,
    sign: async (token) => `${token}.${await makeSignature(token, secret)}`,
    verify: async (value) => {
      const separator = value?.lastIndexOf(".") ?? -1;
      if (value === undefined || separator < 1) {
        return null;
      }
      const token = value.slice(0, separator);
      const expected = await makeSignature(token, secret);
      return constantTimeEqual(value.slice(separator + 1), expected) ? token : null;
    },
  };
}

export type SessionCookies = SignedCookie;

export function createSessionCookies(inputs: Readonly<{ instanceId: string; secret: string }>): SessionCookies {
  return createSignedCookie(`${authCookiePrefix(inputs.instanceId)}.session_token`, inputs.secret);
}

/** The cookie of this installation's trusted device, prefixed like the session cookie (Architektura §9.6). */
export function createTrustedDeviceCookies(inputs: Readonly<{ instanceId: string; secret: string }>): SignedCookie {
  return createSignedCookie(`${authCookiePrefix(inputs.instanceId)}.trusted_device`, inputs.secret);
}
