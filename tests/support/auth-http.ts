// Real HTTP against the built server for the tests of the second factor (DEV §8.3): an
// installation with an owner made by the real CLI, the routes as thin calls, and the way an
// authenticator app computes a code from the secret the server hands out. The clock is the real
// one; the code of the next time step is accepted by the window, which is how a test gets a code
// that is newer than the last one used without waiting half a minute.
import path from "node:path";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema, type IssuedRecoveryCodesDto } from "@openlife/contracts/http/mfa";
import { createOTP } from "@better-auth/utils/otp";
import { openDatabase } from "../../packages/sqlite/dist/connection/open-database.js";
import { freeLoopbackPort } from "./compose-instance.ts";
import { repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ServerProcess } from "./server-process.ts";
import type { TestInstance } from "./test-instance.ts";

/** A failed precondition of a test installation: it stops the test with the reason. */
function must(condition: boolean, reason: string): void {
  if (!condition) throw new Error(reason);
}

export const OWNER_EMAIL = "owner@example.test";
export const OWNER_PASSWORD = "a passphrase for the second factor";
export const ORIGIN = "http://localhost:8080";
export const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
export const RESET_PASSWORD = path.join(repoRoot, "apps/server/dist/cli/reset-password.js");
export const RESET_MFA = path.join(repoRoot, "apps/server/dist/cli/reset-mfa.js");

export type Installation = Readonly<{ instance: TestInstance; server: ServerProcess }>;

const running: ServerProcess[] = [];
/** The Origin a server accepts when it is not the default one: a browser reaches it at its own address. */
const originOf = new WeakMap<ServerProcess, string>();

/** Stops every server a test started; call it from afterEach. */
export async function stopServers(): Promise<void> {
  for (const server of running.splice(0)) {
    if (server.child.exitCode === null) {
      server.child.kill("SIGTERM");
      await waitForExit(server.child, server.output, 15_000);
    }
  }
}

export async function serve(instance: TestInstance, at?: Readonly<{ port: number; origin: string }>): Promise<ServerProcess> {
  const server = await startBuiltServer({ installation: { dir: instance.dir, env: instance.env }, ...(at === undefined ? {} : { args: ["--port", String(at.port)] }) });
  if (at !== undefined) originOf.set(server, at.origin);
  running.push(server);
  return server;
}

export async function stopServer(server: ServerProcess): Promise<void> {
  server.child.kill("SIGTERM");
  const exit = await waitForExit(server.child, server.output, 15_000);
  must(exit.code === 0, `the server did not stop cleanly:\n${exit.output}`);
}

/** A new installation with its owner and a running server; the password may be chosen. */
export async function installation(password: string = OWNER_PASSWORD): Promise<Installation> {
  const instance = await startedInstallation();
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password }));
  must(created.code === 0, `create-owner failed:\n${created.output}`);
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

