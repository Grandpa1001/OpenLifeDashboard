// D09.4-AC1 — the built `reset-password` CLI on real installations (Architektura §9.6, §9.8).
// One transaction replaces the credential, raises the access epoch, ends every session and
// writes the audit entry; the old cookie is no longer authenticated, the old password is
// refused, the new one works; a running app, a failing audit, invalid input and a missing owner
// change nothing. (F09 reset-password-revokes-session)
import { readFileSync } from "node:fs";
import path from "node:path";
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { describe, expect, it, afterEach } from "vitest";
import { createPasswordHasher } from "../../../apps/server/dist/adapters/auth/password-hasher.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { outputEvent, repoRoot, runBuiltScript, startBuiltServer, startedInstallation, waitForExit, type ProcessExit, type ServerProcess } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const CREATE_OWNER = path.join(repoRoot, "apps/server/dist/cli/create-owner.js");
const RESET_PASSWORD = path.join(repoRoot, "apps/server/dist/cli/reset-password.js");
const EMAIL = "owner@example.test";
const OLD_PASSWORD = "  zażółć 🔐 $(id) gęślą  ";
const NEW_PASSWORD = "a brand new passphrase\twith\na newline 🔑";
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

const env = (instance: TestInstance): NodeJS.ProcessEnv => ({ PATH: process.env["PATH"] ?? "", ...instance.env });
const cli = (script: string, instance: TestInstance, stdin: string, args: readonly string[] = []): Promise<ProcessExit> =>
  runBuiltScript(script, ["--installation", instance.dir, ...args], env(instance), stdin);
const failure = (run: ProcessExit): Record<string, unknown> | undefined => outputEvent(run.output, "reset-password.failed");

async function ownerInstallation(): Promise<TestInstance> {
  const instance = await startedInstallation();
  const created = await cli(CREATE_OWNER, instance, JSON.stringify({ email: EMAIL, password: OLD_PASSWORD }));
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

const signIn = (server: ServerProcess, password: string): Promise<Response> =>
  fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });

async function statusWith(server: ServerProcess, cookie: string): Promise<boolean> {
  const response = await fetch(`${server.baseUrl}/api/v1/identity/status`, { headers: { Cookie: cookie } });
  return identityStatusSchema.parse(await response.json()).authenticated;
}

const cookieOf = (response: Response): string => response.headers.getSetCookie()[0]?.split(";")[0] ?? "";

function query<T>(instance: TestInstance, sql: string): T[] {
  const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
  try {
    return reader.handle.prepare(sql).all() as T[];
  } finally {
    reader.close();
  }
}
const state = (instance: TestInstance) => ({
  password: query<{ password: string }>(instance, "SELECT password FROM account")[0]?.password,
  epoch: query<{ access_epoch: number }>(instance, "SELECT access_epoch FROM instance_state")[0]?.access_epoch,
  sessions: query<{ n: number }>(instance, "SELECT count(*) AS n FROM session")[0]?.n,
  audit: query<{ n: number }>(instance, "SELECT count(*) AS n FROM audit_log WHERE action = 'owner.password_reset'")[0]?.n,
});

