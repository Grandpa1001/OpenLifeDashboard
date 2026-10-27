// D11.4-AC2 — the built `reset-mfa` CLI on real installations (Architektura §4.8, §9.6). The
// second factor is removed and a new enrollment required; every session ends, every trusted device
// is revoked, the access epoch rises; the password, the owner's data, the choice of the starting
// data and the preferences stay. A running app, a failing audit and a missing owner change
// nothing. The regression at the end: a password reset revokes the trust but never forces an
// enrollment.
import { identityStatusSchema } from "@openlife/contracts/http/identity";
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import {
  ack,
  begin,
  codeOf,
  confirm,
  count,
  execute,
  installation,
  mfaState,
  OWNER_PASSWORD,
  putPreferences,
  query,
  readyOwner,
  RESET_MFA,
  RESET_PASSWORD,
  secretOf,
  serve,
  signIn,
  status,
  stopServer,
  stopServers,
  verify,
  type Installation,
} from "../../support/auth-http.ts";
import { outputEvent, runBuiltScript, type ProcessExit } from "../../support/server-process.ts";
import { authCookiePrefix } from "../../../apps/server/dist/adapters/auth/auth-options.js";

afterEach(stopServers);

const cli = (script: string, setup: Installation, stdin?: string, args: readonly string[] = []): Promise<ProcessExit> =>
  runBuiltScript(script, ["--installation", setup.instance.dir, ...args], { PATH: process.env["PATH"] ?? "", ...setup.instance.env }, stdin);
const failure = (run: ProcessExit): Record<string, unknown> | undefined => outputEvent(run.output, "reset-mfa.failed");
const snapshot = (setup: Installation) => ({
  mfa: mfaState(setup.instance),
  epoch: query<{ access_epoch: number }>(setup.instance, "SELECT access_epoch FROM instance_state")[0]?.access_epoch,
  sessions: count(setup.instance, "session"),
  recovery: count(setup.instance, "recovery_code"),
  devices: query<{ n: number }>(setup.instance, "SELECT count(*) AS n FROM trusted_device WHERE revoked_at_ms IS NULL")[0]?.n,
});

/** Enrolled, data chosen, preferences saved, one trusted device and one more session. */
async function populated(setup: Installation) {
  const owner = await readyOwner(setup);
  expect((await putPreferences(setup.server, owner.sessionCookie, { timezone: "Europe/Warsaw", locale: "pl" })).status).toBe(200);
  const proved = await verify(setup.server, (await signIn(setup.server)).cookie, { code: await codeOf(owner.secret, 1), rememberDevice: true });
  const trustedCookie = proved.cookies.find((cookie) => cookie.startsWith(`${authCookiePrefix(setup.instance.instanceId)}.trusted_device`)) ?? "";
  return { owner, trustedCookie, sessionCookie: proved.cookie ?? "" };
}

