import { z } from "zod";

/** Public readiness endpoint (Architektura §6.1); deliberately carries no diagnostics. */
export const HEALTH_PATH = "/api/health";

export const healthResponseSchema = z.object({ status: z.enum(["ok", "unavailable"]) }).strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
