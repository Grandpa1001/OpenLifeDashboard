import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo, Socket } from "node:net";
import type { Hono } from "hono";
import type { AppEnv } from "../http/app-env.js";

export type RunningServer = Readonly<{ server: ServerType; address: AddressInfo }>;

/** The open connections of each server, so that the stop can tell the ones that never sent anything. */
const connectionsOf = new WeakMap<ServerType, Set<Socket>>();

export function startServer(app: Hono<AppEnv>, host: string, port: number): Promise<RunningServer> {
  return new Promise((resolveStarted, rejectStarted) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (address) => {
      resolveStarted({ server, address });
    });
    const open = new Set<Socket>();
    connectionsOf.set(server, open);
    server.on("connection", (socket: Socket) => {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
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
 * the next sweep instead of waiting for the keep-alive timeout. A connection from which not one
 * byte was read has no request at all (a browser opens such sockets ahead of need) and is closed
 * too; one that sent even a part of a request is a request in progress.
 */
export function drainServer(server: ServerType): Promise<void> {
  return new Promise((resolveDrained, rejectDrained) => {
    const closeIdle = (): void => {
      if ("closeIdleConnections" in server) {
        server.closeIdleConnections();
      }
      for (const socket of connectionsOf.get(server) ?? []) {
        if (socket.bytesRead === 0 && !socket.destroyed) {
          socket.destroy();
        }
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
