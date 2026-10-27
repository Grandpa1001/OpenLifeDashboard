// D13.2 — what a request decides at the moment it commits, not at the moment it started. The real
// HTTP application runs in the test process (tests/support/app-harness.ts); the harness stops a
// request after its middleware and before its unit of work, lets something else happen, and
// resumes it. Nothing in production code knows about the stop.
// AC1: a request whose session was ended, or whose access epoch moved, in that gap refuses to write
//      and changes nothing; an earlier snapshot or epoch is no authority for a mutation.
// AC2: a failing audit entry rolls back the critical change and the promotion that goes with it, the
//      answer is 503 with no cookie, and neither the audit nor the technical log holds a secret or
//      the body of a request.
import { enrollmentChallengeSchema, issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, secretOf } from "../../support/auth-http.ts";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD, type AppHarness } from "../../support/app-harness.ts";

afterEach(closeHarnesses);

const PREFERENCES = { timezone: "Europe/Warsaw", locale: "pl" } as const;

const signIn = (h: AppHarness) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD });

/** Enrolled, with the batch of codes in hand; the stage is the acknowledgment. */
async function enrolled(h: AppHarness) {
  const password = (await signIn(h)).cookie ?? "";
  const challenge = enrollmentChallengeSchema.parse((await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json());
  const secret = secretOf(challenge.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: challenge.challengeId, code: await codeOf(secret) }, { cookie: password });
  expect(confirmed.status).toBe(200);
  return { cookie: confirmed.cookie ?? "", secret, challenge, codes: issuedRecoveryCodesSchema.parse(confirmed.json()), password };
}

/** Acknowledged; the data not chosen yet. */
async function gated(h: AppHarness) {
  const owner = await enrolled(h);
  expect((await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId }, { cookie: owner.cookie })).status).toBe(200);
  return owner;
}

/** The empty start chosen; the preferences are the only thing left. */
async function ready(h: AppHarness) {
  const owner = await gated(h);
  expect((await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: owner.cookie })).status).toBe(200);
  return owner;
}

/** Session tokens in the order the sessions were made. */
const sessionToken = (h: AppHarness): readonly string[] => h.rows<{ token: string }>(`SELECT token FROM "session" ORDER BY rowid`).map((row) => row.token);
const endSessionsExcept = (h: AppHarness, keep: number): void => void h.sql(`DELETE FROM "session" WHERE rowid NOT IN (SELECT rowid FROM "session" ORDER BY rowid LIMIT ${keep})`);
const endAllSessions = (h: AppHarness): void => void h.sql(`DELETE FROM "session"`);
const moveEpoch = (h: AppHarness): void => void h.sql("UPDATE instance_state SET access_epoch = access_epoch + 1");

const dataChoice = (h: AppHarness) => h.rows<{ data_choice: string }>("SELECT data_choice FROM instance_state")[0]?.data_choice;
const settings = (h: AppHarness) => h.rows("SELECT * FROM owner_settings").length;
const mfa = (h: AppHarness) => h.rows<{ last_used_step: number | null; active_secret: string | null; pending_challenge_id: string | null; secret_generation: number }>("SELECT last_used_step, active_secret, pending_challenge_id, secret_generation FROM mfa_state")[0];
const audits = (h: AppHarness, action: string): number => h.rows(`SELECT 1 FROM audit_log WHERE action = '${action}'`).length;
const errorCode = (reply: { json: () => unknown }): string => (reply.json() as { code: string }).code;

