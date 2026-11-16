// The client of the repository of the releases (Architektura §11.1; D53.2): one GET of the list of the releases of
// the repository of the installation, with the ETag of the last answer, and nothing else. The address is built from
// the repository (checked) and the base of the API of the installation (https, or http on the loopback for a mirror or
// a test), never from a request. A redirect is never followed, the answer is read to a bound and within a time, no
// cookie or credential is sent, and what is told to the caller is a kind of failure, a code and the wait the server
// asked for, never the text of the answer.
import http from "node:http";
import https from "node:https";
import { parseReleaseFeed, type FailureKind, type Release } from "@openlife/core/updates";

export const DEFAULT_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type ReleaseCheckCode = "NETWORK_UNAVAILABLE" | "TIMEOUT" | "RATE_LIMITED" | "FORBIDDEN" | "NOT_FOUND" | "SERVER_ERROR" | "REDIRECT_REFUSED" | "RESPONSE_TOO_LARGE" | "RESPONSE_INVALID" | "UNEXPECTED_STATUS";

export type ReleaseCheckResult =
  | Readonly<{ kind: "changed"; releases: readonly Release[]; etag: string | null; ignored: number }>
  | Readonly<{ kind: "not_modified" }>
  | Readonly<{ kind: "failed"; failure: FailureKind; code: ReleaseCheckCode; retryAfterMs: number | null }>;

/** The base of the API an installation may use: HTTPS anywhere, plain HTTP only on the loopback; no credentials, no path, no query. */
export function parseApiBase(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return undefined;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url : undefined;
}

export type ReleaseClientOptions = Readonly<{
  repository: string;
  baseUrl?: string;
  timeoutMs?: number;
  nowMs?: () => number;
}>;

export type ReleaseClient = Readonly<{ check: (etag: string | null) => Promise<ReleaseCheckResult> }>;

const failure = (failureKind: FailureKind, code: ReleaseCheckCode, retryAfterMs: number | null = null): ReleaseCheckResult => ({ kind: "failed", failure: failureKind, code, retryAfterMs });

/** How long the server asked to wait: `Retry-After` in seconds, or the time its limit resets (`x-ratelimit-reset`, seconds since the epoch). */
function waitAskedFor(headers: http.IncomingHttpHeaders, nowMs: number): number | null {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0 && headers["retry-after"] !== undefined) return Math.round(retryAfter * 1000);
  const reset = Number(headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) && headers["x-ratelimit-reset"] !== undefined ? Math.max(0, Math.round(reset * 1000 - nowMs)) : null;
}

export function createReleaseClient(options: ReleaseClientOptions): ReleaseClient {
  const base = parseApiBase(options.baseUrl ?? DEFAULT_API_BASE);
  if (base === undefined) throw new RangeError("the base of the API of the releases is not an HTTPS address");
  // The repository is checked by the parser of the feed; here it only becomes a part of a path, so it is checked the same way once.
  if (!parseReleaseFeed([], options.repository).ok) throw new RangeError("the repository of the releases is not owner/name");
  const target = new URL(`/repos/${options.repository}/releases?per_page=100`, base);
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const transport = target.protocol === "https:" ? https : http;

  return {
    check: (etag) =>
      new Promise<ReleaseCheckResult>((resolve) => {
        let settled = false;
        const finish = (result: ReleaseCheckResult): void => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        const request = transport.request(
          target,
          {
            method: "GET",
            agent: false,
            timeout: timeoutMs,
            headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "openlife-dashboard", ...(etag === null ? {} : { "If-None-Match": etag }) },
          },
          (reply) => {
            const status = reply.statusCode ?? 0;
            const chunks: Buffer[] = [];
            let size = 0;
            reply.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                request.destroy();
                finish(failure("invalid", "RESPONSE_TOO_LARGE"));
              } else {
                chunks.push(chunk);
              }
            });
            reply.on("error", () => finish(failure("network", "NETWORK_UNAVAILABLE")));
            reply.on("end", () => {
              if (status === 304) return finish(etag === null ? failure("invalid", "UNEXPECTED_STATUS") : { kind: "not_modified" });
              if (status >= 300 && status < 400) return finish(failure("invalid", "REDIRECT_REFUSED"));
              if (status === 429 || status === 403) {
                const limited = status === 429 || reply.headers["x-ratelimit-remaining"] === "0" || reply.headers["retry-after"] !== undefined;
                return finish(limited ? failure("rate_limited", "RATE_LIMITED", waitAskedFor(reply.headers, nowMs())) : failure("invalid", "FORBIDDEN"));
              }
              if (status === 404) return finish(failure("invalid", "NOT_FOUND"));
              if (status >= 500) return finish(failure("server", "SERVER_ERROR"));
              if (status !== 200) return finish(failure("invalid", "UNEXPECTED_STATUS"));
              let json: unknown;
              try {
                json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                return finish(failure("invalid", "RESPONSE_INVALID"));
              }
              const feed = parseReleaseFeed(json, options.repository);
              if (!feed.ok) return finish(failure("invalid", "RESPONSE_INVALID"));
              const newTag = reply.headers["etag"];
              finish({ kind: "changed", releases: feed.releases, etag: typeof newTag === "string" && newTag.length > 0 && newTag.length <= 200 ? newTag : null, ignored: feed.ignored });
            });
          },
        );
        request.on("timeout", () => {
          request.destroy();
          finish(failure("network", "TIMEOUT"));
        });
        request.on("error", () => finish(failure("network", "NETWORK_UNAVAILABLE")));
        request.end();
      }),
  };
}
