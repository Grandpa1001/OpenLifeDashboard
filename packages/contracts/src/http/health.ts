import { z } from "zod";
import { HEALTH_PATH, HEALTH_STATUSES } from "./health-status.js";

/** Public readiness endpoint (Architektura §6.1); deliberately carries no diagnostics. */
export { HEALTH_PATH };

export const healthResponseSchema = z.object({ status: z.enum(HEALTH_STATUSES) }).strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
