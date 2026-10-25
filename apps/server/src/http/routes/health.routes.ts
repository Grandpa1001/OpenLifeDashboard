import type { HealthResponse } from "@openlife/contracts/http/health";
import type { Handler } from "hono";
import type { Readiness } from "../../bootstrap/readiness.js";
import type { AppEnv } from "../app-env.js";

/**
 * Readiness (Architektura §6.1): 200 while the process serves — HTTP, SPA and an open, migrated
 * database — and 503 once readiness is withdrawn (shutdown, later maintenance). Never carries
 * diagnostics, and never a cached answer.
 */
export function health(readiness: Readiness): Handler<AppEnv> {
  return (c) => {
    const ready = readiness.isReady();
    const body: HealthResponse = { status: ready ? "ok" : "unavailable" };
    c.header("Cache-Control", "no-store");
    return c.json(body, ready ? 200 : 503);
  };
}
