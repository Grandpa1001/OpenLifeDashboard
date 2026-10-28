// D20.2 — the data routes cannot be reached around the gate (Architektura §9.6–9.8, §18.7; Scope
// S1–S6), on the built server and a real file database. The table is made from the route inventory
// of D13.1: every route that asks for the data access is tried in every state of the owner, and a
// route with no positive control fails the test. A refusal is 401 or 403 with a stable code: a 404
// or an empty answer is not a pass, and the same route answers 200 or 201 to the owner past the gate.
// AC1: no session, a password only, enrolled with the codes not acknowledged, acknowledged with the
//      starting data not chosen, a new password session of the finished owner, an ended session and
//      the session of another installation are refused on every data route, with and without data,
//      and nothing is stored; the owner past the gate gets the data.
// AC2: foreign identifiers, assurance and roles in headers, cookies, query and body decide nothing;
//      the planned routes (export, live stream) are not registered and are reported as not_run.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { registryListSchema, REGISTRIES_PATH } from "@openlife/contracts/http/registries";
import { SIGN_OUT_PATH } from "@openlife/contracts/http/identity";
import { SCREENS_PATH, screenSchema } from "@openlife/contracts/http/screens";
import { afterEach, describe, expect, it } from "vitest";
import { ack, chooseEmpty, codeOf, enrolled, installation, post, query, readyOwner, send, signIn, stopServers, verify, type Installation, type Reply } from "../../support/auth-http.ts";
import { PLANNED_ROUTES, ROUTE_INVENTORY, type RouteEntry } from "../../support/route-inventory.ts";
import { repoRoot } from "../../support/server-process.ts";

afterEach(stopServers);

// The preferences are the subject of D13.1, the step-up of D43; every other route of the data access is here.
const OTHER_TASKS = new Set(["GET /api/v1/setup/preferences", "PUT /api/v1/setup/preferences", "POST /api/v1/mfa/step-up"]);
const keyOf = (route: Pick<RouteEntry, "method" | "path">): string => `${route.method} ${route.path}`;
const DATA_ROUTES = ROUTE_INVENTORY.filter((route) => route.access === "data" && !OTHER_TASKS.has(keyOf(route)));

const PLACEHOLDER = { symbol: "waga", screen: "019a0000-0000-7000-8000-0000000000a1", widget: "019a0000-0000-7000-8000-0000000000a2" };
const LAYOUT = { phone: { x: 0, y: 0, w: 1, h: 8 }, tablet: { x: 0, y: 0, w: 8, h: 8 }, desktop: { x: 0, y: 0, w: 8, h: 8 } };
const WAGA = { symbol: "waga", displayName: "Waga", columns: [{ symbol: "kg", displayName: "Kg", type: "number", typeOptions: { decimalPlaces: 1 } }] };
const code = (reply: Reply): string => apiErrorSchema.parse(reply.json()).code;

type Ids = Readonly<{ symbol: string; screen: string; widget: string }>;

const fill = (route: RouteEntry, ids: Ids): string => {
  const widgetPath = route.path.includes("/widgets/:id");
  return route.path.replace(":symbol", ids.symbol).replace(":id", widgetPath ? ids.widget : ids.screen);
};

/** A well-formed request for the route, so that only the access can be the reason of a refusal. */
function requestOf(route: RouteEntry, design: unknown): { body: unknown; headers: Record<string, string> } {
  switch (keyOf(route)) {
    case `POST ${REGISTRIES_PATH}`:
      return { body: { ...WAGA, symbol: "pomiary", displayName: "Pomiary" }, headers: {} };
    case "POST /api/v1/registries/:symbol/records":
      return { body: { schemaRevision: 1, values: { kg: 71.5 } }, headers: { "Idempotency-Key": "d20-2-access-key" } };
    case `POST ${SCREENS_PATH}`:
      return { body: { name: "Ekran" }, headers: {} };
    case "PUT /api/v1/screens/:id/design":
      return { body: design, headers: {} };
    default:
      return { body: undefined, headers: {} };
  }
}

