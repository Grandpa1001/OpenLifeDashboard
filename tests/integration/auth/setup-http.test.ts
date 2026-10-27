// D11.4 — the first setup over real HTTP: the stage, the choice of the starting data and the
// owner's preferences (Architektura §9.7, §18.7). Real server, real database, an owner made by the
// CLI, codes computed from the secret like an authenticator app.
// AC1: after the gate the choice of "start from zero" is atomic and idempotent, the preferences
//      are saved through the settings port and survive a restart; the whole F09
//      lost-recovery-view-requires-new-batch runs on these routes.
// AC2: the choice before the acknowledgment or before the factor is refused, the preferences
//      before the choice of data too; imported data are never replaced; a failing audit changes
//      nothing; a session ended before the write cannot write; no import exists.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { chooseEmptyResponseSchema, preferencesResponseSchema, setupStatusSchema } from "@openlife/contracts/http/setup";
import { issuedRecoveryCodesSchema, enrollmentChallengeSchema } from "@openlife/contracts/http/mfa";
import { afterEach, describe, expect, it } from "vitest";
import {
  ack,
  begin,
  chooseEmpty,
  codeOf,
  confirm,
  count,
  enrolled,
  execute,
  getPreferences,
  installation,
  mfaState,
  post,
  putPreferences,
  query,
  readyOwner,
  reissue,
  secretOf,
  send,
  serve,
  setupStatus,
  signIn,
  stopServer,
  stopServers,
  verify,
  type Installation,
} from "../../support/auth-http.ts";

afterEach(stopServers);

const PREFERENCES = { timezone: "Europe/Warsaw", locale: "pl" } as const;
const dataChoice = (setup: Installation): string | undefined => query<{ data_choice: string }>(setup.instance, "SELECT data_choice FROM instance_state")[0]?.data_choice;
const audits = (setup: Installation, action: string): number => query(setup.instance, `SELECT 1 FROM audit_log WHERE action = '${action}'`).length;
const codeOf_ = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;

/** The gate passed: enrolled, acknowledged; the data not yet chosen. */
async function gated(setup: Installation) {
  const first = await enrolled(setup);
  const codes = first.codes;
  if (codes === null) throw new Error("no codes issued");
  expect((await ack(setup.server, first.confirmed.cookie, codes.batchId)).status).toBe(200);
  return { cookie: first.confirmed.cookie ?? "", secret: first.secret, batchId: codes.batchId };
}

