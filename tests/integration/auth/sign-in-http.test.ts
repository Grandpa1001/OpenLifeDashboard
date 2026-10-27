// D09.3 — sign-in, sign-out and status over real HTTP on the built server and a real database
// (Architektura §9.8, §18.7). The owner is created by the real CLI; the server is started and
// restarted as a process.
// AC1: the correct password creates only the basic session and the status says what is next; a
//      wrong password and a foreign e-mail give the same 401 DTO; counters and audit stay in the
//      database and survive a restart; the fifth failure answers 429 with Retry-After.
// AC2: a failing audit gives 503 with no session or Set-Cookie and no stored counter; no
//      library route is mounted (404 NOT_FOUND); a missing or foreign Origin is refused before
//      credentials are tried; no public JSON carries a token or a raw session.
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { authLockedDetailsSchema, identityStatusSchema } from "@openlife/contracts/http/identity";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { authCookiePrefix } from "../../../apps/server/dist/adapters/auth/auth-options.js";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
const EMAIL = "owner@example.test";
const PASSWORD = "  zażółć 🔐 $(id) gęślą  ";
const WRONG = "a wrong password of enough length";
const ORIGIN = "http://localhost:8080";

const running: ServerProcess[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
});

async function ownerInstallation(): Promise<TestInstance> {
  const instance = await startedInstallation();
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: EMAIL, password: PASSWORD }));
  expect(created.code, created.output).toBe(0);
  return instance;
}

async function serve(instance: TestInstance): Promise<ServerProcess> {
  const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env } });
  running.push(server);
  return server;
}

async function stop(server: ServerProcess): Promise<void> {
  server.child.kill("SIGTERM");
  expect((await waitForExit(server.child, server.output, 15_000)).code).toBe(0);
}

type Reply = Readonly<{ status: number; headers: Headers; text: string; json: () => unknown; cookies: string[] }>;

async function call(server: ServerProcess, method: string, route: string, init: { origin?: string | null; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...init.headers };
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers["Origin"] = origin;
  if (init.cookie !== undefined) headers["Cookie"] = init.cookie;
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  }
  const response = await fetch(`${server.baseUrl}${route}`, { method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) as unknown, cookies: response.headers.getSetCookie() };
}

const signIn = (server: ServerProcess, password: string, init: { email?: string; origin?: string | null; headers?: Record<string, string> } = {}) =>
  call(server, "POST", "/api/auth/sign-in/email", { body: { email: init.email ?? EMAIL, password }, ...(init.origin === undefined ? {} : { origin: init.origin }), ...(init.headers === undefined ? {} : { headers: init.headers }) });

function query<T>(instance: TestInstance, sql: string): T[] {
  const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all() as T[];
  } finally {
    reader.close();
  }
}
const count = (instance: TestInstance, table: string): number => query<{ n: number }>(instance, `SELECT count(*) AS n FROM "${table}"`)[0]?.n ?? -1;
const cookieName = (instance: TestInstance): string => `${authCookiePrefix(instance.instanceId)}.session_token`;
const withoutRequestId = (reply: Reply): unknown => ({ ...(reply.json() as Record<string, unknown>), requestId: "-" });

