import { serveStatic } from "@hono/node-server/serve-static";
import type { Handler, MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env.js";

const HASHED_ASSET_PREFIX = "/assets/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
// The document must be revalidated so a new release replaces old asset references.
const DOCUMENT_CACHE = "no-cache";

/** Files from the built web app; traversal, `%` and `//` paths are refused by serveStatic. */
export function webAssets(webRoot: string): MiddlewareHandler<AppEnv> {
  return serveStatic<AppEnv>({
    root: webRoot,
    onFound: (_path, c) => {
      c.header("Cache-Control", c.req.path.startsWith(HASHED_ASSET_PREFIX) ? IMMUTABLE_CACHE : DOCUMENT_CACHE);
    },
  });
}

/**
 * A browser navigation outside the API: GET/HEAD for a path whose last segment has no file
 * extension. Missing files such as /assets/app.js or /favicon.ico are not navigations.
 */
export function isNavigation(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  if (path === "/api" || path.startsWith("/api/")) {
    return false;
  }
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}

/** Reloading any UI route returns the SPA document; the client router decides what to show. */
export function spaFallback(indexHtml: string): Handler<AppEnv> {
  return (c) => {
    if (!isNavigation(c.req.method, c.req.path)) {
      return c.text("Not Found", 404);
    }
    c.header("Cache-Control", DOCUMENT_CACHE);
    return c.html(indexHtml, 200);
  };
}
