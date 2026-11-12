// D43.2 — the trusted devices of the owner over HTTP, on the in-process app of the harness (Scope §5.9;
// Architektura §9.3, §9.6; DEV §9.40): the list, revoking one device and revoking all of them.
// AC1: no session is 401 and a foreign Origin 403; the list names each valid device by its id and the
//      browser the owner trusted, shows when it was made and when it expires (30 days, never extended),
//      leaves out an expired or revoked one, and carries no token or hash.
// AC2: revoking a device takes the data away from the session that was admitted because of it, which
//      must prove the second factor again; an unknown or revoked id is not found; revoking all needs a
//      fresh TOTP (a session admitted by a recovery code is refused STEP_UP_REQUIRED and nothing is
//      revoked); every revoking is audited with the id or the count and no token.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { SECURITY_DEVICES_PATH, SECURITY_DEVICES_REVOKE_ALL_PATH, SECURITY_SESSIONS_PATH, devicesRevokedSchema, securityDevicePath, trustedDeviceListSchema } from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const PHONE = "Phone browser on Android";
const DAY_MS = 24 * 3600 * 1000;

/** The owner past the gate with a TOTP session A, a device trusted from PHONE, a session T admitted by that device, and a session B admitted by a recovery code. */
async function ownerWithDevice() {
  const h = await createAppHarness();
  const signIn = async (agent: string, cookie: string | null = null) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password: HARNESS_PASSWORD }, { cookie, headers: { "User-Agent": agent } });
  const password = (await signIn("Browser A")).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: password })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: password });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });

  // Trusting a device: a TOTP with rememberDevice from the browser PHONE; the answer sets the cookie of the device.
  const proved = await h.request("POST", "/api/v1/mfa/verify", { code: await codeOf(secret, 1), rememberDevice: true }, { cookie: (await signIn(PHONE)).cookie, headers: { "User-Agent": PHONE } });
  const trustedCookie = proved.setCookies.map((line) => line.split(";")[0] ?? "").find((cookie) => cookie.includes("trusted_device")) ?? "";
  expect(trustedCookie).not.toBe("");
  const t = (await signIn("Browser T", trustedCookie)).cookie ?? "";
  const b = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[0] }, { cookie: (await signIn("Browser B")).cookie })).cookie ?? "";
  const list = async (cookie: string) => trustedDeviceListSchema.parse((await h.request("GET", SECURITY_DEVICES_PATH, undefined, { cookie })).json()).devices;
  return { h, a, t, b, list, trustedCookie };
}

describe("D43.2-AC1 the list of the trusted devices", () => {
  it("answers 401 without a session and 403 for a foreign Origin on each route", async () => {
    const { h, a } = await ownerWithDevice();
    for (const [method, route, body] of [["GET", SECURITY_DEVICES_PATH, undefined], ["POST", SECURITY_DEVICES_REVOKE_ALL_PATH, {}], ["DELETE", securityDevicePath("any"), {}]] as const) {
      const anonymous = await h.request(method, route, body, { cookie: null });
      expect(anonymous.status, `${method} ${route}`).toBe(401);
      expect(apiErrorSchema.parse(anonymous.json()).requestId).toBeTruthy();
      if (method !== "GET") expect((await h.request(method, route, body, { cookie: a, origin: "https://evil.example" })).status, `${method} ${route} foreign Origin`).toBe(403);
    }
  });

  it("lists the valid devices newest first with the name of their browser, leaves out expired and revoked ones, and carries no token or hash", async () => {
    const { h, a, list, trustedCookie } = await ownerWithDevice();
    const now = Date.now();
    // One trusted before names existed, one expired, one revoked: rows as older versions and time leave them.
    const hash = (character: string) => character.repeat(64);
    h.sql(`INSERT INTO trusted_device (id, token_hash, label, created_at_ms, expires_at_ms, revoked_at_ms) VALUES
      ('old-unnamed', '${hash("b")}', NULL, ${now - 3 * DAY_MS}, ${now + 27 * DAY_MS}, NULL),
      ('old-expired', '${hash("c")}', 'Expired', ${now - 40 * DAY_MS}, ${now - 10 * DAY_MS}, NULL),
      ('old-revoked', '${hash("d")}', 'Revoked', ${now - 2 * DAY_MS}, ${now + 28 * DAY_MS}, ${now - DAY_MS})`);
    const seen = await list(a);
    expect(seen.map((device) => device.label)).toEqual([PHONE, null]);
    expect(seen.map((device) => device.id)).toContain("old-unnamed");
    const phone = seen[0];
    expect(Date.parse(phone?.expiresAt ?? "") - Date.parse(phone?.createdAt ?? "")).toBe(30 * DAY_MS);
    const raw = (await h.request("GET", SECURITY_DEVICES_PATH, undefined, { cookie: a })).text;
    const stored = h.rows<{ token_hash: string }>("SELECT token_hash FROM trusted_device");
    for (const row of stored) expect(raw).not.toContain(row.token_hash);
    expect(raw).not.toContain(decodeURIComponent(trustedCookie.split("=")[1] ?? "").split(".")[0] ?? "x");
  });
});

