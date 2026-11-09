import { PUBLIC_BOOTSTRAP_PATH } from "@openlife/contracts/http/bootstrap";
import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { Hono } from "hono";
import type { Announce } from "../adapters/events/live-hub.js";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { apiNotFound } from "../http/api-errors.js";
import type { AppEnv } from "../http/app-env.js";
import { installHttpFoundation } from "../http/foundation.js";
import { publicBootstrap } from "../http/routes/bootstrap.routes.js";
import { health } from "../http/routes/health.routes.js";
import { registerDictionaryRoutes, type DictionaryRouteDependencies } from "../http/routes/dictionaries.routes.js";
import { registerConfigRoutes, type ConfigRouteDependencies } from "../http/routes/config.routes.js";
import { registerIdentityRoutes, type IdentityRouteDependencies } from "../http/routes/identity.routes.js";
import { registerMfaEnrollmentRoutes, type MfaEnrollmentRouteDependencies } from "../http/routes/mfa-enrollment.routes.js";
import { registerRecordRoutes, type RecordRouteDependencies } from "../http/routes/records.routes.js";
import { registerScreenRoutes, type ScreenRouteDependencies } from "../http/routes/screens.routes.js";
import { registerRegistryRoutes, type RegistryRouteDependencies } from "../http/routes/registries.routes.js";
import { registerStructureRoutes, type StructureRouteDependencies } from "../http/routes/structure.routes.js";
import { registerSetupRoutes, type SetupRouteDependencies } from "../http/routes/setup.routes.js";
import { registerStreamRoutes, type StreamRouteDependencies } from "../http/routes/stream.routes.js";
import { registerSystemTableRoutes, type SystemTableRouteDependencies } from "../http/routes/system-tables.routes.js";
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
  structure: StructureRouteDependencies;
  records: RecordRouteDependencies;
  dictionaries: DictionaryRouteDependencies;
  config: ConfigRouteDependencies;
  screens: ScreenRouteDependencies;
  systemTables: SystemTableRouteDependencies;
  stream: StreamRouteDependencies;
  /** Tells the open streams of a committed change; a failure of it never changes the answer of the route. */
  announce: Announce;
}>;

/**
 * Composition root of the HTTP application. Order matters: API routes and the API 404 come
 * before static files, so an `/api` path can never fall through to the SPA document.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // The change is committed by now: if the streams cannot be told, the tab that missed it reads again on its next reconnect.
  const announce: Announce = (event) => {
    try {
      dependencies.announce(event);
    } catch (error) {
      dependencies.logger.log({ level: "warn", event: "live.announce_failed", error });
    }
  };
  installHttpFoundation(app, dependencies);
  app.get(HEALTH_PATH, health(dependencies.readiness));
  app.get(PUBLIC_BOOTSTRAP_PATH, publicBootstrap);
  registerIdentityRoutes(app, dependencies.identity);
  registerMfaEnrollmentRoutes(app, dependencies.mfaEnrollment);
  registerMfaVerificationRoutes(app, dependencies.mfaVerification);
  registerSetupRoutes(app, dependencies.setup);
  registerRegistryRoutes(app, dependencies.registries, announce);
  registerStructureRoutes(app, dependencies.structure, announce);
  registerRecordRoutes(app, dependencies.records, announce);
  registerDictionaryRoutes(app, dependencies.dictionaries, announce);
  registerConfigRoutes(app, dependencies.config, announce);
  registerScreenRoutes(app, dependencies.screens, announce);
  registerSystemTableRoutes(app, dependencies.systemTables);
  registerStreamRoutes(app, dependencies.stream);
  app.all("/api", apiNotFound);
  app.all("/api/*", apiNotFound);
  app.use("*", webAssets(dependencies.webRoot));
  app.all("*", spaFallback(dependencies.indexHtml));
  return app;
}