describe("D13.2-AC1 a request is decided where it commits", () => {
  it("the positive control: with nothing in the gap the very same write is accepted", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    expect((await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie })).status).toBe(200);
    expect(settings(h)).toBe(1);
  });

  it("F09 logout-before-protected-commit: a sign-out of the same session between the middleware and the commit: 401, the preferences are not written", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    h.interruptNextWrite(() => endAllSessions(h));
    const reply = await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie });
    expect([reply.status, errorCode(reply)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(settings(h)).toBe(0);
    expect(audits(h, "settings.preferences_saved")).toBe(0);
  });

  it("the same through the real sign-out route: the request that left before it cannot write after it", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    h.interruptNextWrite(() => void h.elsewhere.run((ports) => ({ value: ports.sessions.deleteByToken(sessionToken(h)[0] ?? ""), invalidations: [] })));
    const reply = await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie });
    expect(reply.status).toBe(401);
    expect(settings(h)).toBe(0);
  });

  it("an access epoch that moved in the gap is no longer authority: the write is refused, a session of the new epoch is not needed to be told", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    h.interruptNextWrite(() => moveEpoch(h));
    const reply = await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie });
    expect([reply.status, errorCode(reply)]).toEqual([401, "AUTH_REQUIRED"]);
    expect(settings(h)).toBe(0);
    // And it stays so: the old session does not come back with the next request.
    expect((await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie })).status).toBe(401);
  });

  it("the choice of the starting data and the acknowledgment obey the same rule", async () => {
    const h = await createAppHarness();
    const owner = await enrolled(h);
    h.interruptNextWrite(() => endAllSessions(h));
    const acked = await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId }, { cookie: owner.cookie });
    expect(acked.status).toBe(401);
    expect(audits(h, "mfa.recovery_acknowledged")).toBe(0);

    const second = await createAppHarness();
    const gate = await gated(second);
    second.interruptNextWrite(() => endAllSessions(second));
    const chosen = await second.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: gate.cookie });
    expect(chosen.status).toBe(401);
    expect(dataChoice(second)).toBe("unselected");
    expect(audits(second, "setup.data_chosen")).toBe(0);
  });

  it("a promotion whose session ends after the code was checked does not consume the step or issue a cookie", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    const stepBefore = mfa(h)?.last_used_step;
    // A password session of the owner asks to be promoted with a valid code; the session ends in the gap.
    const password = (await signIn(h)).cookie ?? "";
    const askingToken = h.rows<{ token: string }>(`SELECT token FROM "session" ORDER BY rowid DESC LIMIT 1`)[0]?.token ?? "";
    h.interruptNextWrite(() => h.sql(`DELETE FROM "session" WHERE token = '${askingToken}'`));
    const code = await codeOf(owner.secret, 1);
    const reply = await h.request("POST", "/api/v1/mfa/verify", { code }, { cookie: password });
    expect(reply.status).toBe(401);
    expect(reply.setCookies).toEqual([]);
    expect(mfa(h)?.last_used_step).toBe(stepBefore);
    // The code was not spent: a new session can still use it.
    const fresh = (await signIn(h)).cookie ?? "";
    expect((await h.request("POST", "/api/v1/mfa/verify", { code }, { cookie: fresh })).status).toBe(200);
  });

  it("an enrollment whose session ends after the code was checked activates nothing", async () => {
    const h = await createAppHarness();
    const password = (await signIn(h)).cookie ?? "";
    const challenge = enrollmentChallengeSchema.parse((await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json());
    const secret = secretOf(challenge.otpauthUri);
    h.interruptNextWrite(() => endAllSessions(h));
    const reply = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: challenge.challengeId, code: await codeOf(secret) }, { cookie: password });
    expect(reply.status).toBe(401);
    expect(reply.setCookies).toEqual([]);
    expect(mfa(h)).toMatchObject({ active_secret: null, secret_generation: 0, last_used_step: null });
    expect(mfa(h)?.pending_challenge_id).toBe(challenge.challengeId);
  });

  it("the end of another session of the owner does not stop this write", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    await signIn(h); // a second session
    expect(sessionToken(h).length).toBeGreaterThan(1);
    h.interruptNextWrite(() => endSessionsExcept(h, 1)); // keeps the oldest: the owner's session
    expect((await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie })).status).toBe(200);
    expect(settings(h)).toBe(1);
  });
});