describe("D09.3-AC1 sign-in, status and sign-out", () => {
  it("the correct password creates one basic session; the cookie is the only place of the token", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    expect(identityStatusSchema.parse((await call(server, "GET", "/api/v1/identity/status")).json())).toEqual({ authenticated: false, nextAction: "login" });

    const granted = await signIn(server, PASSWORD);
    expect(granted.status).toBe(200);
    expect(identityStatusSchema.parse(granted.json())).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    expect(granted.headers.get("cache-control")).toBe("no-store");

    expect(granted.cookies).toHaveLength(1);
    const setCookie = granted.cookies[0] ?? "";
    expect(setCookie).toMatch(new RegExp(`^${cookieName(instance).replace(".", "\\.")}=`));
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).toMatch(/; HttpOnly/i);
    expect(setCookie).toMatch(/; SameSite=Lax/i);
    expect(setCookie).not.toMatch(/; Secure/i);
    expect(setCookie).toMatch(/Max-Age=2592000|Max-Age=259199\d/);

    const sessions = query<{ token: string; userId: string; ipAddress: string | null }>(instance, "SELECT token, userId, ipAddress FROM session");
    expect(sessions).toHaveLength(1);
    const token = sessions[0]?.token ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(granted.text).not.toContain(token);
    expect(sessions[0]?.ipAddress).toBeTruthy();
    expect(query(instance, "SELECT action, actor FROM audit_log WHERE action LIKE 'login.%'")).toEqual([{ action: "login.succeeded", actor: sessions[0]?.userId }]);

    const cookie = setCookie.split(";")[0] ?? "";
    const status = await call(server, "GET", "/api/v1/identity/status", { cookie });
    expect(identityStatusSchema.parse(status.json())).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    expect(status.text).not.toContain(token);
    // A cookie with a changed signature, an unsigned token and another installation's cookie name are not a session.
    const [name, value = ""] = cookie.split("=");
    const forged = [`${name}=${value.replace(/.$/, value.endsWith("A") ? "B" : "A")}`, `${name}=${token}`, `openlife-000000000000.session_token=${value}`];
    for (const bad of forged) {
      expect(identityStatusSchema.parse((await call(server, "GET", "/api/v1/identity/status", { cookie: bad })).json()).authenticated).toBe(false);
    }
  });

  it("sign-out ends the session, clears the cookie and is idempotent; the old cookie no longer authenticates", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    const cookie = (await signIn(server, PASSWORD)).cookies[0]?.split(";")[0] ?? "";

    const out = await call(server, "POST", "/api/auth/sign-out", { cookie });
    expect(out.status).toBe(204);
    expect(out.text).toBe("");
    expect(out.cookies[0]).toMatch(new RegExp(`^${cookieName(instance).replace(".", "\\.")}=;`));
    expect(out.cookies[0]).toMatch(/Max-Age=0/);
    expect(count(instance, "session")).toBe(0);
    expect(identityStatusSchema.parse((await call(server, "GET", "/api/v1/identity/status", { cookie })).json()).authenticated).toBe(false);
    expect((await call(server, "POST", "/api/auth/sign-out", { cookie })).status).toBe(204);
    expect((await call(server, "POST", "/api/auth/sign-out")).status).toBe(204);
  });

  it("a wrong password and a foreign e-mail give the same 401 DTO; counters and audit are stored", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    const wrong = await signIn(server, WRONG);
    const foreign = await signIn(server, PASSWORD, { email: "foreign@example.test" });
    for (const reply of [wrong, foreign]) {
      expect(reply.status).toBe(401);
      expect(reply.cookies).toEqual([]);
      expect(reply.headers.get("retry-after")).toBeNull();
      expect(apiErrorSchema.parse(reply.json()).code).toBe("INVALID_CREDENTIALS");
    }
    expect(withoutRequestId(wrong)).toEqual(withoutRequestId(foreign));
    expect(count(instance, "session")).toBe(0);
    expect(count(instance, "auth_lockout")).toBe(3);
    expect(query<{ details: string }>(instance, "SELECT details FROM audit_log WHERE action = 'login.failed' ORDER BY id").map((row) => row.details)).toEqual([
      '{"ownerMatched":true,"locked":false}',
      '{"ownerMatched":false,"locked":false}',
    ]);
    // The failure is findable by the requestId of the response (§15.2).
    expect(query(instance, `SELECT request_id FROM audit_log WHERE action = 'login.failed' AND request_id = '${apiErrorSchema.parse(wrong.json()).requestId}'`)).toHaveLength(1);
  });

  it("F09 password-lockout-survives-restart: the fifth failure answers 429 AUTH_LOCKED with Retry-After; the lock holds for the correct password, a spoofed X-Forwarded-For and a restart", async () => {
    const instance = await ownerInstallation();
    let server = await serve(instance);
    const spoof = (index: number) => ({ "X-Forwarded-For": `198.51.100.${index}` });
    for (let failure = 1; failure <= 4; failure += 1) {
      expect((await signIn(server, WRONG, { headers: spoof(failure) })).status).toBe(401);
    }
    const fifth = await signIn(server, WRONG, { headers: spoof(5) });
    expect(fifth.status).toBe(429);
    expect(apiErrorSchema.parse(fifth.json()).code).toBe("AUTH_LOCKED");
    const retryAfter = Number(fifth.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(890);
    expect(retryAfter).toBeLessThanOrEqual(900);
    const details = authLockedDetailsSchema.parse(apiErrorSchema.parse(fifth.json()).details);
    expect(details.retryAfterSeconds).toBe(retryAfter);
    const lockedUntil = query(instance, "SELECT bucket_key, locked_until_ms FROM auth_lockout ORDER BY bucket_key");

    for (const attempt of [() => signIn(server, PASSWORD), () => signIn(server, WRONG), () => signIn(server, PASSWORD, { email: "foreign@example.test" })]) {
      const blocked = await attempt();
      expect(blocked.status).toBe(429);
      expect(blocked.cookies).toEqual([]);
    }
    expect(query(instance, "SELECT bucket_key, locked_until_ms FROM auth_lockout ORDER BY bucket_key")).toEqual(lockedUntil);
    expect(count(instance, "session")).toBe(0);

    await stop(server);
    server = await serve(instance);
    const afterRestart = await signIn(server, PASSWORD);
    expect(afterRestart.status).toBe(429);
    expect(apiErrorSchema.parse(afterRestart.json()).code).toBe("AUTH_LOCKED");
  });

  it("more than 10 sign-in requests a minute from one address are limited with 429 RATE_LIMITED, apart from the lockout", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    for (let request = 1; request <= 10; request += 1) {
      expect((await call(server, "POST", "/api/auth/sign-in/email", { body: "not json" })).status).toBe(422);
    }
    const limited = await call(server, "POST", "/api/auth/sign-in/email", { body: "not json" });
    expect(limited.status).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).code).toBe("RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(count(instance, "auth_lockout")).toBe(0);
  });

  const invalidBodies: ReadonlyArray<readonly [string, unknown]> = [
    ["not JSON", "email=owner@example.test"],
    ["an unknown field", { email: EMAIL, password: PASSWORD, remember: true }],
    ["a missing password", { email: EMAIL }],
    ["a password beyond the size bound", { email: EMAIL, password: "x".repeat(257) }],
    ["a body beyond 4 KiB", { email: EMAIL, password: "x".repeat(5000) }],
  ];
  for (const [name, body] of invalidBodies) {
    it(`${name} is 422 VALIDATION_FAILED and tries no credential`, async () => {
      const instance = await ownerInstallation();
      const server = await serve(instance);
      const reply = await call(server, "POST", "/api/auth/sign-in/email", { body });
      expect(reply.status).toBe(422);
      expect(apiErrorSchema.parse(reply.json()).code).toBe("VALIDATION_FAILED");
      expect(count(instance, "auth_lockout")).toBe(0);
      expect(count(instance, "audit_log")).toBe(1);
    });
  }
});