describe("D11.4-AC1 the stage, the choice of data and the preferences", () => {
  it("F09 lost-recovery-view-requires-new-batch: the whole flow on the real routes", async () => {
    const setup = await installation();
    const { server, instance } = setup;
    const login = await signIn(server);
    const challenge = enrollmentChallengeSchema.parse((await begin(server, login.cookie)).json());
    const secret = secretOf(challenge.otpauthUri);
    const confirmed = await confirm(server, login.cookie, challenge.challengeId, await codeOf(secret));
    expect(confirmed.status).toBe(200);
    const oldBatch = issuedRecoveryCodesSchema.parse(confirmed.json());
    const activeSecret = mfaState(instance)?.active_secret;
    // The plain codes are discarded here: the owner lost the view. The private settings stay closed.
    const closed = await getPreferences(server, confirmed.cookie);
    expect(closed.status).toBe(403);
    expect(codeOf_(closed)).toBe("RECOVERY_ACK_REQUIRED");
    // A fresh TOTP (the next step) issues a new batch for the session that is shown it.
    const reissued = await reissue(server, confirmed.cookie, await codeOf(secret, 1));
    expect(reissued.status).toBe(200);
    const current = issuedRecoveryCodesSchema.parse(reissued.json());
    const lateAck = await ack(server, reissued.cookie, oldBatch.batchId);
    expect(lateAck.status).toBe(409);
    expect(codeOf_(lateAck)).toBe("RECOVERY_BATCH_CHANGED");
    expect((await ack(server, reissued.cookie, current.batchId)).status).toBe(200);
    const chosen = await chooseEmpty(server, reissued.cookie);
    expect(chosen.status).toBe(200);
    expect(chooseEmptyResponseSchema.parse(chosen.json())).toEqual({ dataChoice: "empty", stage: "preferences" });
    expect(mfaState(instance)?.active_secret).toBe(activeSecret);
    expect(mfaState(instance)?.secret_generation).toBe(1);
  });

  it("the stage follows the setup: data, preferences, complete; the choice is idempotent and audited once; the preferences are saved and kept over a restart", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    const { server } = setup;
    expect(setupStatusSchema.parse((await setupStatus(server, gate.cookie)).json())).toEqual({ stage: "data", dataChoice: "unselected", nextAction: "setup_data" });

    const first = await chooseEmpty(server, gate.cookie);
    expect(first.status).toBe(200);
    const again = await chooseEmpty(server, gate.cookie);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(audits(setup, "setup.data_chosen")).toBe(1);
    expect(dataChoice(setup)).toBe("empty");
    expect(setupStatusSchema.parse((await setupStatus(server, gate.cookie)).json())).toEqual({ stage: "preferences", dataChoice: "empty", nextAction: "ready" });

    const empty = await getPreferences(server, gate.cookie);
    expect(preferencesResponseSchema.parse(empty.json())).toEqual({ preferences: null, stage: "preferences" });
    const saved = await putPreferences(server, gate.cookie, PREFERENCES);
    expect(saved.status).toBe(200);
    expect(preferencesResponseSchema.parse(saved.json())).toEqual({ preferences: PREFERENCES, stage: "complete" });
    expect(query(setup.instance, "SELECT timezone, locale, date_format FROM owner_settings")).toEqual([{ timezone: "Europe/Warsaw", locale: "pl", date_format: "DD.MM.YYYY" }]);

    await stopServer(server);
    const restarted = await serve(setup.instance);
    // The same session, the same answers: nothing was held in memory.
    expect(preferencesResponseSchema.parse((await getPreferences(restarted, gate.cookie)).json())).toEqual({ preferences: PREFERENCES, stage: "complete" });
    expect(setupStatusSchema.parse((await setupStatus(restarted, gate.cookie)).json()).stage).toBe("complete");
    // A change replaces the row, it does not add one.
    expect((await putPreferences(restarted, gate.cookie, { timezone: "America/New_York", locale: "en" })).status).toBe(200);
    expect(query(setup.instance, "SELECT timezone, locale FROM owner_settings")).toEqual([{ timezone: "America/New_York", locale: "en" }]);
    expect(audits(setup, "settings.preferences_saved")).toBe(2);
  });

  it("two choices at once both succeed and decide once", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    const replies = await Promise.all([chooseEmpty(setup.server, gate.cookie), chooseEmpty(setup.server, gate.cookie), chooseEmpty(setup.server, gate.cookie)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
    expect(audits(setup, "setup.data_chosen")).toBe(1);
    expect(dataChoice(setup)).toBe("empty");
  });

  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown time zone", { timezone: "Mars/Olympus", locale: "pl" }],
    ["an unsupported language", { timezone: "Europe/Warsaw", locale: "de" }],
    ["a missing field", { timezone: "Europe/Warsaw" }],
    ["a field that is not a preference", { timezone: "Europe/Warsaw", locale: "pl", dateFormat: "YYYY-MM-DD", ownerId: "x" }],
    ["a body that is not JSON", "timezone=Europe/Warsaw"],
  ];
  for (const [name, body] of invalid) {
    it(`${name} is 422 and saves nothing`, async () => {
      const setup = await installation();
      const owner = await readyOwner(setup);
      expect((await putPreferences(setup.server, owner.sessionCookie, body)).status).toBe(422);
      expect(count(setup.instance, "owner_settings")).toBe(0);
    });
  }
});

