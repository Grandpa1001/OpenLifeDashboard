import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Hono } from "hono";
import type { AppEnv } from "../http/app-env.js";

export type RunningServer = Readonly<{ server: ServerType; address: AddressInfo }>;

export function startServer(app: Hono<AppEnv>, host: string, port: number): Promise<RunningServer> {
  return new Promise((resolveStarted, rejectStarted) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (address) => {
      resolveStarted({ server, address });
    });
    server.once("error", rejectStarted);
  });
}

const IDLE_SWEEP_MS = 50;

/**
 * Stops accepting connections and resolves when every started request has finished. A
 * connection with a request in progress (also one that has not finished sending its headers) is
 * waited for until the shutdown deadline; idle keep-alive connections are closed, and a
 * connection that becomes idle only after this started (its last request finished) is closed at
 * the next sweep instead of waiting for the keep-alive timeout.
 */
export function drainServer(server: ServerType): Promise<void> {
  return new Promise((resolveDrained, rejectDrained) => {
    const closeIdle = (): void => {
      if ("closeIdleConnections" in server) {
        server.closeIdleConnections();
      }
    };
    const sweep = setInterval(closeIdle, IDLE_SWEEP_MS);
    server.close((error) => {
      clearInterval(sweep);
      return error ? rejectDrained(error) : resolveDrained();
    });
    closeIdle();
  });
}
