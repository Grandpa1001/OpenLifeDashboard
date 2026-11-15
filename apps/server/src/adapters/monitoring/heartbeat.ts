// The heartbeat of the nightly copy (Architektura §11.3.2; D49.4): one HTTPS request to the address the
// administrator put in the environment, after a verified copy, and nothing else. The request carries no body,
// no cookie and no data of the installation. The address is a secret (it holds the token of the monitor): it
// is never logged, never returned and never part of a result; a result names only a stable code.
//
// The request goes to the address the name resolved to, after every resolved address was checked against the
// internal ranges, with the name kept for the certificate and the Host header, so a name that changes its
// answer between the check and the connection cannot reach an internal address. Redirects are never followed
// (an answer 3xx is a failure), and the whole signal is bounded by one timeout.
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { Secret } from "../../bootstrap/secret.js";
import { HEARTBEAT_TIMEOUT_MS, HEARTBEAT_URL_MAX_LENGTH } from "./heartbeat-limits.js";

export type HeartbeatErrorCode = "HEARTBEAT_ADDRESS_FORBIDDEN" | "HEARTBEAT_UNREACHABLE" | "HEARTBEAT_TIMEOUT" | "HEARTBEAT_REDIRECT" | "HEARTBEAT_BAD_STATUS" | "HEARTBEAT_FAILED";
export type HeartbeatResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: HeartbeatErrorCode }>;
export type HeartbeatSender = () => Promise<HeartbeatResult>;

/** What the transport is asked to do: one GET to an address already checked. */
export type HeartbeatRequest = Readonly<{ address: string; hostname: string; port: number; host: string; path: string; signal: AbortSignal }>;
/** Sends it and answers the status code of the reply; the body is not read. */
export type HeartbeatTransport = (request: HeartbeatRequest) => Promise<number>;

const INTERNAL = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  INTERNAL.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  INTERNAL.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 inside an address written as IPv4 mapped into IPv6 (`::ffff:a.b.c.d`), or null. */
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (match?.[1] !== undefined) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] === undefined || hex[2] === undefined) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** True for an address the heartbeat must never reach: loopback, private, link local, reserved, multicast. */
export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const mapped = family === 6 ? mappedIpv4(address) : null;
  if (mapped !== null) return INTERNAL.check(mapped, "ipv4");
  return INTERNAL.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The hostname of a URL without the brackets of an IPv6 literal. */
const hostnameOf = (url: URL): string => (url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname);

/** The address from the environment as a URL, or undefined when it is not an HTTPS address without credentials and not an internal literal. */
export function parseHeartbeatUrl(raw: string): URL | undefined {
  if (raw.length > HEARTBEAT_URL_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || url.hostname === "") return undefined;
  const host = hostnameOf(url);
  if (isIP(host) !== 0 && isInternalAddress(host)) return undefined;
  return url;
}

/** The transport of the product; `ca` is for a test that serves its own certificate, the product passes none. */
export const createHttpsTransport = (trust: Readonly<{ ca?: string }> = {}): HeartbeatTransport => (request) =>
  new Promise<number>((resolve, reject) => {
    const outgoing = https.request(
      {
        host: request.address,
        port: request.port,
        path: request.path,
        method: "GET",
        // The certificate is checked against the name, not against the address the connection goes to.
        ...(isIP(request.hostname) === 0 ? { servername: request.hostname } : {}),
        headers: { Host: request.host, "User-Agent": "openlife-dashboard", Accept: "*/*" },
        agent: false,
        signal: request.signal,
        ...(trust.ca === undefined ? {} : { ca: trust.ca }),
      },
      (reply) => {
        reply.resume();
        resolve(reply.statusCode ?? 0);
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

export type HeartbeatSenderOptions = Readonly<{
  url: Secret;
  timeoutMs?: number;
  /** Tests give their own; the product asks the resolver of the system. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  transport?: HeartbeatTransport;
}>;

const systemResolve = async (hostname: string): Promise<readonly string[]> => (await lookup(hostname, { all: true })).map((entry) => entry.address);

export function createHeartbeatSender(options: HeartbeatSenderOptions): HeartbeatSender {
  const resolve = options.resolve ?? systemResolve;
  const transport = options.transport ?? createHttpsTransport();
  return async () => {
    const url = parseHeartbeatUrl(options.url.reveal());
    if (url === undefined) return { ok: false, code: "HEARTBEAT_ADDRESS_FORBIDDEN" };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    aborted.catch(() => undefined);
    try {
      const hostname = hostnameOf(url);
      const addresses = isIP(hostname) !== 0 ? [hostname] : await Promise.race([resolve(hostname), aborted]);
      const first = addresses[0];
      if (first === undefined) return { ok: false, code: "HEARTBEAT_UNREACHABLE" };
      if (addresses.some(isInternalAddress)) return { ok: false, code: "HEARTBEAT_ADDRESS_FORBIDDEN" };
      const status = await Promise.race([transport({ address: first, hostname, port: url.port === "" ? 443 : Number(url.port), host: url.host, path: `${url.pathname}${url.search}`, signal: controller.signal }), aborted]);
      if (status >= 200 && status < 300) return { ok: true };
      if (status >= 300 && status < 400) return { ok: false, code: "HEARTBEAT_REDIRECT" };
      return { ok: false, code: "HEARTBEAT_BAD_STATUS" };
    } catch {
      return { ok: false, code: timedOut ? "HEARTBEAT_TIMEOUT" : "HEARTBEAT_FAILED" };
    } finally {
      clearTimeout(timer);
    }
  };
}
