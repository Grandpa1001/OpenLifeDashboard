// D44.6 — the scan of the single page application for the secrets of the installation (Architektura §14.1, §17
// AR15; DEV §9.41). The settings catalog is public and the secrets of the environment are the server's alone:
// no file of the built application names a secret variable, and nothing the running server serves to a
// browser, before sign-in, holds the value of one.
// AC2: every file of the build, the documents the server serves for the application's addresses and the
//      public facts of the installation are free of the names and the values of the secrets.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PUBLIC_BOOTSTRAP_PATH } from "@openlife/contracts/http/bootstrap";
import { afterEach, describe, expect, it } from "vitest";
import { send, serve, stopServers } from "../../support/auth-http.ts";
import { repoRoot, startedInstallation } from "../../support/server-process.ts";

afterEach(stopServers);

const BUILD = path.join(repoRoot, "apps/web/dist");
/** The names of the variables that hold a secret: the public side of the product never names them. */
const SECRET_VARIABLES = ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"];

const filesOf = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));

describe("D44.6-AC2 the application holds no secret", () => {
  it("names no secret variable in any file of the build", () => {
    const files = filesOf(BUILD);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const name of SECRET_VARIABLES) expect(content, `${path.relative(BUILD, file)} names ${name}`).not.toContain(name);
    }
  });

  it("serves no value of a secret in a document or in the public facts of the installation", async () => {
    const instance = await startedInstallation();
    const server = await serve(instance);
    const served = [
      (await send(server, "GET", "/", undefined)).text,
      (await send(server, "GET", "/settings/diagnostics", undefined)).text,
      (await send(server, "GET", PUBLIC_BOOTSTRAP_PATH, undefined)).text,
      (await send(server, "GET", "/api/health", undefined)).text,
    ];
    for (const document of served) {
      expect(document.length).toBeGreaterThan(0);
      for (const secret of instance.secrets) expect(document).not.toContain(secret);
    }
    // And the files the build has are the files that are served: the assets named by the document answer 200.
    const assets = [...(served[0] ?? "").matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1] ?? "");
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const reply = await send(server, "GET", asset, undefined);
      expect(reply.status, asset).toBe(200);
      for (const secret of instance.secrets) expect(reply.text, asset).not.toContain(secret);
    }
  });
});
