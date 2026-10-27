// D11.3 — the lockout of the second factor over real HTTP: statuses, Retry-After, a spoofed
// X-Forwarded-For, a restart, a burst and an audit outage, on the built server and a real
// database. The boundaries of the 15 minutes are in mfa-lockout.test.ts with a controlled clock;
// here the passing of time is an arrangement in SQL, labeled as such.
// AC1: [401, 401, 401, 401, 429]; the lock holds for the right code, for another session, after a
//      restart; after the deadline the right code works (F09 password-lockout-survives-restart
//      has its own password counterpart in sign-in-http.test.ts).
// AC2: the refusal is persisted; an audit outage refuses without a counter; a burst counts five.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { authLockedDetailsSchema } from "@openlife/contracts/http/identity";
import { enrollmentChallengeSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import {
  begin,
  codeOf,
  confirm,
  execute,
  installation,
  query,
  readyOwner,
  secretOf,
  serve,
  signIn,
  status,
  stepUp,
  stopServer,
  stopServers,
  verify,
  type Installation,
} from "../../support/auth-http.ts";

afterEach(stopServers);

const mfaBuckets = (setup: Installation) =>
  query<{ bucket_key: string; failures: number; locked_until_ms: number | null }>(setup.instance, "SELECT bucket_key, failures, locked_until_ms FROM auth_lockout WHERE bucket_key LIKE 'mfa:%' ORDER BY bucket_key");
const failedAudits = (setup: Installation): number => query(setup.instance, "SELECT 1 FROM audit_log WHERE action = 'mfa.failed'").length;
const spoofed = (index: number) => ({ "X-Forwarded-For": `198.51.100.${index}` });

/** A wrong code from a client that claims another address each time. */
async function wrongCode(setup: Installation, cookie: string | null, index: number) {
  const response = await fetch(`${setup.server.baseUrl}/api/v1/mfa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:8080", ...(cookie ? { Cookie: cookie } : {}), ...spoofed(index) },
    body: JSON.stringify({ code: "000000" }),
  });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: (await response.json()) as unknown };
}

describe("D11.3-AC1 a persistent lock of fifteen minutes", () => {
  it("five wrong codes answer 401, 401, 401, 401, 429 with Retry-After; the lock holds for the right code, a recovery code, a step-up and another session, and across a restart", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);

    const answers = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) answers.push(await wrongCode(setup, login.cookie, attempt));
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401, 429]);
    const locked = apiErrorSchema.parse(answers[4]?.body);
    expect(locked.code).toBe("AUTH_LOCKED");
    const retryAfter = Number(answers[4]?.retryAfter);
    expect(retryAfter).toBeGreaterThan(890);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(authLockedDetailsSchema.parse(locked.details).retryAfterSeconds).toBe(retryAfter);
    // The same DTO for the wrong ones: no hint of which attempt counted.
    expect(apiErrorSchema.parse(answers[0]?.body).code).toBe("MFA_INVALID_CODE");

    const locks = mfaBuckets(setup);
    expect(locks.map((bucket) => [bucket.failures, bucket.locked_until_ms !== null])).toEqual([
      [5, true],
      [5, true],
    ]);
    expect(failedAudits(setup)).toBe(5);

    // While locked: the right TOTP, a recovery code and a step-up from the same session, and any other session.
    const other = await signIn(setup.server);
    for (const reply of [
      await verify(setup.server, login.cookie, { code: await codeOf(owner.secret, 1) }),
      await verify(setup.server, login.cookie, { recoveryCode: owner.codes[0] ?? "" }),
      await stepUp(setup.server, login.cookie, await codeOf(owner.secret, 1)),
      await verify(setup.server, other.cookie, { code: await codeOf(owner.secret, 1) }),
    ]) {
      expect(reply.status).toBe(429);
      expect(reply.cookies).toEqual([]);
    }
    expect(mfaBuckets(setup)).toEqual(locks);
    expect(failedAudits(setup)).toBe(5);
    expect(query(setup.instance, "SELECT count(*) AS n FROM recovery_code WHERE used_at_ms IS NULL")).toEqual([{ n: 10 }]);
    // The password has its own buckets: signing in still works while the factor is locked.
    expect((await signIn(setup.server)).status).toBe(200);

    await stopServer(setup.server);
    const restarted = await serve(setup.instance);
    const after = await verify(restarted, other.cookie, { code: await codeOf(owner.secret, 1) });
    expect(after.status).toBe(429);
    expect(apiErrorSchema.parse(after.json()).code).toBe("AUTH_LOCKED");
    expect(mfaBuckets(setup)).toEqual(locks);

    // Time passes (arranged): after lockedUntil the right code opens the data again.
    execute(setup.instance, "UPDATE auth_lockout SET locked_until_ms = 1 WHERE bucket_key LIKE 'mfa:%'");
    const opened = await verify(restarted, other.cookie, { code: await codeOf(owner.secret, 1) });
    expect(opened.status).toBe(200);
    expect(await status(restarted, opened.cookie)).toEqual({ authenticated: true, nextAction: "ready" });
  });

  it("an enrollment confirmation is counted and locked in the same way, and the challenge survives the lock", async () => {
    const setup = await installation();
    const login = await signIn(setup.server);
    const challenge = enrollmentChallengeSchema.parse((await begin(setup.server, login.cookie)).json());
    const statuses = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) statuses.push((await confirm(setup.server, login.cookie, challenge.challengeId, "000000")).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
    const right = await codeOf(secretOf(challenge.otpauthUri));
    const blocked = await confirm(setup.server, login.cookie, challenge.challengeId, right);
    expect(blocked.status).toBe(429);
    expect(query(setup.instance, "SELECT pending_challenge_id AS id FROM mfa_state")).toEqual([{ id: challenge.challengeId }]);
    execute(setup.instance, "UPDATE auth_lockout SET locked_until_ms = 1 WHERE bucket_key LIKE 'mfa:%'");
    expect((await confirm(setup.server, login.cookie, challenge.challengeId, right)).status).toBe(200);
  });
});

describe("D11.3-AC2 persisted refusals, bursts and outages", () => {
  it("a burst of parallel wrong codes counts exactly five and locks once: four 401, the rest 429", async () => {
    const setup = await installation();
    await readyOwner(setup);
    const login = await signIn(setup.server);
    const replies = await Promise.all(Array.from({ length: 15 }, (_, index) => wrongCode(setup, login.cookie, index)));
    const statuses = replies.map((reply) => reply.status);
    expect(statuses.filter((code) => code === 401)).toHaveLength(4);
    expect(statuses.filter((code) => code === 429)).toHaveLength(11);
    const locks = mfaBuckets(setup);
    expect(locks.map((bucket) => bucket.failures)).toEqual([5, 5]);
    expect(new Set(locks.map((bucket) => bucket.locked_until_ms)).size).toBe(1);
    expect(failedAudits(setup)).toBe(5);
  });

  it("an audit outage refuses the wrong code with 503 and no counter; the right code then works as if nothing happened", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    const login = await signIn(setup.server);
    execute(setup.instance, `CREATE TRIGGER fail_failed BEFORE INSERT ON audit_log WHEN new.action = 'mfa.failed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await wrongCode(setup, login.cookie, 1);
    expect(failed.status).toBe(503);
    expect(apiErrorSchema.parse(failed.body).code).toBe("AUTH_UNAVAILABLE");
    expect(JSON.stringify(failed.body)).not.toContain("audit unavailable");
    expect(mfaBuckets(setup)).toEqual([]);
    execute(setup.instance, "DROP TRIGGER fail_failed");
    expect((await verify(setup.server, login.cookie, { code: await codeOf(owner.secret, 1) })).status).toBe(200);
  });

  it("a request with no session is not a factor attempt: nothing is counted for it", async () => {
    const setup = await installation();
    await readyOwner(setup);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect((await wrongCode(setup, null, attempt)).status).toBe(401);
    }
    expect(mfaBuckets(setup)).toEqual([]);
  });
});