describe("D11.4-AC2 the gate, imported data, outages and revocation", () => {
  it("the choice is refused before the acknowledgment and before the factor; the data stay unselected", async () => {
    const setup = await installation();
    const first = await enrolled(setup);
    // Codes issued, not acknowledged.
    const early = await chooseEmpty(setup.server, first.confirmed.cookie);
    expect(early.status).toBe(403);
    expect(codeOf_(early)).toBe("RECOVERY_ACK_REQUIRED");
    // An enrolled owner with only a password session: the factor first.
    await ack(setup.server, first.confirmed.cookie, first.codes?.batchId ?? "");
    const password = await signIn(setup.server);
    const noFactor = await chooseEmpty(setup.server, password.cookie);
    expect(noFactor.status).toBe(403);
    expect(codeOf_(noFactor)).toBe("MFA_REQUIRED");
    expect(dataChoice(setup)).toBe("unselected");
    expect(audits(setup, "setup.data_chosen")).toBe(0);
  });

  it("the preferences are closed until the data are chosen, for reading and for writing", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    for (const reply of [await getPreferences(setup.server, gate.cookie), await putPreferences(setup.server, gate.cookie, PREFERENCES)]) {
      expect(reply.status).toBe(403);
      expect(codeOf_(reply)).toBe("SETUP_DATA_REQUIRED");
    }
    expect(count(setup.instance, "owner_settings")).toBe(0);
    // The status is still readable: the wizard needs the stage.
    expect(setupStatusSchema.parse((await setupStatus(setup.server, gate.cookie)).json()).stage).toBe("data");
  });

  it("imported data are never replaced by empty: 409 SETUP_DATA_ALREADY_CHOSEN and the choice stays", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    // Standing for the import of D46, which shares this state.
    execute(setup.instance, "UPDATE instance_state SET data_choice = 'imported'");
    const refused = await chooseEmpty(setup.server, gate.cookie);
    expect(refused.status).toBe(409);
    expect(codeOf_(refused)).toBe("SETUP_DATA_ALREADY_CHOSEN");
    expect(dataChoice(setup)).toBe("imported");
    expect(setupStatusSchema.parse((await setupStatus(setup.server, gate.cookie)).json())).toMatchObject({ dataChoice: "imported", stage: "preferences" });
  });

  it("no session, a forged cookie and a foreign Origin are refused before anything is read or written", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    for (const cookie of [null, `${gate.cookie}x`]) {
      expect((await setupStatus(setup.server, cookie)).status).toBe(401);
      expect((await getPreferences(setup.server, cookie)).status).toBe(401);
      expect((await chooseEmpty(setup.server, cookie)).status).toBe(401);
      expect((await putPreferences(setup.server, cookie, PREFERENCES)).status).toBe(401);
    }
    for (const origin of [null, "https://evil.example", "http://localhost:3000"]) {
      expect((await post(setup.server, "/api/v1/setup/choose-empty", {}, { cookie: gate.cookie, origin })).status).toBe(403);
      expect((await send(setup.server, "PUT", "/api/v1/setup/preferences", PREFERENCES, { cookie: gate.cookie, origin })).status).toBe(403);
    }
    expect(dataChoice(setup)).toBe("unselected");
    // Reading is a safe method: a foreign Origin does not matter.
    expect((await send(setup.server, "GET", "/api/v1/setup/status", undefined, { cookie: gate.cookie, origin: "https://evil.example" })).status).toBe(200);
  });

  it("a session ended before the write cannot write: the old cookie is refused and nothing changes", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    expect((await post(setup.server, "/api/auth/sign-out", {}, { cookie: owner.sessionCookie })).status).toBe(204);
    expect((await putPreferences(setup.server, owner.sessionCookie, PREFERENCES)).status).toBe(401);
    expect(count(setup.instance, "owner_settings")).toBe(0);
  });

  it("a failing audit rolls the choice and the preferences back: 503, nothing written", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    execute(setup.instance, `CREATE TRIGGER fail_choice BEFORE INSERT ON audit_log WHEN new.action = 'setup.data_chosen' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    const failed = await chooseEmpty(setup.server, gate.cookie);
    expect(failed.status).toBe(503);
    expect(codeOf_(failed)).toBe("AUTH_UNAVAILABLE");
    expect(failed.text).not.toContain("audit unavailable");
    expect(dataChoice(setup)).toBe("unselected");
    execute(setup.instance, "DROP TRIGGER fail_choice");
    expect((await chooseEmpty(setup.server, gate.cookie)).status).toBe(200);

    execute(setup.instance, `CREATE TRIGGER fail_prefs BEFORE INSERT ON audit_log WHEN new.action = 'settings.preferences_saved' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect((await putPreferences(setup.server, gate.cookie, PREFERENCES)).status).toBe(503);
    expect(count(setup.instance, "owner_settings")).toBe(0);
    execute(setup.instance, "DROP TRIGGER fail_prefs");
    expect((await putPreferences(setup.server, gate.cookie, PREFERENCES)).status).toBe(200);
  });

  it("there is no import: its routes do not exist, and no production stub answers", async () => {
    const setup = await installation();
    const gate = await gated(setup);
    for (const route of ["/api/v1/setup/import", "/api/v1/setup/choose-imported", "/api/v1/import"]) {
      const reply = await post(setup.server, route, {}, { cookie: gate.cookie });
      expect(reply.status, route).toBe(404);
      expect(codeOf_(reply)).toBe("NOT_FOUND");
    }
    expect(dataChoice(setup)).toBe("unselected");
  });

  it("a password-only session of an enrolled owner sees the stage but not the private preferences until the factor is proven", async () => {
    const setup = await installation();
    const owner = await readyOwner(setup);
    expect((await putPreferences(setup.server, owner.sessionCookie, PREFERENCES)).status).toBe(200);
    // A password-only session of the same owner sees the stage but not the private preferences.
    const password = await signIn(setup.server);
    expect(setupStatusSchema.parse((await setupStatus(setup.server, password.cookie)).json())).toMatchObject({ stage: "complete", nextAction: "mfa_challenge" });
    const blocked = await getPreferences(setup.server, password.cookie);
    expect(blocked.status).toBe(403);
    expect(codeOf_(blocked)).toBe("MFA_REQUIRED");
    // Proving the factor opens them.
    const proved = await verify(setup.server, password.cookie, { code: await codeOf(owner.secret, 1) });
    expect((await getPreferences(setup.server, proved.cookie)).status).toBe(200);
  });
});
