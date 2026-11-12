// D43.6 — reading the audit log over HTTP, on the in-process app of the harness (Scope §5.9; Architektura
// §9.8; DEV §9.40).
// AC1: no session is 401; a query outside the contract is 422; the entries come newest first, fifty to a
//      page, with the total; a field the contract does not name decides nothing; a page beyond the last is empty; the address and the browser of an entry are
//      in full.
// AC2: each kind finds the entries it names and the kinds together are the whole log (no entry is in two,
//      the entries of no kind are the rest); an entry carries the kind it is found under; nothing secret
//      is in an answer.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { issuedRecoveryCodesSchema } from "@openlife/contracts/http/mfa";
import { AUDIT_KIND_NAMES, auditLogSchema, SECURITY_AUDIT_PATH, SECURITY_SESSIONS_PATH, securitySessionPath } from "@openlife/contracts/http/security";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses, createAppHarness, HARNESS_EMAIL, HARNESS_PASSWORD } from "../../support/app-harness.ts";
import { codeOf, secretOf } from "../../support/auth-http.ts";

afterEach(closeHarnesses);

const BROWSER = "Browser A on macOS";

/** An owner past the gate with a trail: sign-ins, an enrollment, a wrong code, a registry, an option and an ended session. */
async function owner() {
  const h = await createAppHarness();
  const signIn = (password = HARNESS_PASSWORD, agent = BROWSER) => h.request("POST", "/api/auth/sign-in/email", { email: HARNESS_EMAIL, password }, { headers: { "User-Agent": agent } });
  await signIn("not the password");
  const first = (await signIn()).cookie ?? "";
  const begun = (await h.request("POST", "/api/v1/mfa/enrollment/begin", {}, { cookie: first })).json() as { challengeId: string; otpauthUri: string };
  const secret = secretOf(begun.otpauthUri);
  const confirmed = await h.request("POST", "/api/v1/mfa/enrollment/confirm", { challengeId: begun.challengeId, code: await codeOf(secret) }, { cookie: first });
  const issued = issuedRecoveryCodesSchema.parse(confirmed.json());
  const a = confirmed.cookie ?? "";
  await h.request("POST", "/api/v1/mfa/enrollment/recovery/ack", { batchId: issued.batchId }, { cookie: a });
  await h.request("POST", "/api/v1/setup/choose-empty", {}, { cookie: a });
  await h.request("POST", "/api/v1/mfa/verify", { code: "000000" }, { cookie: (await signIn()).cookie });
  const b = (await h.request("POST", "/api/v1/mfa/verify", { recoveryCode: issued.recoveryCodes[0] }, { cookie: (await signIn(HARNESS_PASSWORD, "Browser B")).cookie })).cookie ?? "";
  await h.request("PATCH", "/api/v1/settings", { values: { "tables.defaultPageSize": 30 } }, { cookie: a });
  await h.request("POST", "/api/v1/registries", { symbol: "notatki", displayName: "Notatki", columns: [{ symbol: "tytul", displayName: "Tytuł", type: "text", typeOptions: {}, defaultValue: null, required: false }] }, { cookie: a });
  const sessions = (await h.request("GET", SECURITY_SESSIONS_PATH, undefined, { cookie: a })).json() as { sessions: Array<{ id: string; current: boolean }> };
  await h.request("DELETE", securitySessionPath(sessions.sessions.find((session) => !session.current)?.id ?? ""), {}, { cookie: a });
  const log = async (query = "", cookie = a) => {
    const reply = await h.request("GET", `${SECURITY_AUDIT_PATH}${query}`, undefined, { cookie });
    return { status: reply.status, body: reply.status === 200 ? auditLogSchema.parse(reply.json()) : null, reply };
  };
  return { h, a, b, issued, log };
}