const designOf = (registry: { id: string; symbol: string; columns: Array<{ id: string; symbol: string }> } | null, widget: string) => ({
  name: "Ekran",
  theme: "dark",
  accent: "blue",
  widgets:
    registry === null
      ? []
      : [
          {
            id: widget,
            type: "register-table",
            config: { v: 1, title: "Waga", pageSize: 10, sortDirection: "desc", allowAdd: true },
            layout: LAYOUT,
            bindings: [
              { slot: "registry", ordinal: 0, path: `Field.Register.${registry.symbol}`, target: { kind: "registry", registryId: registry.id } },
              { slot: "columns", ordinal: 0, path: `Field.Register.${registry.symbol}.kg`, target: { kind: "column", registryId: registry.id, columnId: registry.columns.find((column) => column.symbol === "kg")?.id ?? "" } },
              { slot: "sortColumn", ordinal: 0, path: `Field.Register.${registry.symbol}.created_at`, target: { kind: "systemColumn", registryId: registry.id, symbol: "created_at" } },
            ],
          },
        ],
});

/** Everything the data routes can change, as one text: any difference is a stored change. */
function stored(setup: Installation): string {
  const registryTables = query<{ name: string }>(setup.instance, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reg\\_%' ESCAPE '\\' ORDER BY 1").map((row) => row.name);
  const tables = ["registry", "registry_column", "screen", "widget", "binding", "idempotency_entry", ...registryTables];
  return JSON.stringify(tables.map((table) => query(setup.instance, `SELECT * FROM "${table}" ORDER BY 1`)));
}

type Refusal = Readonly<{ status: number; code: string }>;

/** Every data route with the cookie, all of them refused the same way; returns what was asked. */
async function expectRefused(setup: Installation, label: string, cookie: string | null, refusal: Refusal, ids: Ids = PLACEHOLDER, extra: { headers?: Record<string, string>; query?: string } = {}): Promise<number> {
  const before = stored(setup);
  for (const route of DATA_ROUTES) {
    const { body, headers } = requestOf(route, designOf(null, ids.widget));
    const reply = await send(setup.server, route.method, `${fill(route, ids)}${extra.query ?? ""}`, body, { cookie, headers: { ...headers, ...extra.headers } });
    expect({ label, route: keyOf(route), status: reply.status, code: code(reply) }, `${label}: ${keyOf(route)}`).toEqual({ label, route: keyOf(route), ...refusal });
    expect(reply.setCookies, `${label}: ${keyOf(route)} sets no cookie`).toEqual([]);
  }
  expect(stored(setup), `${label}: nothing was stored`).toBe(before);
  return DATA_ROUTES.length;
}

describe("D20.2 the table is the inventory", () => {
  it("covers every route of the data access with a request of its own, and the inventory has them", () => {
    expect(DATA_ROUTES.map(keyOf).sort()).toEqual([
      "GET /api/v1/registries",
      "GET /api/v1/registries/:symbol/records",
      "GET /api/v1/screens",
      "GET /api/v1/screens/:id",
      "GET /api/v1/widget-types",
      "GET /api/v1/widgets/:id/data",
      "POST /api/v1/registries",
      "POST /api/v1/registries/:symbol/records",
      "POST /api/v1/screens",
      "PUT /api/v1/screens/:id/design",
    ]);
  });
});

describe("D20.2-AC1 every data route refuses every state before the gate and answers the owner past it", () => {
  it("none, password only, codes not acknowledged, data not chosen: 401 or 403 with a stable code on every route, nothing stored", async () => {
    const setup = await installation();
    const { server } = setup;
    await expectRefused(setup, "no session", null, { status: 401, code: "AUTH_REQUIRED" });
    await expectRefused(setup, "a cookie that names no session", "better-auth.session_token=nonsense", { status: 401, code: "AUTH_REQUIRED" });

    const password = (await signIn(server)).cookie ?? "";
    await expectRefused(setup, "password only", password, { status: 403, code: "MFA_REQUIRED" });

    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    await expectRefused(setup, "codes not acknowledged", session, { status: 403, code: "RECOVERY_ACK_REQUIRED" });

    expect((await ack(server, session, first.codes?.batchId ?? "")).status).toBe(200);
    await expectRefused(setup, "data not chosen", session, { status: 403, code: "SETUP_DATA_REQUIRED" });
  });

  it("the owner past the gate gets 200 or 201 on every one of the same routes; then the other states are refused with real data and real identifiers", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    expect((await ack(server, session, first.codes?.batchId ?? "")).status).toBe(200);
    expect((await chooseEmpty(server, session)).status).toBe(200);

    // The positive control: each route once, in an order that gives the next one its identifiers.
    const answered = new Map<string, number>();
    const run = async (route: RouteEntry, ids: Ids, design?: unknown): Promise<Reply> => {
      const { body, headers } = requestOf(route, design);
      const reply = await send(server, route.method, fill(route, ids), body, { cookie: session, headers });
      answered.set(keyOf(route), reply.status);
      return reply;
    };
    const route = (method: string, pattern: string): RouteEntry => {
      const found = DATA_ROUTES.find((candidate) => candidate.method === method && candidate.path.endsWith(pattern));
      if (found === undefined) throw new Error(`no data route ${method} ${pattern}`);
      return found;
    };
    const waga = { ...PLACEHOLDER };
    expect((await send(server, "POST", REGISTRIES_PATH, WAGA, { cookie: session })).status).toBe(201);
    const registry = registryListSchema.parse((await run(route("GET", "/registries"), waga)).json()).registries.find((candidate) => candidate.symbol === "waga");
    if (registry === undefined) throw new Error("the registry was not made");
    await run(route("POST", "/registries"), waga);
    expect((await run(route("POST", "/records"), waga)).status).toBe(201);
    await run(route("GET", "/records"), waga);
    const screenReply = await run(route("POST", "/screens"), waga);
    const ids: Ids = { ...waga, screen: screenSchema.parse(screenReply.json()).id };
    await run(route("GET", "/screens"), ids);
    await run(route("GET", "/screens/:id"), ids);
    expect((await run(route("PUT", "/design"), ids, designOf(registry, ids.widget))).status).toBe(200);
    await run(route("GET", "/widget-types"), ids);
    await run(route("GET", "/data"), ids);
    expect([...answered.keys()].sort(), "every data route has its positive control").toEqual(DATA_ROUTES.map(keyOf).sort());
    for (const [key, status] of answered) expect([200, 201], `the owner past the gate on ${key}`).toContain(status);

    // The same routes with data and real identifiers, in the states that remain.
    await expectRefused(setup, "no session, real data", null, { status: 401, code: "AUTH_REQUIRED" }, ids);
    const later = (await signIn(server)).cookie ?? "";
    await expectRefused(setup, "a new password session of the finished owner", later, { status: 403, code: "MFA_REQUIRED" }, ids);

    // A second full session, then ended: the cookie no longer opens anything.
    const login = await signIn(server);
    const proved = await verify(server, login.cookie, { code: await codeOf(first.secret, 1) });
    expect(proved.status).toBe(200);
    const full = proved.cookie ?? login.cookie;
    expect((await send(server, "GET", REGISTRIES_PATH, undefined, { cookie: full })).status).toBe(200);
    expect((await post(server, SIGN_OUT_PATH, {}, { cookie: full })).status).toBe(204);
    await expectRefused(setup, "an ended session", full, { status: 401, code: "AUTH_REQUIRED" }, ids);

    // The full session of another installation on the same host.
    const other = await installation();
    const foreign = (await readyOwner(other)).sessionCookie;
    expect((await send(other.server, "GET", REGISTRIES_PATH, undefined, { cookie: foreign })).status).toBe(200);
    await expectRefused(setup, "the session of another installation", foreign, { status: 401, code: "AUTH_REQUIRED" }, ids);
  });
});

