import type { HealthResponse } from "@openlife/contracts/http/health";
import type { Handler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * Readiness for the scope deployed so far: in D02 the process serves HTTP and the SPA.
 * From D04 readiness also requires an open, migrated database (Architektura §6.1).
 */
export const health: Handler<AppEnv> = (c) => {
  const body: HealthResponse = { status: "ok" };
  c.header("Cache-Control", "no-store");
  return c.json(body, 200);
};
