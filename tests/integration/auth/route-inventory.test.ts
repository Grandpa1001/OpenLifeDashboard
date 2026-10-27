// D13.1 — the inventory of the real routes and what each asks for, checked against the source that
// registers them and against raw HTTP (no React, no helper that knows more than a client does).
// AC1: the owner past the gate and the empty start gets 200 from the real GET/PUT preferences and
//      every earlier state is refused by the contract (a positive control of the same route).
// AC2: a foreign or missing Origin, privileged fields, foreign owner and session identifiers and
//      auth helpers nobody documented change neither the permission nor the data.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PASSWORD, ack, chooseEmpty, enrolled, getPreferences, installation, post, putPreferences, query, send, setupStatus, signIn, stopServers, type Installation } from "../../support/auth-http.ts";
import { PATH_CONSTANTS, ROUTE_INVENTORY } from "../../support/route-inventory.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(stopServers);

const PREFERENCES = { timezone: "Europe/Warsaw", locale: "pl" } as const;
const FOREIGN_ORIGIN = "https://evil.example";

/** What the routes may change, as one text: any difference is a change of data or of permission. */
function snapshot(setup: Installation): string {
  const tables = ["instance_state", "owner_settings", "user", "account", "mfa_state", "recovery_code", "trusted_device", "session", "session_ext"];
  return JSON.stringify(tables.map((table) => query(setup.instance, `SELECT * FROM "${table}" ORDER BY 1`)));
}
const errorCode = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;

/** Source files of the routes and of the app composition. */
function registeredRoutes(): string[] {
  const files = [
    path.join(repoRoot, "apps/server/src/bootstrap/create-app.ts"),
    ...readdirSync(path.join(repoRoot, "apps/server/src/http/routes")).map((name) => path.join(repoRoot, "apps/server/src/http/routes", name)),
  ];
  const found: string[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*([A-Za-z0-9_]+|"[^"]+")/g)) {
      const [, method, target] = match;
      const resolved = target?.startsWith('"') ? target.slice(1, -1) : PATH_CONSTANTS[target ?? ""];
      if (resolved === undefined) throw new Error(`the route ${method} ${target} in ${file} has no path constant the inventory can resolve`);
      found.push(`${(method ?? "").toUpperCase()} ${resolved}`);
    }
  }
  return found.sort();
}

describe("D13.1 the inventory is the registered routes", () => {
  it("every registered route is listed with its access, and every listed route is registered", () => {
    expect(registeredRoutes()).toEqual(ROUTE_INVENTORY.map((route) => `${route.method} ${route.path}`).sort());
  });

  it("every listed route has an access and a note, and none is listed twice", () => {
    const keys = ROUTE_INVENTORY.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const route of ROUTE_INVENTORY) {
      expect(route.note.length).toBeGreaterThan(10);
    }
  });
});

describe("D13.1-AC1 every state of the owner meets the contract on the same routes", () => {
  it("none, password only, awaiting the acknowledgment, data unchosen, empty chosen, complete", async () => {
    const setup = await installation();
    const { server } = setup;

    // No session: everything private is 401; the status is open and says to sign in.
    for (const reply of [await setupStatus(server, null), await getPreferences(server, null), await putPreferences(server, null, PREFERENCES), await chooseEmpty(server, null)]) {
      expect(reply.status).toBe(401);
      expect(errorCode(reply)).toBe("AUTH_REQUIRED");
    }
    for (const step of [post(server, "/api/v1/mfa/enrollment/begin", {}, { cookie: null }), post(server, "/api/v1/mfa/step-up", { code: "123456" }, { cookie: null })]) {
      expect((await step).status).toBe(401);
    }
    expect((await send(server, "GET", "/api/v1/identity/status", undefined)).status).toBe(200);

    // Password session, no authenticator yet: the stage is readable, the private routes want the factor.
    const password = (await signIn(server)).cookie ?? "";
    expect((await setupStatus(server, password)).status).toBe(200);
    for (const reply of [await getPreferences(server, password), await putPreferences(server, password, PREFERENCES), await chooseEmpty(server, password)]) {
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("MFA_REQUIRED");
    }

    // Enrolled, the codes not acknowledged: the acknowledgment comes first.
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    expect((await setupStatus(server, session)).status).toBe(200);
    for (const reply of [await getPreferences(server, session), await putPreferences(server, session, PREFERENCES), await chooseEmpty(server, session)]) {
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("RECOVERY_ACK_REQUIRED");
    }
    const batchId = (first.codes?.batchId ?? "") as string;
    expect((await ack(server, session, batchId)).status).toBe(200);

    // Acknowledged, no data chosen: the preferences wait, the choice itself is open.
    for (const reply of [await getPreferences(server, session), await putPreferences(server, session, PREFERENCES)]) {
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe("SETUP_DATA_REQUIRED");
    }
    expect((await chooseEmpty(server, session)).status).toBe(200);

    // The positive control of the same routes: the owner past the gate and the empty start.
    const empty = await getPreferences(server, session);
    expect(empty.status).toBe(200);
    expect(empty.json()).toEqual({ preferences: null, stage: "preferences" });
    const saved = await putPreferences(server, session, PREFERENCES);
    expect(saved.status).toBe(200);
    expect(saved.json()).toEqual({ preferences: PREFERENCES, stage: "complete" });
    expect((await getPreferences(server, session)).json()).toEqual({ preferences: PREFERENCES, stage: "complete" });

    // A new password session of the finished owner is again before the second factor.
    const later = (await signIn(server)).cookie ?? "";
    const before = await getPreferences(server, later);
    expect([before.status, errorCode(before)]).toEqual([403, "MFA_REQUIRED"]);
    expect((await putPreferences(server, later, { timezone: "UTC", locale: "en" })).status).toBe(403);
    expect((await getPreferences(server, session)).json()).toEqual({ preferences: PREFERENCES, stage: "complete" });
  });
});