describe("D09.3-AC2 failures, closed routes and Origin", () => {
  it("F09 login-audit-failure-issues-no-session: a failing audit gives 503 AUTH_UNAVAILABLE, no Set-Cookie, no session and no counter; after repair sign-in works", async () => {
    const instance = await ownerInstallation();
    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    writer.close();
    const server = await serve(instance);

    for (const password of [PASSWORD, WRONG]) {
      const reply = await signIn(server, password);
      expect(reply.status).toBe(503);
      expect(reply.cookies).toEqual([]);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(apiErrorSchema.parse(reply.json()).code).toBe("AUTH_UNAVAILABLE");
      expect(reply.text).not.toContain("audit unavailable");
    }
    expect(count(instance, "session")).toBe(0);
    expect(count(instance, "auth_lockout")).toBe(0);

    const repair = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    repair.handle.exec("DROP TRIGGER fail_audit;");
    repair.close();
    expect((await signIn(server, PASSWORD)).status).toBe(200);
    expect(count(instance, "session")).toBe(1);
  });

  it("no route of the library is mounted: every one answers the API 404 and changes nothing", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    const routes: ReadonlyArray<readonly [string, string]> = [
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-in/username"],
      ["GET", "/api/auth/get-session"],
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/forget-password"],
      ["POST", "/api/auth/request-password-reset"],
      ["POST", "/api/auth/reset-password"],
      ["GET", "/api/auth/reset-password/some-token"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/delete-user"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/revoke-session"],
      ["POST", "/api/auth/revoke-sessions"],
      ["POST", "/api/auth/revoke-other-sessions"],
      ["GET", "/api/auth/token"],
      ["GET", "/api/auth/verify-email"],
      ["POST", "/api/auth/send-verification-email"],
      ["GET", "/api/auth/ok"],
      ["GET", "/api/auth/anything/else"],
      ["GET", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/sign-out"],
      ["PUT", "/api/v1/identity/status"],
    ];
    const before = { users: count(instance, "user"), sessions: count(instance, "session"), accounts: count(instance, "account"), verification: count(instance, "verification") };
    for (const [method, route] of routes) {
      const reply = await call(server, method, route, { body: method === "GET" ? undefined : { email: "attacker@example.test", password: "a password of enough length", name: "x" } });
      expect(reply.status, `${method} ${route}`).toBe(404);
      expect(apiErrorSchema.parse(reply.json()).code).toBe("NOT_FOUND");
    }
    expect({ users: count(instance, "user"), sessions: count(instance, "session"), accounts: count(instance, "account"), verification: count(instance, "verification") }).toEqual(before);
  });

  const origins: ReadonlyArray<readonly [string, string | null]> = [
    ["no Origin", null],
    ["a foreign Origin", "https://evil.example"],
    ["the same host on another port", "http://localhost:3000"],
    ["the same host over https", "https://localhost:8080"],
    ["the literal null Origin", "null"],
    ["the Origin with a path", `${ORIGIN}/`],
  ];
  for (const [name, origin] of origins) {
    it(`${name}: sign-in and sign-out are 403 ORIGIN_FORBIDDEN before any credential is tried`, async () => {
      const instance = await ownerInstallation();
      const server = await serve(instance);
      const reply = await signIn(server, PASSWORD, { origin });
      expect(reply.status).toBe(403);
      expect(reply.cookies).toEqual([]);
      expect(apiErrorSchema.parse(reply.json()).code).toBe("ORIGIN_FORBIDDEN");
      const out = await call(server, "POST", "/api/auth/sign-out", { origin });
      expect(out.status).toBe(403);
      expect(count(instance, "session")).toBe(0);
      expect(count(instance, "auth_lockout")).toBe(0);
      expect(count(instance, "audit_log")).toBe(1);
      // Reading the status is a safe method and needs no Origin.
      expect((await call(server, "GET", "/api/v1/identity/status", { origin })).status).toBe(200);
    });
  }

  it("a sign-out with a foreign Origin does not end the session", async () => {
    const instance = await ownerInstallation();
    const server = await serve(instance);
    const cookie = (await signIn(server, PASSWORD)).cookies[0]?.split(";")[0] ?? "";
    expect((await call(server, "POST", "/api/auth/sign-out", { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(count(instance, "session")).toBe(1);
  });

  it("an installation without an owner says create_owner and refuses every sign-in the same way", async () => {
    const instance = await startedInstallation();
    const server = await serve(instance);
    expect(identityStatusSchema.parse((await call(server, "GET", "/api/v1/identity/status")).json())).toEqual({ authenticated: false, nextAction: "create_owner" });
    const reply = await signIn(server, PASSWORD);
    expect(reply.status).toBe(401);
    expect(apiErrorSchema.parse(reply.json()).code).toBe("INVALID_CREDENTIALS");
  });
});
