// Playwright fixtures: the built server of apps/server serving the built SPA, on a fresh test
// installation per test (DEV §8.3: an isolated instance, never the owner's data). The page's
// baseURL points at that server, so every test talks to its own process.
import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base } from "@playwright/test";
import { removeScratchDirs } from "../support/scratch.ts";
import { browserOwner, stopServers, type BrowserOwner, type OwnerStage } from "../support/auth-http.ts";
import { freshTestInstance, repoRoot, startBuiltServer, waitForExit, type ServerProcess } from "../support/server-process.ts";

const STOP_TIMEOUT_MS = 20_000;

export type RunningServer = ServerProcess &
  Readonly<{
    /** Installation keys of this server: must never reach the browser. */
    secrets: readonly string[];
    /** SIGTERM and wait for the process to end, as when the app is stopped or restarted. */
    stop: () => Promise<void>;
  }>;

/** Texts of one namespace of the SPA in one language, read from the same files the build uses. */
export function locale(language: "pl" | "en", namespace: "common" | "auth" | "errors" | "registers" | "setup" | "widgets" = "common"): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, "apps/web/src/locales", language, `${namespace}.json`), "utf8")) as Record<string, unknown>;
}

/** A text by its dotted key, e.g. text(pl, "status.ready.heading"). */
export function text(texts: Record<string, unknown>, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => (typeof node === "object" && node !== null ? Reflect.get(node, part) : undefined), texts);
  if (typeof value !== "string") throw new Error(`no text ${key}`);
  return value;
}

export const test = base.extend<{ server: RunningServer; ownerServer: (stage: OwnerStage) => Promise<BrowserOwner> }, { scratchCleanup: void }>({
  scratchCleanup: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
    async ({}, use) => {
      await use();
      removeScratchDirs();
    },
    { scope: "worker", auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form.
  server: async ({}, use) => {
    const installation = freshTestInstance();
    const server = await startBuiltServer({ installation });
    const stop = async (): Promise<void> => {
      if (server.child.exitCode !== null || server.child.signalCode !== null) return;
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, STOP_TIMEOUT_MS);
    };
    await use({ ...server, secrets: installation.secrets, stop });
    await stop();
  },
  // An installation with an owner at the requested stage of the setup, reachable by the browser at
  // its own address; every one started here is stopped after the test. The browser context is
  // closed first: Chromium keeps speculative connections open that never send a request, and the
  // server's orderly stop waits for a connection that has not finished its headers until its own
  // deadline (§15.2). (The `server` fixture is below the context in the dependency order, so the
  // context is already closed when it stops.)
  ownerServer: async ({ context }, use) => {
    await use((stage) => browserOwner(stage));
    await context.close();
    await stopServers();
  },
  baseURL: async ({ server }, use) => {
    await use(server.baseUrl);
  },
});

export { expect } from "@playwright/test";
