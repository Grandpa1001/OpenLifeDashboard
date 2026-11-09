// HTTPS to a proxy in front of the app, with the root certificate of that proxy as the only trust
// (D37.3): plain requests with a body and cookies, and a live stream read as it arrives, with the
// moment each event came. The address is the loopback one the proxy publishes; the name the proxy
// serves (its certificate and Host) is given apart.
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import { decodeLiveEvent, type LiveEvent } from "@openlife/contracts/http/stream";

export type TlsTarget = Readonly<{ address: string; port: number; serverName: string; ca: string }>;

export type TlsReply = Readonly<{ status: number; headers: IncomingHttpHeaders; text: string; setCookies: readonly string[]; cookie: string | null; json: () => unknown }>;

const hostHeader = (target: TlsTarget): string => `${target.serverName}:${target.port}`;

export function tlsSend(target: TlsTarget, method: string, route: string, init: { body?: unknown; cookie?: string | null | undefined; origin?: string; headers?: Record<string, string> } = {}): Promise<TlsReply> {
  return new Promise((resolve, reject) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const headers: Record<string, string> = { Host: hostHeader(target), ...init.headers };
    if (init.origin !== undefined) headers["Origin"] = init.origin;
    if (init.cookie) headers["Cookie"] = init.cookie;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: target.address, port: target.port, servername: target.serverName, ca: target.ca, method, path: route, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const setCookies = response.headers["set-cookie"] ?? [];
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, setCookies, cookie: setCookies[0]?.split(";")[0] ?? null, json: () => JSON.parse(text) as unknown });
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

export type OpenStream = Readonly<{
  status: number;
  headers: IncomingHttpHeaders;
  /** The events read so far, each with the time it arrived (ms since the request was sent). */
  events: readonly Readonly<{ event: LiveEvent; atMs: number }>[];
  /** Resolves with the time the stream ended (ms since the request), whoever ended it. */
  ended: Promise<number>;
  /** Resolves with the first event of the name, or null when the stream ends first or the time runs out. */
  next: (name: LiveEvent["type"], timeoutMs: number) => Promise<Readonly<{ event: LiveEvent; atMs: number }> | null>;
  close: () => void;
}>;

/** Opens the stream and resolves once the answer started (the headers); a refused stream has its status and ends at once. */
export function openTlsStream(target: TlsTarget, route: string, cookie: string, headers: Record<string, string> = {}): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const events: { event: LiveEvent; atMs: number }[] = [];
    const waiters: (() => void)[] = [];
    let endedAt: number | null = null;
    let endResolve: (ms: number) => void = () => undefined;
    const ended = new Promise<number>((done) => (endResolve = done));
    const finish = (): void => {
      if (endedAt !== null) return;
      endedAt = Date.now() - startedAt;
      endResolve(endedAt);
      waiters.splice(0).forEach((wake) => wake());
    };
    const req = request(
      { host: target.address, port: target.port, servername: target.serverName, ca: target.ca, method: "GET", path: route, headers: { Host: hostHeader(target), Cookie: cookie, Accept: "text/event-stream", "Accept-Encoding": "gzip, zstd", ...headers } },
      (response) => {
        let pending = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          pending += chunk;
          for (let at = pending.indexOf("\n\n"); at >= 0; at = pending.indexOf("\n\n")) {
            const block = pending.slice(0, at);
            pending = pending.slice(at + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            const event = name === undefined || data === undefined ? null : decodeLiveEvent(name, data);
            if (event !== null) {
              events.push({ event, atMs: Date.now() - startedAt });
              waiters.splice(0).forEach((wake) => wake());
            }
          }
        });
        response.on("end", finish);
        response.on("close", finish);
        response.on("error", finish);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          events,
          ended,
          next: async (name, timeoutMs) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              const found = events.find((entry) => entry.event.type === name);
              if (found !== undefined) return found;
              if (endedAt !== null || Date.now() >= deadline) return null;
              await new Promise<void>((wake) => {
                const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
                waiters.push(() => {
                  clearTimeout(timer);
                  wake();
                });
              });
            }
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", (error) => (endedAt === null && events.length === 0 ? reject(error) : finish()));
    req.end();
  });
}