describe("D43.2-AC2 revoking devices", () => {
  it("takes the data away from the session admitted by a revoked device, which must prove the factor again; an unknown or revoked id is not found; the revoking is audited without a token", async () => {
    const { h, a, t, list } = await ownerWithDevice();
    const [device] = await list(a);
    expect(device?.label).toBe(PHONE);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: t })).status).toBe(200);

    expect((await h.request("DELETE", securityDevicePath("no-such-device"), {}, { cookie: a })).status).toBe(404);
    expect((await h.request("DELETE", securityDevicePath(device?.id ?? ""), {}, { cookie: a })).status).toBe(204);
    const closed = await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: t });
    expect(closed.status).toBe(403);
    expect(apiErrorSchema.parse(closed.json()).code).toBe("MFA_REQUIRED");
    expect(await list(a)).toEqual([]);
    expect((await h.request("DELETE", securityDevicePath(device?.id ?? ""), {}, { cookie: a })).status).toBe(404);

    const audit = h.rows<{ action: string; entity_id: string }>("SELECT action, entity_id FROM audit_log WHERE action LIKE 'device.%' ORDER BY id");
    expect(audit).toEqual([{ action: "device.revoked", entity_id: device?.id }]);
  });

  it("refuses revoking all to a session admitted by a recovery code and revokes every device for one with a fresh TOTP", async () => {
    const { h, a, b, t, list } = await ownerWithDevice();
    h.sql(`INSERT INTO trusted_device (id, token_hash, label, created_at_ms, expires_at_ms) VALUES ('second', '${"e".repeat(64)}', 'Second', ${Date.now()}, ${Date.now() + 29 * DAY_MS})`);
    expect(await list(a)).toHaveLength(2);

    const refused = await h.request("POST", SECURITY_DEVICES_REVOKE_ALL_PATH, {}, { cookie: b });
    expect(refused.status).toBe(403);
    expect(apiErrorSchema.parse(refused.json()).code).toBe("STEP_UP_REQUIRED");
    expect(await list(a)).toHaveLength(2);

    const done = await h.request("POST", SECURITY_DEVICES_REVOKE_ALL_PATH, {}, { cookie: a });
    expect(done.status).toBe(200);
    expect(devicesRevokedSchema.parse(done.json())).toEqual({ revoked: 2 });
    expect(await list(a)).toEqual([]);
    expect((await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: t })).status).toBe(403);
    expect(devicesRevokedSchema.parse((await h.request("POST", SECURITY_DEVICES_REVOKE_ALL_PATH, {}, { cookie: a })).json())).toEqual({ revoked: 0 });
    const audit = h.rows<{ action: string; details: string }>("SELECT action, details FROM audit_log WHERE action LIKE 'device.%' ORDER BY id");
    expect(audit.map((row) => row.action)).toEqual(["device.revoked_all", "device.revoked_all"]);
    expect(JSON.parse(audit[0]?.details ?? "{}")).toEqual({ revoked: 2 });
  });
});
