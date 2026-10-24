import { HEALTH_PATH } from "@openlife/contracts/http/health";
import { Hono } from "hono";
import { apiNotFound, unhandledError } from "../http/api-errors.js";
import type { AppEnv } from "../http/app-env.js";
import { requestId } from "../http/middleware/request-id.js";
import { health } from "../http/routes/health.routes.js";
import { spaFallback, webAssets } from "../http/spa.js";

export type AppDependencies = Readonly<{
  /** Absolute directory of the built web app (apps/web/dist). */
  webRoot: string;
  /** Contents of webRoot/index.html, read once at startup. */
  indexHtml: string;
  newRequestId: () => string;
}>;

/**
 * Composition root of the HTTP application. Order matters: API routes and the API 404 come
 * before static files, so an `/api` path can never fall through to the SPA document.
 */
export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestId(dependencies.newRequestId));
  app.get(HEALTH_PATH, health);
  app.all("/api", apiNotFound);
  app.all("/api/*", apiNotFound);
  app.use("*", webAssets(dependencies.webRoot));
  app.all("*", spaFallback(dependencies.indexHtml));
  app.onError(unhandledError);
  return app;
}