export async function send(server: ServerProcess, method: string, route: string, body: unknown, init: { cookie?: string | null | undefined; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...init.headers };
  const origin = init.origin === undefined ? (originOf.get(server) ?? ORIGIN) : init.origin;
  if (origin !== null) headers["Origin"] = origin;
  if (init.cookie) headers["Cookie"] = init.cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${server.baseUrl}${route}`, { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await response.text();
  const setCookies = response.headers.getSetCookie();
  return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) as unknown, cookie: setCookies[0]?.split(";")[0] ?? null, cookies: setCookies.map((line) => line.split(";")[0] ?? ""), setCookies };
}

export const post = (server: ServerProcess, route: string, body: unknown, init: { cookie?: string | null | undefined; origin?: string | null; headers?: Record<string, string> } = {}): Promise<Reply> => send(server, "POST", route, body, init);

/** Signs in; `cookie` carries what the browser already holds, e.g. a trusted-device cookie. */
export const signIn = (server: ServerProcess, cookie?: string | null, password: string = OWNER_PASSWORD) => post(server, "/api/auth/sign-in/email", { email: OWNER_EMAIL, password }, { cookie });
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
export async function enrolled(setup: Installation, password: string = OWNER_PASSWORD) {
  const login = await signIn(setup.server, null, password);
  const passwordCookie = login.cookie ?? "";
  const challenge = enrollmentChallengeSchema.parse((await begin(setup.server, passwordCookie)).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await confirm(setup.server, passwordCookie, challenge.challengeId, await codeOf(secret));
  const codes: IssuedRecoveryCodesDto | null = confirmed.status === 200 ? issuedRecoveryCodesSchema.parse(confirmed.json()) : null;
  return { passwordCookie, challenge, secret, confirmed, codes };
}

/** An owner who enrolled and acknowledged the codes, with the starting data chosen as empty (D11.4 will do that over HTTP). */
export async function readyOwner(setup: Installation, password: string = OWNER_PASSWORD) {
  const first = await enrolled(setup, password);
  const codes = first.codes;
  if (codes === null) throw new Error("the enrollment did not issue codes");
  const acknowledged = await ack(setup.server, first.confirmed.cookie, codes.batchId);
  must(acknowledged.status === 200, "the recovery codes were not acknowledged");
  execute(setup.instance, "UPDATE instance_state SET data_choice = 'empty'");
  return { secret: first.secret, codes: codes.recoveryCodes, sessionCookie: first.confirmed.cookie ?? "" };
}

/** Where the setup of a browser-test owner stands. */
export type OwnerStage = "password_only" | "awaiting_ack" | "data_unchosen" | "preferences_unsaved" | "ready";

export type BrowserOwner = Readonly<{
  baseUrl: string;
  instance: TestInstance;
  email: string;
  password: string;
  /** The authenticator secret and the recovery codes, when the stage has them. */
  secret: Buffer | null;
  recoveryCodes: readonly string[];
  /** The code of the current time step plus `offset`, as an authenticator app shows it. */
  code: (offset?: number) => Promise<string>;
  /** What the server process has written to its output so far. */
  serverOutput: () => string;
  stop: () => Promise<void>;
  /** Stops the server cleanly and starts it again on the same address and data; `between` runs while it is down. */
  restart: (between?: () => void) => Promise<void>;
}>;

/**
 * An installation a browser can use: its BASE_URL is the address the browser opens (the server
 * only accepts a mutation from its own origin), the owner's password has spaces at both ends
 * (it must reach the server untrimmed), and the setup stands at the requested stage, made by the
 * real routes from an API session that is not the browser's.
 */
export async function browserOwner(stage: OwnerStage, password = "  a spaced pass phrase 🔐  "): Promise<BrowserOwner> {
  const port = await freeLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const instance = await startedInstallation({ baseUrl: origin });
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password }));
  must(created.code === 0, `create-owner failed:\n${created.output}`);
  let server = await serve(instance, { port, origin });
  const setup: Installation = { instance, server };
  let secret: Buffer | null = null;
  let recoveryCodes: readonly string[] = [];
  if (stage !== "password_only") {
    const first = await enrolled(setup, password);
    secret = first.secret;
    recoveryCodes = first.codes?.recoveryCodes ?? [];
    if (stage !== "awaiting_ack") {
      const acknowledged = await ack(server, first.confirmed.cookie, first.codes?.batchId ?? "");
      must(acknowledged.status === 200, "the recovery codes were not acknowledged");
      if (stage === "preferences_unsaved" || stage === "ready") {
        const chosen = await post(server, "/api/v1/setup/choose-empty", {}, { cookie: first.confirmed.cookie });
        must(chosen.status === 200, "the starting data were not chosen");
      }
      if (stage === "ready") {
        const saved = await putPreferences(server, first.confirmed.cookie, { timezone: "Europe/Warsaw", locale: "en" });
        must(saved.status === 200, "the preferences were not saved");
      }
    }
  }
  const owner = secret;
  return {
    baseUrl: origin,
    instance,
    email: OWNER_EMAIL,
    password,
    secret: owner,
    recoveryCodes,
    code: (offset = 0) => (owner === null ? Promise.reject(new Error("this stage has no authenticator secret")) : codeOf(owner, offset)),
    serverOutput: () => server.output(),
    stop: () => stopServer(server),
    restart: async (between) => {
      await stopServer(server);
      between?.();
      server = await serve(instance, { port, origin });
    },
  };
}
