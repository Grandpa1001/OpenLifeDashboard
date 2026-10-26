// The public readiness endpoint without a schema library (Architektura §6.1), for the SPA,
// which checks it on its start screen: like locales.ts, free of zod so nothing is bundled
// for it. The server's schema in health.ts is built from the same values.

export const HEALTH_PATH = "/api/health";

export const HEALTH_STATUSES = ["ok", "unavailable"] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** True only for the ready answer, {"status":"ok"}; any other body counts as not ready. */
export function isReadyHealthBody(body: unknown): boolean {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && Reflect.get(body, "status") === "ok";
}
