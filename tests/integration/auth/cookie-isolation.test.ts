// D09.4-AC2 — two installations A and B on one host, one browser profile (Architektura §9.6).
// Cookies are keyed by host, not by port (RFC 6265 §8.5), so the browser sends the cookies of A
// to B and the other way round. The jar below behaves like that: it keeps every cookie of
// "localhost" and sends all of them to both servers. Each installation's cookie name carries its
// own instanceId prefix, so the logins stay independent: a cookie of A does not authorize B, a
// cookie forged from A's value under B's name does not either, and signing out of A leaves B
// signed in. Restarting keeps keys, identity and sessions. Safari and HTTPS stay in D58–D63.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { afterEach, describe, expect, it } from "vitest";
import { authCookiePrefix } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
const EMAIL = "owner@example.test";
const PASSWORD = "the same passphrase 🔐 in both";
const WRONG = "a wrong password of enough length";

const running: ServerProcess[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
});

type Side = Readonly<{ instance: TestInstance; origin: string; server: ServerProcess }>;

async function side(origin: string): Promise<Side> {
  const instance = await startedInstallation({ baseUrl: origin });
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  expect(created.code, created.output).toBe(0);
  return { instance, origin, server: await serve(instance) };
}

async function serve(instance: TestInstance): Promise<ServerProcess> {
  const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env } });
  running.push(server);
  return server;
}

/** The cookies of host "localhost": every port shares them. */
class BrowserProfile {
  readonly jar = new Map<string, string>();

  header(without: readonly string[] = []): string {
    return [...this.jar].filter(([name]) => !without.includes(name)).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  remember(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === "" || attributes.some((attribute) => /^max-age=0$/i.test(attribute))) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }
}

const cookieName = (instance: TestInstance): string => `${authCookiePrefix(instance.instanceId)}.session_token`;

async function signIn(profile: BrowserProfile, target: Side, password = PASSWORD): Promise<Response> {
  const response = await fetch(`${target.server.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: target.origin, "Content-Type": "application/json", Cookie: profile.header() },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  profile.remember(response);
  return response;
}

async function authenticated(target: Side, cookieHeader: string): Promise<boolean> {
  const response = await fetch(`${target.server.baseUrl}/api/v1/identity/status`, { headers: { Cookie: cookieHeader } });
  return identityStatusSchema.parse(await response.json()).authenticated;
}

function sessions(target: Side): number {
  const reader = openDatabase(path.join(target.instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare("SELECT count(*) FROM session").pluck().get() as number;
  } finally {
    reader.close();
  }
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const identityOf = (target: Side) => {
  const reader = openDatabase(path.join(target.instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return {
      env: sha256(target.instance.envFile),
      instanceFile: sha256(target.instance.instanceFile),
      instanceId: reader.handle.prepare("SELECT instance_id FROM instance").pluck().get(),
      owner: reader.handle.prepare("SELECT owner_id, access_epoch FROM instance_state").get(),
    };
  } finally {
    reader.close();
  }
};

describe("D09.4-AC2 two installations in one browser profile", () => {
  it("each login is independent: cookie names differ, both are sent to both servers, each server accepts only its own", async () => {
    const a = await side("http://localhost:18081");
    const b = await side("http://localhost:18082");
    const profile = new BrowserProfile();
    expect((await signIn(profile, a)).status).toBe(200);
    expect((await signIn(profile, b)).status).toBe(200);

    expect([...profile.jar.keys()].sort()).toEqual([cookieName(a.instance), cookieName(b.instance)].sort());
    expect(cookieName(a.instance)).not.toBe(cookieName(b.instance));
    expect(sessions(a)).toBe(1);
    expect(sessions(b)).toBe(1);
    // The browser sends both cookies to each server; each reads only its own.
    expect(await authenticated(a, profile.header())).toBe(true);
    expect(await authenticated(b, profile.header())).toBe(true);

    // Only A's cookie reaches B: no session there. The same holds the other way round.
    expect(await authenticated(b, profile.header([cookieName(b.instance)]))).toBe(false);
    expect(await authenticated(a, profile.header([cookieName(a.instance)]))).toBe(false);
    // A's value under B's name (a cookie sent by hand): wrong signature and no such session in B.
    const valueOfA = profile.jar.get(cookieName(a.instance)) ?? "";
    expect(await authenticated(b, `${cookieName(b.instance)}=${valueOfA}`)).toBe(false);
    expect(await authenticated(b, `${cookieName(a.instance)}=${valueOfA}`)).toBe(false);
  });

  it("signing out of A leaves B signed in", async () => {
    const a = await side("http://localhost:18083");
    const b = await side("http://localhost:18084");
    const profile = new BrowserProfile();
    await signIn(profile, a);
    await signIn(profile, b);

    const out = await fetch(`${a.server.baseUrl}/api/auth/sign-out`, { method: "POST", headers: { Origin: a.origin, Cookie: profile.header() } });
    expect(out.status).toBe(204);
    profile.remember(out);
    expect([...profile.jar.keys()]).toEqual([cookieName(b.instance)]);
    expect(sessions(a)).toBe(0);
    expect(sessions(b)).toBe(1);
    expect(await authenticated(a, profile.header())).toBe(false);
    expect(await authenticated(b, profile.header())).toBe(true);
  });

  it("a restart keeps keys, identity and sessions, and the cookie follows the instance, not the port", async () => {
    const a = await side("http://localhost:18085");
    const profile = new BrowserProfile();
    await signIn(profile, a);
    const before = identityOf(a);
    const oldPort = a.server.baseUrl;

    a.server.child.kill("SIGTERM");
    expect((await waitForExit(a.server.child, a.server.output, 15_000)).code).toBe(0);
    const restarted: Side = { ...a, server: await serve(a.instance) };
    expect(restarted.server.baseUrl).not.toBe(oldPort);

    expect(identityOf(restarted)).toEqual(before);
    expect(await authenticated(restarted, profile.header())).toBe(true);
    expect(sessions(restarted)).toBe(1);
  });

  it("no password reaches a server output or the technical log, also after wrong attempts", async () => {
    const a = await side("http://localhost:18086");
    const profile = new BrowserProfile();
    await signIn(profile, a, WRONG);
    await signIn(profile, a);
    for (const text of [a.server.output(), readFileSync(path.join(a.instance.dir, "data", "logs", "app", "app.jsonl"), "utf8")]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain(profile.jar.get(cookieName(a.instance)) ?? "no cookie");
    }
  });
});