describe("D13.2-AC2 a failing audit takes the change back with it", () => {
  const failAudit = (h: AppHarness, action: string): void => h.sql(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log WHEN new.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit unavailable: secret-detail'); END;`);
  const heal = (h: AppHarness): void => h.sql("DROP TRIGGER fail_audit");

  it("enrollment: no activation, no promotion, no cookie; the same code works once the audit does", async () => {
    const h = await createAppHarness();
    const password = (await signIn(h)).cookie ?? "";
    const challenge = enrollmentChallengeSchema.parse((await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json());
    const secret = secretOf(challenge.otpauthUri);
    const code = await codeOf(secret);
    failAudit(h, "mfa.enrolled");
    const failed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: challenge.challengeId, code }, { cookie: password });
    expect([failed.status, errorCode(failed), failed.setCookies]).toEqual([503, "AUTH_UNAVAILABLE", []]);
    expect(failed.text).not.toContain("secret-detail");
    expect(mfa(h)).toMatchObject({ active_secret: null, last_used_step: null });
    expect(h.rows("SELECT 1 FROM recovery_code").length).toBe(0);
    heal(h);
    expect((await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: challenge.challengeId, code }, { cookie: password })).status).toBe(200);
  });

  it("reissue of the codes: the old batch stays the current one and the step is not spent", async () => {
    const h = await createAppHarness();
    const owner = await enrolled(h);
    const batches = h.rows("SELECT * FROM recovery_code");
    const stepBefore = mfa(h)?.last_used_step;
    failAudit(h, "mfa.recovery_reissued");
    const code = await codeOf(owner.secret, 1);
    const failed = await h.request("POST", "/api/v1/mfa/enrollment/recovery/reissue", { code }, { cookie: owner.cookie });
    expect([failed.status, failed.setCookies]).toEqual([503, []]);
    expect(h.rows("SELECT * FROM recovery_code")).toEqual(batches);
    expect(mfa(h)?.last_used_step).toBe(stepBefore);
    heal(h);
    expect((await h.request("POST", "/api/v1/mfa/enrollment/recovery/reissue", { code }, { cookie: owner.cookie })).status).toBe(200);
  });

  it("acknowledgment, the choice of data and the preferences: refused with 503, unchanged, and repeatable", async () => {
    const h = await createAppHarness();
    const owner = await enrolled(h);
    failAudit(h, "mfa.recovery_acknowledged");
    expect((await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId }, { cookie: owner.cookie })).status).toBe(503);
    expect(h.rows<{ enrollment_state: string }>("SELECT enrollment_state FROM mfa_state")[0]?.enrollment_state).toBe("awaiting_recovery_ack");
    heal(h);
    expect((await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId }, { cookie: owner.cookie })).status).toBe(200);

    failAudit(h, "setup.data_chosen");
    expect((await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: owner.cookie })).status).toBe(503);
    expect(dataChoice(h)).toBe("unselected");
    heal(h);
    expect((await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: owner.cookie })).status).toBe(200);

    failAudit(h, "settings.preferences_saved");
    expect((await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie })).status).toBe(503);
    expect(settings(h)).toBe(0);
    heal(h);
    expect((await h.request("PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: owner.cookie })).status).toBe(200);
  });

  it("the second factor at sign-in: no promotion, no cookie, the step unspent", async () => {
    const h = await createAppHarness();
    const owner = await ready(h);
    const password = (await signIn(h)).cookie ?? "";
    const code = await codeOf(owner.secret, 1);
    failAudit(h, "mfa.verified");
    const failed = await h.request("POST", "/api/v1/mfa/verify", { code }, { cookie: password });
    expect([failed.status, failed.setCookies]).toEqual([503, []]);
    expect(h.rows<{ assurance: string }>(`SELECT assurance FROM session_ext WHERE session_id = (SELECT id FROM "session" WHERE token = '${sessionToken(h).at(-1) ?? ""}')`)[0]?.assurance).toBe("password");
    heal(h);
    expect((await h.request("POST", "/api/v1/mfa/verify", { code }, { cookie: password })).status).toBe(200);
  });

  it("neither the audit nor the technical log holds a password, a code, a secret, a token or the body of a request", async () => {
    const h = await createAppHarness();
    const marker = "arbitrary-body-marker-7f3a";
    const owner = await enrolled(h);
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId, note: marker }, { cookie: owner.cookie });
    await h.request("PUT", "/api/v1/setup/preferences", { ...PREFERENCES, note: marker }, { cookie: owner.cookie });
    await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: marker });
    await h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD, note: marker });
    failAudit(h, "setup.data_chosen");
    await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: owner.codes.batchId }, { cookie: owner.cookie });
    await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: owner.cookie });
    heal(h);

    const forbidden = [marker, HARNESS_PASSWORD, "secret-detail", owner.secret.toString("hex"), owner.secret.toString("base64"), owner.challenge.manualKey.replaceAll(" ", ""), owner.challenge.otpauthUri, owner.cookie.split("=")[1] ?? "", owner.password.split("=")[1] ?? "", ...owner.codes.recoveryCodes];
    const audit = JSON.stringify(h.rows("SELECT * FROM audit_log"));
    const log = h.logLines().join("\n");
    expect(audit.length).toBeGreaterThan(100);
    expect(log.length).toBeGreaterThan(100);
    for (const secret of forbidden) {
      expect(audit, `audit holds ${secret.slice(0, 6)}…`).not.toContain(secret);
      expect(log, `log holds ${secret.slice(0, 6)}…`).not.toContain(secret);
    }
    // The failure is logged by its stable code and the class of the error, never by its message.
    expect(log).toContain("mfa.unavailable");
    expect(log).toContain("SQLITE_CONSTRAINT_TRIGGER");
  });
});