describe("D20.2-AC2 what a request may not decide, and the routes that do not exist yet", () => {
  it("foreign owner and session identifiers, assurance and roles in headers, cookies and query decide nothing for the password session; the full session reads the same data", async () => {
    const setup = await installation();
    const { server } = setup;
    const first = await enrolled(setup);
    const session = first.confirmed.cookie ?? "";
    expect((await ack(server, session, first.codes?.batchId ?? "")).status).toBe(200);
    expect((await chooseEmpty(server, session)).status).toBe(200);
    expect((await send(server, "POST", REGISTRIES_PATH, WAGA, { cookie: session })).status).toBe(201);
    const password = (await signIn(server)).cookie ?? "";

    const forged = { "X-Owner-Id": "someone-else", "X-User-Id": "someone-else", "X-Session-Id": "s-1", "X-Assurance": "totp", "X-Forwarded-User": "owner", "X-Role": "admin", Authorization: "Bearer owner" };
    await expectRefused(setup, "forged headers", password, { status: 403, code: "MFA_REQUIRED" }, PLACEHOLDER, { headers: forged });
    await expectRefused(setup, "forged cookies", `${password}; owner_id=someone-else; assurance=totp; role=admin`, { status: 403, code: "MFA_REQUIRED" });
    await expectRefused(setup, "forged query", password, { status: 403, code: "MFA_REQUIRED" }, PLACEHOLDER, { query: "?ownerId=someone-else&sessionId=s-1&assurance=totp&role=admin" });
    await expectRefused(setup, "forged headers without a session", null, { status: 401, code: "AUTH_REQUIRED" }, PLACEHOLDER, { headers: forged });

    // The full session with the same identifiers reads what it read without them, and a body that claims an owner is refused.
    const plain = await send(server, "GET", REGISTRIES_PATH, undefined, { cookie: session });
    const claimed = await send(server, "GET", `${REGISTRIES_PATH}?ownerId=someone-else&role=admin`, undefined, { cookie: session, headers: forged });
    expect([plain.status, claimed.status]).toEqual([200, 200]);
    expect(claimed.text).toBe(plain.text);
    const before = stored(setup);
    const withOwner = await post(server, "/api/v1/registries/waga/records", { schemaRevision: 1, values: { kg: 1 }, ownerId: "someone-else" }, { cookie: session, headers: { "Idempotency-Key": "d20-2-owner-claim" } });
    expect([withOwner.status, code(withOwner)]).toEqual([422, "VALIDATION_FAILED"]);
    expect(stored(setup)).toBe(before);
  });

  it("the planned routes are not registered, are listed with the task that owns them, and are reported as not_run", () => {
    const registered = new Set(ROUTE_INVENTORY.map(keyOf));
    const sources = [path.join(repoRoot, "apps/server/src/bootstrap/create-app.ts"), ...readdirSync(path.join(repoRoot, "apps/server/src/http/routes")).map((name) => path.join(repoRoot, "apps/server/src/http/routes", name))].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(PLANNED_ROUTES.map((planned) => planned.task).sort()).toEqual(["D37", "D45"]);
    for (const planned of PLANNED_ROUTES) {
      expect(registered.has(keyOf(planned)), `${keyOf(planned)} is planned, so it is not in the inventory yet`).toBe(false);
      expect(sources.includes(planned.path), `${keyOf(planned)} is planned, so the server does not register it yet`).toBe(false);
      expect(planned.note.length).toBeGreaterThan(10);
      process.stdout.write(`not_run: ${keyOf(planned)} — its access test becomes mandatory in ${planned.task}\n`);
    }
  });
});