describe("D43.6-AC1 the list", () => {
  it("answers 401 without a session and 422 for a query outside the contract", async () => {
    const { h, log } = await owner();
    const anonymous = await h.request("GET", SECURITY_AUDIT_PATH, undefined, { cookie: null });
    expect([anonymous.status, apiErrorSchema.parse(anonymous.json()).code]).toEqual([401, "AUTH_REQUIRED"]);
    for (const query of ["?kind=unknown", "?page=0", "?page=-1", "?page=abc", "?page=1.5", "?kind=logins&kind=security"]) {
      expect((await log(query)).status, query).toBe(422);
    }
    // A field the contract does not name decides nothing: the answer is the plain one.
    const plain = (await log()).body;
    expect((await log("?ownerId=someone-else&role=admin")).body).toEqual(plain);
  });

  it("lists the entries newest first with the total, the address and the browser in full", async () => {
    const { log } = await owner();
    const { body } = await log();
    expect(body?.page).toBe(1);
    expect(body?.pageSize).toBe(50);
    const entries = body?.entries ?? [];
    expect(entries.length).toBeGreaterThan(10);
    expect(body?.total).toBe(entries.length);
    expect(entries.map((entry) => entry.id)).toEqual([...entries.map((entry) => entry.id)].sort((x, y) => y - x));
    const signedIn = entries.find((entry) => entry.action === "login.succeeded" && entry.userAgent === BROWSER);
    expect(signedIn).toMatchObject({ ip: "127.0.0.1", userAgent: BROWSER, kind: "logins" });
    expect(Date.parse(signedIn?.at ?? "")).not.toBeNaN();
    // A failed sign-in of a foreign password belongs to the trail too, with the address it came from.
    expect(entries.find((entry) => entry.action === "login.failed")).toMatchObject({ ip: "127.0.0.1", kind: "logins" });
  });

  it("pages by fifty, keeps the order across pages and answers an empty page beyond the last", async () => {
    const { h, log } = await owner();
    const before = (await log()).body?.total ?? 0;
    const insert = h.connection.handle.prepare("INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id, ip, user_agent, details) VALUES (?, NULL, 'login.failed', 'login', ?, ?, '10.0.0.1', 'Foreign browser', '{\"locked\":false}')");
    for (let n = 0; n < 120; n += 1) insert.run(new Date(Date.UTC(2026, 10, 12, 8, 0, n)).toISOString(), `e-${n}`, `r-${n}`);
    const first = (await log()).body;
    const second = (await log("?page=2")).body;
    const third = (await log("?page=3")).body;
    expect(first?.total).toBe(before + 120);
    expect([first?.entries.length, second?.entries.length, third?.entries.length]).toEqual([50, 50, Math.min(50, before + 120 - 100)]);
    expect(first?.entries[0]?.entityId).toBe("e-119");
    const ids = [...(first?.entries ?? []), ...(second?.entries ?? []), ...(third?.entries ?? [])].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    expect((await log("?page=99")).body).toMatchObject({ entries: [], page: 99, total: before + 120 });
  });
});

describe("D43.6-AC2 the kinds and what is in an answer", () => {
  it("finds in each kind the entries it names, and the kinds together are the whole log", async () => {
    const { log } = await owner();
    const all = (await log()).body;
    const byKind = new Map<string, number>();
    for (const kind of AUDIT_KIND_NAMES) {
      const found = (await log(`?kind=${kind}`)).body;
      expect(found?.entries.every((entry) => entry.kind === kind), kind).toBe(true);
      expect(found?.entries.length).toBe(found?.total);
      byKind.set(kind, found?.total ?? 0);
    }
    const none = (all?.entries ?? []).filter((entry) => entry.kind === null).length;
    expect([...byKind.values()].reduce((sum, count) => sum + count, 0) + none).toBe(all?.total);

    const actionsOf = async (kind: string) => new Set((await log(`?kind=${kind}`)).body?.entries.map((entry) => entry.action));
    expect(await actionsOf("logins")).toEqual(new Set(["login.failed", "login.succeeded", "mfa.failed", "mfa.recovery_used"]));
    const security = await actionsOf("security");
    for (const action of ["owner.created", "mfa.enrollment_started", "mfa.enrolled", "mfa.recovery_acknowledged", "session.revoked"]) expect(security.has(action), action).toBe(true);
    expect(security.has("mfa.failed")).toBe(false);
    expect(security.has("login.succeeded")).toBe(false);
    const structure = await actionsOf("structure");
    for (const action of ["setup.data_chosen", "setting.changed", "registry.created"]) expect(structure.has(action), action).toBe(true);
    expect((await log("?kind=updates")).body).toMatchObject({ entries: [], total: 0 });
  });

  it("holds nothing secret: no password, token, cookie or recovery code is in any page", async () => {
    const { h, a, b, issued, log } = await owner();
    const text = [(await log()).reply.text, (await log("?kind=security")).reply.text].join("\n");
    for (const secret of [HARNESS_PASSWORD, "not the password", ...issued.recoveryCodes]) expect(text, secret).not.toContain(secret);
    for (const cookie of [a, b]) expect(text).not.toContain((await h.sessionToken(cookie)) ?? "x");
  });
});
