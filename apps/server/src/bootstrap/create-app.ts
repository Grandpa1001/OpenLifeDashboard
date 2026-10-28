import { PUBLIC_BOOTSTRAP_PATH } from "@openlife/contracts/http/bootstrap";
import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { Hono } from "hono";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { apiNotFound } from "../http/api-errors.js";
import type { AppEnv } from "../http/app-env.js";
import { installHttpFoundation } from "../http/foundation.js";
import { publicBootstrap } from "../http/routes/bootstrap.routes.js";
import { health } from "../http/routes/health.routes.js";
import { registerIdentityRoutes, type IdentityRouteDependencies } from "../http/routes/identity.routes.js";
import { registerMfaEnrollmentRoutes, type MfaEnrollmentRouteDependencies } from "../http/routes/mfa-enrollment.routes.js";
import { registerRecordRoutes, type RecordRouteDependencies } from "../http/routes/records.routes.js";
import { registerScreenRoutes, type ScreenRouteDependencies } from "../http/routes/screens.routes.js";
import { registerRegistryRoutes, type RegistryRouteDependencies } from "../http/routes/registries.routes.js";
import { registerSetupRoutes, type SetupRouteDependencies } from "../http/routes/setup.routes.js";
import { registerMfaVerificationRoutes, type MfaVerificationRouteDependencies } from "../http/routes/mfa-verification.routes.js";
import type { Readiness } from "./readiness.js";
import { spaFallback, webAssets } from "../http/spa.js";

export type AppDependencies = Readonly<{
  /** Absolute directory of the built web app (apps/web/dist). */
  webRoot: string;
  /** Contents of webRoot/index.html, read once at startup. */
  indexHtml: string;
  newRequestId: () => string;
  logger: TechnicalLogger;
  readiness: Readiness;
  /** Monotonic milliseconds for request durations. */
  nowMs: () => number;
  identity: IdentityRouteDependencies;
  mfaEnrollment: MfaEnrollmentRouteDependencies;
  mfaVerification: MfaVerificationRouteDependencies;
  setup: SetupRouteDependencies;
  registries: RegistryRouteDependencies;
  records: RecordRouteDependencies;
  screens: ScreenRouteDependencies;
}>;

/**
 * Composition root of the HTTP application. Order matters: API routes and the API 404 come
 * before static files, so an `/api` path can never fall through to the SPA document.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  installHttpFoundation(app, dependencies);
  app.get(HEALTH_PATH, health(dependencies.readiness));
  app.get(PUBLIC_BOOTSTRAP_PATH, publicBootstrap);
  registerIdentityRoutes(app, dependencies.identity);
  registerMfaEnrollmentRoutes(app, dependencies.mfaEnrollment);
  registerMfaVerificationRoutes(app, dependencies.mfaVerification);
  registerSetupRoutes(app, dependencies.setup);
  registerRegistryRoutes(app, dependencies.registries);
  registerRecordRoutes(app, dependencies.records);
  registerScreenRoutes(app, dependencies.screens);
  app.all("/api", apiNotFound);
  app.all("/api/*", apiNotFound);
  app.use("*", webAssets(dependencies.webRoot));
  app.all("*", spaFallback(dependencies.indexHtml));
  return app;
}
