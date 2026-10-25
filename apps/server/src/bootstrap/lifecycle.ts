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

/**
 * SIGTERM/SIGINT stop accepting connections and let started requests finish; `afterClose` then
 * releases what must outlive HTTP, ending with the writer lease. Exceeding the deadline ends the
 * process with an error instead of a success message, and the exit releases the lease
 * (Architektura §15.2). Readiness and the database join this sequence in D04.2/D06.
 */
export function stopOnSignals(server: ServerType, timeoutMs: number, afterClose: () => void): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(JSON.stringify({ event: "server.stopping", signal }));
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ event: "server.stop_timeout", timeoutMs }));
      process.exit(1);
    }, timeoutMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      afterClose();
      if (error) {
        console.error(JSON.stringify({ event: "server.stop_failed", error: error.name }));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ event: "server.stopped" }));
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