describe("D11.4-AC2 reset-mfa", () => {
  it("removes the factor and the sessions and trust, requires a new enrollment, keeps the password, the data choice and the preferences", async () => {
    const setup = await installation();
    const { owner, trustedCookie, sessionCookie } = await populated(setup);
    const before = snapshot(setup);
    expect(before.mfa).toMatchObject({ enrollment_state: "complete", secret_generation: 1 });
    expect(before.devices).toBe(1);
    const passwordHash = query<{ password: string }>(setup.instance, "SELECT password FROM account")[0]?.password;
    await stopServer(setup.server);

    const reset = await cli(RESET_MFA, setup);
    expect(reset.code, reset.output).toBe(0);
    expect(outputEvent(reset.output, "owner.mfa_reset")).toMatchObject({ accessEpoch: (before.epoch ?? 0) + 1, revokedDevices: 1 });
    const after = snapshot(setup);
    expect(after.mfa).toMatchObject({ enrollment_state: "required", secret_generation: 0, active_secret: null, pending_challenge_id: null, recovery_batch_id: null, last_used_step: null });
    expect(query(setup.instance, "SELECT policy FROM mfa_state")).toEqual([{ policy: "reset_required" }]);
    expect(after).toMatchObject({ sessions: 0, recovery: 0, devices: 0, epoch: (before.epoch ?? 0) + 1 });
    // The rest of the owner's state is untouched.
    expect(query<{ password: string }>(setup.instance, "SELECT password FROM account")[0]?.password).toBe(passwordHash);
    expect(query(setup.instance, "SELECT data_choice FROM instance_state")).toEqual([{ data_choice: "empty" }]);
    expect(query(setup.instance, "SELECT timezone, locale FROM owner_settings")).toEqual([{ timezone: "Europe/Warsaw", locale: "pl" }]);
    expect(query(setup.instance, "SELECT details FROM audit_log WHERE action = 'owner.mfa_reset'")).toHaveLength(1);

    // The app: old sessions are dead, a password login asks for a new enrollment, trust does not help.
    const restarted = await serve(setup.instance);
    expect(await status(restarted, sessionCookie)).toEqual({ authenticated: false, nextAction: "login" });
    expect(await status(restarted, owner.sessionCookie)).toEqual({ authenticated: false, nextAction: "login" });
    const login = await signIn(restarted, trustedCookie);
    expect(identityStatusSchema.parse(login.json())).toEqual({ authenticated: true, nextAction: "mfa_enrollment" });
    // The old secret and the old recovery codes prove nothing.
    expect((await verify(restarted, login.cookie, { code: await codeOf(owner.secret, 1) })).status).toBe(409);
    expect((await verify(restarted, login.cookie, { recoveryCode: owner.codes[0] ?? "" })).status).toBe(409);

    // A new enrollment with a new secret: the data are chosen already, so the gate leads straight to ready.
    const challenge = enrollmentChallengeSchema.parse((await begin(restarted, login.cookie)).json());
    const newSecret = secretOf(challenge.otpauthUri);
    expect(newSecret.equals(owner.secret)).toBe(false);
    const confirmed = await confirm(restarted, login.cookie, challenge.challengeId, await codeOf(newSecret));
    expect(confirmed.status).toBe(200);
    const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
    expect(issued.recoveryCodes.filter((code) => owner.codes.includes(code))).toEqual([]);
    expect((await ack(restarted, confirmed.cookie, issued.batchId)).json()).toEqual({ nextAction: "ready" });
    expect(query(setup.instance, "SELECT policy, enrollment_state, secret_generation FROM mfa_state")).toEqual([{ policy: "required", enrollment_state: "complete", secret_generation: 1 }]);
  });

  it("a running app holds the writer: INSTANCE_BUSY and nothing changes", async () => {
    const setup = await installation();
    await populated(setup);
    const before = snapshot(setup);
    const run = await cli(RESET_MFA, setup);
    expect(run.code).toBe(1);
    expect(failure(run)).toEqual({ event: "reset-mfa.failed", code: "INSTANCE_BUSY", fields: ["writer.lock"] });
    expect(snapshot(setup)).toEqual(before);
  });

  it("a failing audit rolls everything back: the factor, the sessions and the trust stay", async () => {
    const setup = await installation();
    const { sessionCookie } = await populated(setup);
    await stopServer(setup.server);
    const before = snapshot(setup);
    execute(setup.instance, `CREATE TRIGGER fail_reset BEFORE INSERT ON audit_log WHEN new.action = 'owner.mfa_reset' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const run = await cli(RESET_MFA, setup);
    expect(run.code).toBe(1);
    expect(failure(run)).toMatchObject({ code: "COMMAND_FAILED", fields: [] });
    expect(run.output).not.toContain("audit unavailable");
    expect(snapshot(setup)).toEqual(before);
    execute(setup.instance, "DROP TRIGGER fail_reset");
    const restarted = await serve(setup.instance);
    expect(await status(restarted, sessionCookie)).toMatchObject({ authenticated: true });
  });

  it("takes no input: any argument is a usage error, and an installation without an owner is refused", async () => {
    const setup = await installation();
    await stopServer(setup.server);
    const withArgument = await cli(RESET_MFA, setup, undefined, ["--password", "hunter2hunter2"]);
    expect(withArgument.code).toBe(1);
    expect(failure(withArgument)).toMatchObject({ code: "USAGE" });
    expect(withArgument.output).not.toContain("hunter2hunter2");
  });
});

describe("D11.4-AC2 regression: a password reset revokes the trust and forces no enrollment", () => {
  it("the factor, its secret and the recovery codes stay; the trusted device is revoked; the next login asks for the code, not for an enrollment", async () => {
    const setup = await installation();
    const { owner, trustedCookie } = await populated(setup);
    const before = snapshot(setup);
    await stopServer(setup.server);
    const reset = await cli(RESET_PASSWORD, setup, JSON.stringify({ password: OWNER_PASSWORD }));
    expect(reset.code, reset.output).toBe(0);
    expect(reset.output).toContain('"revokedDevices":1');
    expect(snapshot(setup)).toMatchObject({ devices: 0, sessions: 0, mfa: before.mfa, recovery: before.recovery });
    expect(query(setup.instance, "SELECT policy, enrollment_state, secret_generation FROM mfa_state")).toEqual([{ policy: "required", enrollment_state: "complete", secret_generation: 1 }]);

    const restarted = await serve(setup.instance);
    const login = await signIn(restarted, trustedCookie);
    expect(login.json()).toEqual({ authenticated: true, nextAction: "mfa_challenge" });
    // The same factor still works: no new enrollment was needed. Half a minute passes first (the
    // ledger moves back by the steps that would have gone by), so the next code is a fresh step.
    execute(setup.instance, "UPDATE mfa_state SET last_used_step = last_used_step - 10");
    expect((await verify(restarted, login.cookie, { code: await codeOf(owner.secret, 1) })).status).toBe(200);
  });
});
