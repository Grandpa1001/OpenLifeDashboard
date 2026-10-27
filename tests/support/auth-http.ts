// Real HTTP against the built server for the tests of the second factor (DEV §8.3): an
// installation with an owner made by the real CLI, the routes as thin calls, and the way an
// authenticator app computes a code from the secret the server hands out. The clock is the real
// one; the code of the next time step is accepted by the window, which is how a test gets a code
// that is newer than the last one used without waiting half a minute.
import path from "node:path";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema, type IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { createOTP } from "@better-auth/utils/otp";
import { expect } from "vitest";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "./server-process.ts";
import type { TestInstance } from "./test-instance.ts";

export const OWNER_EMAIL = "owner@example.test";
export const OWNER_PASSWORD = "a passphrase for the second factor";
export const ORIGIN = "http://localhost:8080";
export const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
export const RESET_PASSWORD = path.join(repoRoot, "apps/server/dist/cli/reset-password.js");
export const RESET_MFA = path.join(repoRoot, "apps/server/dist/cli/reset-mfa.js");

export type Installation = Readonly<{ instance: TestInstance; server: ServerProcess }>;

const running: ServerProcess[] = [];

/** Stops every server a test started; call it from afterEach. */
export async function stopServers(): Promise<void> {
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
}

export async function serve(instance: TestInstance): Promise<ServerProcess> {
  const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env } });
  running.push(server);
  return server;
}

export async function stopServer(server: ServerProcess): Promise<void> {
  server.child.kill("SIGTERM");
  expect((await waitForExit(server.child, server.output, 15_000)).code).toBe(0);
}

/** A new installation with its owner and a running server. */
export async function installation(): Promise<Installation> {
  const instance = await startedInstallation();
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
  expect(created.code, created.output).toBe(0);
  return { instance, server: await serve(instance) };
}

export type Reply = Readonly<{
  status: number;
  headers: Headers;
  text: string;
  json: () => unknown;
  /** The first cookie set, as `name=value`. */
  cookie: string | null;
  /** Every cookie set, as `name=value`. */
  cookies: string[];
  /** The raw Set-Cookie lines. */
  setCookies: string[];
}>;

export async function send(server: ServerProcess, method: string, route: string, body: unknown, init: { cookie?: string | null | undefined; origin?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers["Origin"] = origin;
  if (init.cookie) headers["Cookie"] = init.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${server.baseUrl}${route}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await response.text();
  const setCookies = response.headers.getSetCookie();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) as unknown, cookie: setCookies[0]?.split(";")[0] ?? null, cookies: setCookies.map((line) => line.split(";")[0] ?? ""), setCookies };
}

export const post = (server: ServerProcess, route: string, body: unknown, init: { cookie?: string | null | undefined; origin?: string | null } = {}): Promise<Reply> => send(server, "POST", route, body, init);

/** Signs in; `cookie` carries what the browser already holds, e.g. a trusted-device cookie. */
export const signIn = (server: ServerProcess, cookie?: string | null) => post(server, "/api/auth/sign-in/email", { email: OWNER_EMAIL, password: OWNER_PASSWORD }, { cookie });
export const begin = (server: ServerProcess, cookie: string | null) => post(server, "/api/v1/mfa/enrollment/begin", {}, { cookie });
export const confirm = (server: ServerProcess, cookie: string | null, challengeId: string, code: string) => post(server, "/api/v1/mfa/enrollment/confirm", { challengeId, code }, { cookie });
export const reissue = (server: ServerProcess, cookie: string | null, code: string) => post(server, "/api/v1/mfa/enrollment/recovery/reissue", { code }, { cookie });
export const ack = (server: ServerProcess, cookie: string | null, batchId: string) => post(server, "/api/v1/mfa/enrollment/recovery/ack", { batchId }, { cookie });
export const verify = (server: ServerProcess, cookie: string | null, body: unknown) => post(server, "/api/v1/mfa/verify", body, { cookie });
export const stepUp = (server: ServerProcess, cookie: string | null, code: string) => post(server, "/api/v1/mfa/step-up", { code }, { cookie });

export const setupStatus = (server: ServerProcess, cookie: string | null) => send(server, "GET", "/api/v1/setup/status", undefined, { cookie });
export const chooseEmpty = (server: ServerProcess, cookie: string | null) => post(server, "/api/v1/setup/choose-empty", {}, { cookie });
export const getPreferences = (server: ServerProcess, cookie: string | null) => send(server, "GET", "/api/v1/setup/preferences", undefined, { cookie });
export const putPreferences = (server: ServerProcess, cookie: string | null, body: unknown) => send(server, "PUT", "/api/v1/setup/preferences", body, { cookie });

export async function status(server: ServerProcess, cookie: string | null) {
  const response = await fetch(`${server.baseUrl}/api/v1/identity/status`, { headers: cookie ? { Cookie: cookie } : {} });
  return identityStatusSchema.parse(await response.json());
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The secret bytes of an otpauth URI, the way an authenticator app reads them. */
export function secretOf(otpauthUri: string): Buffer {
  const encoded = new URL(otpauthUri).searchParams.get("secret") ?? "";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of encoded.replace(/=+$/, "")) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The code of the current time step plus `stepOffset`. */
export const codeOf = (secret: Buffer, stepOffset = 0): Promise<string> => createOTP(secret, { digits: 6, period: 30 }).hotp(Math.floor(Date.now() / 30_000) + stepOffset);

export function query<T>(instance: TestInstance, sql: string): T[] {
  const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all() as T[];
  } finally {
    reader.close();
  }
}

/** Runs statements through a short-lived writer connection, e.g. an arrangement that stands for a later step. */
export function execute(instance: TestInstance, sql: string): void {
  const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
  try {
    writer.handle.exec(sql);
  } finally {
    writer.close();
  }
}

export const mfaState = (instance: TestInstance) =>
  query<{ enrollment_state: string; secret_generation: number; active_secret: string | null; pending_challenge_id: string | null; recovery_batch_id: string | null; last_used_step: number | null }>(
    instance,
    "SELECT enrollment_state, secret_generation, active_secret, pending_challenge_id, recovery_batch_id, last_used_step FROM mfa_state",
  )[0];

export const count = (instance: TestInstance, table: string): number => query<{ n: number }>(instance, `SELECT count(*) AS n FROM "${table}"`)[0]?.n ?? -1;

/** Password session → begin → confirm: an owner whose TOTP is active and whose codes await the acknowledgment. */
export async function enrolled(setup: Installation) {
  const login = await signIn(setup.server);
  const passwordCookie = login.cookie ?? "";
  const challenge = enrollmentChallengeSchema.parse((await begin(setup.server, passwordCookie)).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await confirm(setup.server, passwordCookie, challenge.challengeId, await codeOf(secret));
  const codes: IssuedRecoveryCodesDto | null = confirmed.status === 200 ? issuedRecoveryCodesSchema.parse(confirmed.json()) : null;
  return { passwordCookie, challenge, secret, confirmed, codes };
}

/** An owner who enrolled and acknowledged the codes, with the starting data chosen as empty (D11.4 will do that over HTTP). */
export async function readyOwner(setup: Installation) {
  const first = await enrolled(setup);
  const codes = first.codes;
  if (codes === null) throw new Error("the enrollment did not issue codes");
  expect((await ack(setup.server, first.confirmed.cookie, codes.batchId)).status).toBe(200);
  execute(setup.instance, "UPDATE instance_state SET data_choice = 'empty'");
  return { secret: first.secret, codes: codes.recoveryCodes, sessionCookie: first.confirmed.cookie ?? "" };
}
