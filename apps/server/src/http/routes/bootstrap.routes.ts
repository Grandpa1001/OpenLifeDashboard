import { DEFAULT_PUBLIC_BOOTSTRAP, type PublicBootstrap } from "@openlife/contracts/http/bootstrap";
import type { Handler } from "hono";
import type { AppEnv } from "../app-env.js";

/**
 * Public SPA bootstrap. It is built only from the public contract: no environment, secret,
 * host path or private option can reach it (Architektura §14.5, AR15). Owner preferences
 * extend it after sign-in exists (D11/D41).
 */
export const publicBootstrap: Handler<AppEnv> = (c) => {
  const body: PublicBootstrap = DEFAULT_PUBLIC_BOOTSTRAP;
  c.header("Cache-Control", "no-store");
  return c.json(body, 200);
};
