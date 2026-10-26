// The session cookie on the HTTP side (Architektura §9.4, §9.6): its attributes, reading the
// verified token from a request and setting or clearing it on a response. The signing itself is
// the adapter's (adapters/auth/session-cookie.ts); this file only knows Hono.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SessionCookies } from "../adapters/auth/session-cookie.js";
import type { AppEnv } from "./app-env.js";

/** httpOnly, SameSite=Lax, host-only; `Secure` in HTTPS mode. */
const attributes = (secure: boolean) => ({ httpOnly: true, sameSite: "Lax", path: "/", secure }) as const;

/** The token of a request whose cookie carries a valid signature, or null. */
export function readSessionToken(c: Context<AppEnv>, cookies: SessionCookies): Promise<string | null> {
  return cookies.verify(getCookie(c, cookies.name));
}

/** Sets the cookie of a session that has been committed; never call it before the commit. */
export async function setSessionCookie(c: Context<AppEnv>, cookies: SessionCookies, secure: boolean, session: Readonly<{ token: string; expiresAtMs: number }>, nowMs: number): Promise<void> {
  setCookie(c, cookies.name, await cookies.sign(session.token), {
    ...attributes(secure),
    expires: new Date(session.expiresAtMs),
    maxAge: Math.floor((session.expiresAtMs - nowMs) / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, cookies: SessionCookies, secure: boolean): void {
  deleteCookie(c, cookies.name, attributes(secure));
}