describe("D13.1-AC2 what a request may not decide", () => {
  async function readyOwner(setup: Installation) {
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    expect((await ack(setup.server, session, first.codes?.batchId ?? "")).status).toBe(200);
    expect((await chooseEmpty(setup.server, session)).status).toBe(200);
    expect((await putPreferences(setup.server, session, PREFERENCES)).status).toBe(200);
    return session;
  }

  it("a foreign, a missing or a null Origin refuses every mutation and changes nothing, a session past the gate included", async () => {
    const setup = await installation();
    const session = await readyOwner(setup);
    const before = snapshot(setup);
    const mutations = ROUTE_INVENTORY.filter((route) => route.method !== "GET");
    for (const route of mutations) {
      for (const origin of [FOREIGN_ORIGIN, null, "null", "http://localhost:8080.evil.example", "http://localhost:8081"]) {
        const reply = await send(setup.server, route.method, route.path, route.path.endsWith("preferences") ? { timezone: "UTC", locale: "en" } : {}, { cookie: session, origin });
        expect([route.path, origin, reply.status, errorCode(reply)]).toEqual([route.path, origin, 403, "ORIGIN_FORBIDDEN"]);
        expect(reply.setCookies).toEqual([]);
      }
    }
    expect(snapshot(setup)).toBe(before);
    // The positive control: the same route with the right Origin still works.
    expect((await putPreferences(setup.server, session, { timezone: "UTC", locale: "en" })).status).toBe(200);
    expect(snapshot(setup)).not.toBe(before);
  });

  it("privileged fields are refused by the strict contracts and change neither the data nor the permission", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    await ack(server, session, first.codes?.batchId ?? "");
    const unchosen = snapshot(setup);
    const privileged = { ownerId: "someone-else", sessionId: "s-1", role: "admin", accessEpoch: 99, assurance: "totp", mfaPolicy: "disabled", dataChoice: "imported", enrollmentState: "complete" };
    for (const extra of Object.entries(privileged)) {
      const body = Object.fromEntries([extra]);
      const choose = await post(server, "/api/v1/setup/choose-empty", body, { cookie: session });
      expect([extra[0], choose.status, errorCode(choose)]).toEqual([extra[0], 422, "VALIDATION_FAILED"]);
    }
    expect(snapshot(setup)).toBe(unchosen);

    expect((await chooseEmpty(server, session)).status).toBe(200);
    const chosen = snapshot(setup);
    for (const extra of Object.entries(privileged)) {
      const reply = await putPreferences(server, session, { ...PREFERENCES, [extra[0]]: extra[1] });
      expect([extra[0], reply.status, errorCode(reply)]).toEqual([extra[0], 422, "VALIDATION_FAILED"]);
    }
    expect(snapshot(setup)).toBe(chosen);

    // The password session cannot raise its own assurance by saying so.
    const password = (await signIn(server)).cookie ?? "";
    for (const body of [{ code: "000000", assurance: "totp" }, { recoveryCode: "AAAAA-BBBBB", assurance: "recovery" }, { code: "000000", rememberDevice: true, ownerId: "x" }]) {
      expect((await post(server, "/api/v1/mfa/verify", body, { cookie: password })).status).toBeGreaterThanOrEqual(400);
    }
    expect(errorCode(await getPreferences(server, password))).toBe("MFA_REQUIRED");
    const signInExtra = await post(server, "/api/auth/sign-in/email", { email: "owner@example.test", password: "x", assurance: "totp", ownerId: "y" }, { cookie: null });
    expect([signInExtra.status, signInExtra.cookies]).toEqual([422, []]);
  });

  it("foreign owner and session identifiers in headers, query, cookies and body grant nothing", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    const password = (await signIn(server)).cookie ?? "";
    const before = snapshot(setup);
    const ownerRow = query<{ id: string }>(setup.instance, `SELECT id FROM "user"`)[0]?.id ?? "";
    const sessionRow = query<{ id: string }>(setup.instance, `SELECT id FROM "session"`)[0]?.id ?? "";
    const disguise = { "X-Owner-Id": ownerRow, "X-Session-Id": sessionRow, "X-User-Id": ownerRow, "X-Forwarded-User": "owner@example.test", Authorization: `Bearer ${sessionRow}` };
    for (const route of ROUTE_INVENTORY.filter((candidate) => candidate.access === "data" || candidate.access === "setup")) {
      const body = route.method === "GET" ? undefined : route.path.endsWith("preferences") ? PREFERENCES : route.path.endsWith("step-up") ? { code: "123456" } : {};
      const plain = await send(server, route.method, route.path, body, { cookie: password });
      const disguised = await fetch(`${server.baseUrl}${route.path}?ownerId=${ownerRow}&sessionId=${sessionRow}&userId=${ownerRow}`, {
        method: route.method,
        headers: { ...disguise, Origin: "http://localhost:8080", Cookie: `${password}; ownerId=${ownerRow}; sessionId=${sessionRow}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // The password session with the disguise is exactly the password session without it, and both are refused.
      expect([route.path, disguised.status, ((await disguised.json()) as { code?: string }).code]).toEqual([route.path, plain.status, errorCode(plain)]);
      expect(plain.status).toBeGreaterThanOrEqual(403);
    }
    // A confirm for another owner's challenge is the same answer as for a challenge that never was.
    const unknown = await post(server, "/api/v1/mfa/enrollment/confirm", { challengeId: ownerRow, code: "123456" }, { cookie: session });
    const nothing = await post(server, "/api/v1/mfa/enrollment/confirm", { challengeId: "no-such-challenge", code: "123456" }, { cookie: session });
    expect([unknown.status, errorCode(unknown)]).toEqual([nothing.status, errorCode(nothing)]);
    expect((await ack(server, session, ownerRow)).status).toBe(409);
    expect(snapshot(setup)).toBe(before);
  });

  it("no auth helper that is not in the inventory answers, with a session or without", async () => {
    const setup = await installation();
    const session = (await readyOwner(setup));
    const before = snapshot(setup);
    const undocumented = [
      ["GET", "/api/auth/get-session"],
      ["GET", "/api/auth/list-sessions"],
      ["GET", "/api/auth/ok"],
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/username"],
      ["POST", "/api/auth/forget-password"],
      ["POST", "/api/auth/reset-password"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/delete-user"],
      ["POST", "/api/auth/revoke-sessions"],
      ["POST", "/api/auth/two-factor/enable"],
      ["POST", "/api/auth/two-factor/verify-totp"],
      ["POST", "/api/auth/admin/set-role"],
      ["POST", "/api/v1/mfa/disable"],
      ["POST", "/api/v1/identity/owner"],
      ["PUT", "/api/v1/identity/status"],
      ["DELETE", "/api/v1/setup/preferences"],
      ["PATCH", "/api/v1/setup/preferences"],
      ["POST", "/api/v1/test/session"],
    ] as const;
    for (const [method, route] of undocumented) {
      for (const cookie of [null, session]) {
        const reply = await send(setup.server, method, route, method === "GET" ? undefined : {}, { cookie });
        expect([method, route, cookie === null, reply.status]).toEqual([method, route, cookie === null, 404]);
        expect(reply.setCookies).toEqual([]);
      }
    }
    expect(snapshot(setup)).toBe(before);
  });
});

describe("D13.1 audit and answers carry no authentication material", () => {
  it("the audit trail and the answers of the read routes hold no password, secret, code, cookie or raw auth row", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    await ack(server, session, first.codes?.batchId ?? "");
    await chooseEmpty(server, session);
    await putPreferences(server, session, PREFERENCES);
    const password = await signIn(server, null, "not the password");
    expect(password.status).toBe(401);
    await post(server, "/api/v1/mfa/verify", { code: "000000" }, { cookie: (await signIn(server)).cookie });

    const sessionToken = session.split("=")[1] ?? "";
    const secrets = [OWNER_PASSWORD, "not the password", first.secret.toString("hex"), first.secret.toString("base64"), first.challenge.manualKey.replaceAll(" ", ""), first.challenge.otpauthUri, sessionToken, ...(first.codes?.recoveryCodes ?? [])];
    const audit = JSON.stringify(query(setup.instance, "SELECT * FROM audit_log"));
    expect(audit.length).toBeGreaterThan(100);
    for (const secret of secrets) expect(audit, `audit holds ${secret.slice(0, 4)}…`).not.toContain(secret);

    const answers = [await setupStatus(server, session), await getPreferences(server, session), await send(server, "GET", "/api/v1/identity/status", undefined, { cookie: session }), await send(server, "GET", "/api/v1/bootstrap", undefined, { cookie: session })];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.text).not.toMatch(/token|secret|hash|password|salt|cookie|recovery|totp/i);
      for (const secret of secrets) expect(answer.text).not.toContain(secret);
    }
  });
});
