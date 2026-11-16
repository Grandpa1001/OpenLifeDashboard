// The barrier of an update (Architektura §4.8, §11.2.2; D54.3). While the maintenance gate holds an operation `update`, no
// request that can write is taken: every method but GET, HEAD and OPTIONS is answered 503 MAINTENANCE before any route, any
// sign-in or any body is looked at, and every answer carries the header that says why. A write that was taken before the
// operation began is counted until it ends, and `drain` waits for those, so what the updater is told ("quiet") is true: the
// writes the app had accepted are finished, and no other one passes. The gate is read at each request and nothing is cached.
import type { MiddlewareHandler } from "hono";
import type { MaintenanceGate } from "../../adapters/filesystem/maintenance-gate.js";
import { apiErrorResponse } from "../api-errors.js";
import type { AppEnv } from "../app-env.js";

/** The header of every answer while an update holds the installation, so a client of a read can tell. */
export const UPDATE_MAINTENANCE_HEADER = "x-openlife-maintenance";
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export type UpdateBarrier = Readonly<{
  middleware: MiddlewareHandler<AppEnv>;
  /** Writes taken and not yet finished. */
  inFlight: () => number;
  /** Resolves true when no write is in flight, false when the time runs out first. New writes are the gate's to refuse, not this wait's. */
  drain: (timeoutMs: number) => Promise<boolean>;
}>;

export function createUpdateBarrier(options: Readonly<{ gate: Pick<MaintenanceGate, "current"> }>): UpdateBarrier {
  let inFlight = 0;
  let waiters: Array<() => void> = [];
  const finished = (): void => {
    inFlight -= 1;
    if (inFlight === 0) {
      const ready = waiters;
      waiters = [];
      for (const wake of ready) wake();
    }
  };
  return {
    inFlight: () => inFlight,
    drain: (timeoutMs) =>
      inFlight === 0
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const wake = (): void => {
              clearTimeout(timer);
              resolve(true);
            };
            const timer = setTimeout(() => {
              waiters = waiters.filter((each) => each !== wake);
              resolve(false);
            }, timeoutMs);
            waiters.push(wake);
          }),
    middleware: async (c, next) => {
      const updating = options.gate.current().activeOperation?.reason === "update";
      if (updating) c.header(UPDATE_MAINTENANCE_HEADER, "update");
      if (SAFE_METHODS.has(c.req.method)) return next();
      if (updating) return apiErrorResponse(c, 503, "MAINTENANCE");
      inFlight += 1;
      try {
        await next();
      } finally {
        finished();
      }
      return undefined;
    },
  };
}
