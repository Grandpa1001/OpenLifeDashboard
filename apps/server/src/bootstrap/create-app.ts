import { PUBLIC_BOOTSTRAP_PATH } from "@openlife/contracts/http/bootstrap";
import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { Hono } from "hono";
import type { TechnicalLogger } from "../adapters/logging/technical-logger.js";
import { apiNotFound } from "../http/api-errors.js";
import type { AppEnv } from "../http/app-env.js";
import { installHttpFoundation } from "../http/foundation.js";
import { publicBootstrap } from "../http/routes/bootstrap.routes.js";
import { health } from "../http/routes/health.routes.js";
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
  app.all("/api", apiNotFound);
  app.all("/api/*", apiNotFound);
  app.use("*", webAssets(dependencies.webRoot));
  app.all("*", spaFallback(dependencies.indexHtml));
  return app;
}