describe("D09.4-AC1 reset-password", () => {
  it("F09 reset-password-revokes-session: the old cookie stops authenticating, the old password is refused, the new one works", async () => {
    const instance = await ownerInstallation();
    let server = await serve(instance);
    const first = cookieOf(await signIn(server, OLD_PASSWORD));
    const second = cookieOf(await signIn(server, OLD_PASSWORD));
    expect(await statusWith(server, first)).toBe(true);
    expect(await statusWith(server, second)).toBe(true);
    const before = state(instance);
    expect(before).toMatchObject({ epoch: 1, sessions: 2, audit: 0 });

    // A running app holds the writer: the command is refused and changes nothing.
    const busy = await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }));
    expect(busy.code).toBe(1);
    expect(failure(busy)).toEqual({ event: "reset-password.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] });
    expect(state(instance)).toEqual(before);

    await stop(server);
    const reset = await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }));
    expect(reset.code, reset.output).toBe(0);
    expect(outputEvent(reset.output, "owner.password_reset")).toMatchObject({ accessEpoch: 2, revokedSessions: 2 });
    expect(reset.output).not.toContain(NEW_PASSWORD);

    const after = state(instance);
    expect(after).toMatchObject({ epoch: 2, sessions: 0, audit: 1 });
    expect(after.password).not.toBe(before.password);
    expect(await createPasswordHasher().verify(after.password ?? "", NEW_PASSWORD)).toBe(true);
    expect(await createPasswordHasher().verify(after.password ?? "", OLD_PASSWORD)).toBe(false);
    expect(query(instance, "SELECT actor, entity, details FROM audit_log WHERE action = 'owner.password_reset'")).toEqual([
      { actor: expect.any(String), entity: "owner", details: '{"accessEpoch":2,"revokedSessions":2,"revokedDevices":0}' },
    ]);

    server = await serve(instance);
    expect(await statusWith(server, first)).toBe(false);
    expect(await statusWith(server, second)).toBe(false);
    expect((await signIn(server, OLD_PASSWORD)).status).toBe(401);
    const fresh = await signIn(server, NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect(await statusWith(server, cookieOf(fresh))).toBe(true);
  });

  it("a failing audit append rolls the reset back: credential, epoch and sessions stay, the old password still works", async () => {
    const instance = await ownerInstallation();
    let server = await serve(instance);
    const cookie = cookieOf(await signIn(server, OLD_PASSWORD));
    await stop(server);
    const before = state(instance);
    const writer = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "writer", busyTimeoutMs: 5000 });
    writer.handle.exec(`CREATE TRIGGER fail_reset_audit BEFORE INSERT ON audit_log WHEN new.action = 'owner.password_reset' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    writer.close();

    const run = await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }));
    expect(run.code).toBe(1);
    expect(failure(run)).toMatchObject({ code: "COMMAND_FAILED", fields: [] });
    expect(run.output).not.toContain(NEW_PASSWORD);
    expect(run.output).not.toContain("audit unavailable");
    expect(state(instance)).toEqual(before);

    server = await serve(instance);
    expect(await statusWith(server, cookie)).toBe(true);
    expect((await signIn(server, OLD_PASSWORD)).status).toBe(200);
  });

  const invalid: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["a password of 11 characters", JSON.stringify({ password: "elevenchars" }), ["password"]],
    ["a password of 129 emoji", JSON.stringify({ password: "🔐".repeat(129) }), ["password"]],
    ["an e-mail in the input", JSON.stringify({ email: EMAIL, password: NEW_PASSWORD }), ["input"]],
    ["input that is not JSON", "a new passphrase", ["input"]],
  ];
  for (const [name, stdin, fields] of invalid) {
    it(`refuses ${name} with INPUT_INVALID and changes nothing`, async () => {
      const instance = await ownerInstallation();
      const before = state(instance);
      const run = await cli(RESET_PASSWORD, instance, stdin);
      expect(run.code).toBe(1);
      expect(failure(run)).toEqual({ event: "reset-password.failed", code: "INPUT_INVALID", fields });
      expect(state(instance)).toEqual(before);
    });
  }

  it("arguments carry no password: an extra argument is a usage error", async () => {
    const instance = await ownerInstallation();
    const run = await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }), ["--password", "hunter2hunter2"]);
    expect(run.code).toBe(1);
    expect(failure(run)).toMatchObject({ code: "USAGE" });
    expect(run.output).not.toContain("hunter2hunter2");
  });

  it("an installation without an owner refuses with OWNER_NOT_FOUND", async () => {
    const instance = await startedInstallation();
    const run = await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }));
    expect(run.code).toBe(1);
    expect(failure(run)).toEqual({ event: "reset-password.failed", code: "OWNER_NOT_FOUND", fields: [] });
    expect(query(instance, "SELECT * FROM audit_log")).toEqual([]);
  });

  it("the new password is in no file of the installation, only its hash", async () => {
    const instance = await ownerInstallation();
    expect((await cli(RESET_PASSWORD, instance, JSON.stringify({ password: NEW_PASSWORD }))).code).toBe(0);
    const reader = openDatabase(path.join(instance.dir, "data", "app.db"), { role: "reader", busyTimeoutMs: 5000 });
    reader.close();
    for (const file of ["data/app.db", "data/app.db-wal", "control/maintenance/state.json", "control/instance.json"]) {
      let bytes: Buffer | undefined;
      try {
        bytes = readFileSync(path.join(instance.dir, file));
      } catch {
        continue;
      }
      expect(bytes.toString("utf8")).not.toContain(NEW_PASSWORD);
      expect(bytes.toString("utf8")).not.toContain("brand new passphrase");
    }
  });
});
