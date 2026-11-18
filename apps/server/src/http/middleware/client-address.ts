import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * The address of the client (D60.2, Architektura §9.4 and §14.4). The address of the connection is the client, except when the
 * connection comes from the one proxy that the installation trusts (`TRUSTED_PROXY_HOST`, the name of the Caddy service of the
 * Compose network): then the client is the one that proxy wrote in X-Forwarded-For. Caddy overwrites that header with the address
 * it saw (`header_up X-Forwarded-For {remote_host}`), so what a client sent itself never arrives. There is no "trust every peer"
 * and no network range: only the addresses that the name resolves to.
 */

/** How often a name that does not match is resolved again at most. A peer that is not the proxy cannot make the server resolve more often. */
export const PROXY_RESOLVE_INTERVAL_MS = 10_000;

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The form that two spellings of one address share: lower case, and an IPv4 address that arrives as ::ffff:a.b.c.d is a.b.c.d. */
export function normalizeAddress(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  return (mapped?.[1] ?? address).toLowerCase();
}

export type ClientAddressOptions = Readonly<{
  /** The name of the trusted proxy; absent in the local mode, where the address of the connection is the client. */
  proxyHost?: string;
  /** All the addresses of a name (the DNS of the Compose network). */
  lookup: (host: string) => Promise<readonly string[]>;
  nowMs: () => number;
  /** The address of the connection of a request. */
  connectionAddress: (c: Context<AppEnv>) => string | undefined;
  /** Told when a resolution succeeded (with the number of addresses) or failed; the log of the composition root. */
  onResolved?: (outcome: Readonly<{ ok: true; addresses: number } | { ok: false }>) => void;
}>;

export type ClientAddress = Readonly<{
  /** Resolves the name now (at the start); a failure is not fatal, because the proxy may start after the application. */
  warm: () => Promise<void>;
  middleware: MiddlewareHandler<AppEnv>;
}>;

export function createClientAddress(options: ClientAddressOptions): ClientAddress {
  let trusted: ReadonlySet<string> = new Set();
  let lastAttemptMs: number | undefined;
  let inflight: Promise<void> | undefined;

  const resolveNow = (host: string): Promise<void> => {
    inflight ??= (async () => {
      lastAttemptMs = options.nowMs();
      try {
        const addresses = (await options.lookup(host)).map(normalizeAddress);
        trusted = new Set(addresses);
        options.onResolved?.({ ok: true, addresses: trusted.size });
      } catch {
        // The old addresses stay: a name that does not answer for a moment must not turn the proxy into a stranger.
        options.onResolved?.({ ok: false });
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
  const resolveIfDue = async (host: string): Promise<void> => {
    if (inflight !== undefined || lastAttemptMs === undefined || options.nowMs() - lastAttemptMs >= PROXY_RESOLVE_INTERVAL_MS) {
      await resolveNow(host);
    }
  };

  /** The last entry of X-Forwarded-For is the one that the trusted proxy wrote; anything that is not an address is not used. */
  const forwardedClient = (header: string | undefined): string | undefined => {
    const last = header?.split(",").at(-1)?.trim();
    return last !== undefined && isIP(last) !== 0 ? normalizeAddress(last) : undefined;
  };

  return {
    warm: async () => {
      if (options.proxyHost !== undefined) await resolveNow(options.proxyHost);
    },
    middleware: async (c, next) => {
      const connection = normalizeAddress(options.connectionAddress(c) ?? "unknown");
      let client = connection;
      if (options.proxyHost !== undefined) {
        if (!trusted.has(connection)) await resolveIfDue(options.proxyHost);
        if (trusted.has(connection)) client = forwardedClient(c.req.header("X-Forwarded-For")) ?? connection;
      }
      c.set("clientIp", client);
      await next();
    },
  };
}
