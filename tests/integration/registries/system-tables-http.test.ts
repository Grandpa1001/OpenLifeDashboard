// D32.1 — the system preview over real HTTP on the built server (Scope §3.1, §5.5; Architektura §4.2,
// §6, §13.4), on Książki of F01 and its table widget made through the API.
// AC1: the list has the six tables of the preview with their columns and the owner's rows in each;
//      the catalog shows Książki without its owner or its physical table, the bindings show the paths of
//      the widget, the audit is newest first without the address and the browser of an entry, and the
//      pages are 25 by default and 1 to 100 on request; a registry of another owner is not shown.
// AC2: a name outside the list (identity, sessions, settings, a user table, SQL) is 404 with no data;
//      no answer holds the hash of the password, a session token, the secret of the second factor or
//      a secret of the installation; a bad page is 422; no other method changes anything; no session
//      and a session before the gate are refused.
import { apiErrorSchema } from "@openlife/contracts/http/errors";
import { SYSTEM_TABLE_NAMES, SYSTEM_TABLES_PATH, systemTableListSchema, systemTablePageSchema, systemTablePath } from "@openlife/contracts/http/system-tables";
import { afterEach, describe, expect, it } from "vitest";
import { SYSTEM_TABLES } from "../../../packages/core/dist/modules/registries/public.js";
import { execute, query, send, signIn, stopServers, type Installation } from "../../support/auth-http.ts";
import { booksOverApi, stored } from "../../support/books-http.ts";

afterEach(stopServers);

const code = (reply: { json: () => unknown }): string => apiErrorSchema.parse(reply.json()).code;
const pageOf = async (setup: Installation, cookie: string, name: string, search = "") => {
  const reply = await send(setup.server, "GET", `${systemTablePath(name)}${search}`, undefined, { cookie });
  expect(reply.status, `${name}${search}`).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("no-store");
  return systemTablePageSchema.parse(reply.json());
};
const count = (setup: Installation, sql: string): number => query<{ n: number }>(setup.instance, sql)[0]!.n;

describe("D32.1-AC1 the six tables of the preview, the owner's rows, in pages", () => {
  it("lists the tables with their columns and counts; the catalog, the bindings and the audit show what they may; pages of 25 and up to 100", async () => {
    const { setup, cookie, registry } = await booksOverApi("d32-1");
    // The contract names the same tables as core, in the same order, and core lists their columns.
    expect(SYSTEM_TABLE_NAMES).toEqual(Object.keys(SYSTEM_TABLES));

    const list = await send(setup.server, "GET", SYSTEM_TABLES_PATH, undefined, { cookie });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const tables = systemTableListSchema.parse(list.json()).tables;
    expect(tables.map((table) => [table.name, table.columns])).toEqual(Object.entries(SYSTEM_TABLES));
    expect(Object.fromEntries(tables.map((table) => [table.name, table.rows]))).toEqual({
      registry: 1,
      registry_column: 9,
      screen: 1,
      widget: count(setup, "SELECT count(*) AS n FROM widget"),
      binding: count(setup, "SELECT count(*) AS n FROM binding"),
      audit_log: count(setup, "SELECT count(*) AS n FROM audit_log"),
    });

    const catalog = await pageOf(setup, cookie, "registry");
    expect(catalog.columns).toEqual(["id", "symbol", "display_name", "schema_revision", "data_revision", "created_at", "updated_at", "deleted_at"]);
    expect(catalog.rows).toHaveLength(1);
    expect(catalog.rows[0]?.slice(0, 5)).toEqual([registry.id, "ksiazki", "Książki", 1, registry.dataRevision]);
    const ownerId = query<{ user_id: string }>(setup.instance, "SELECT user_id FROM registry")[0]!.user_id;
    expect(JSON.stringify(catalog)).not.toContain(ownerId);
    expect(JSON.stringify(catalog)).not.toContain("reg_ksiazki");

    const columns = await pageOf(setup, cookie, "registry_column");
    expect(columns.rows.map((row) => row[2])).toEqual(registry.columns.map((column) => column.symbol));
    const bindings = await pageOf(setup, cookie, "binding");
    expect(bindings.rows.map((row) => row[3])).toContain("Field.Register.ksiazki");

    // The audit: newest first, 25 to a page by default, without the address and the browser.
    const before = count(setup, "SELECT count(*) AS n FROM audit_log");
    for (let index = 0; index < 30; index += 1) execute(setup.instance, `INSERT INTO audit_log (at, actor, action, entity, entity_id, request_id, ip, user_agent, details) VALUES ('2026-11-02T12:00:00.000Z', NULL, 'test.entry', 'test', 'e-${index}', 'r-${index}', '203.0.113.7', 'Agent/7', NULL)`);
    const first = await pageOf(setup, cookie, "audit_log");
    expect([first.total, first.page, first.pageSize, first.rows.length]).toEqual([before + 30, 1, 25, 25]);
    expect(first.columns).not.toContain("ip");
    expect(first.columns).not.toContain("user_agent");
    expect(first.rows[0]?.[5]).toBe("e-29");
    const ids = first.rows.map((row) => row[0] as number);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(JSON.stringify(first)).not.toContain("203.0.113.7");
    const second = await pageOf(setup, cookie, "audit_log", "?page=2&pageSize=10");
    expect([second.page, second.pageSize, second.rows[0]?.[5]]).toEqual([2, 10, "e-19"]);
    expect((await pageOf(setup, cookie, "audit_log", "?pageSize=100")).rows).toHaveLength(Math.min(100, before + 30));
    expect((await pageOf(setup, cookie, "audit_log", "?page=999")).rows).toEqual([]);

    // A registry and a screen of another owner in the same database are not in the preview.
    execute(setup.instance, `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('other-owner', 'Inny', 'inny@example.test', 1, 0, 0)`);
    execute(setup.instance, `INSERT INTO registry (id, user_id, symbol, display_name, table_name, created_at, updated_at) VALUES ('other-registry', 'other-owner', 'obcy', 'Obcy', 'reg_obcy', '2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z')`);
    execute(setup.instance, `INSERT INTO screen (id, user_id, name, theme, accent, created_at, updated_at) VALUES ('other-screen', 'other-owner', 'Obcy', 'dark', 'blue', '2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z')`);
    expect((await pageOf(setup, cookie, "registry")).rows.map((row) => row[1])).toEqual(["ksiazki"]);
    expect((await pageOf(setup, cookie, "screen")).total).toBe(1);
  });
});

describe("D32.1-AC2 nothing outside the list, nothing written, nothing before the gate", () => {
  it("a name outside the list is 404 with no data; no answer holds a hash, a token or a secret; a bad page is 422; no method writes", async () => {
    const { setup, cookie } = await booksOverApi("d32-1-refusals");
    const answers: string[] = [];
    const keep = <R extends { text: string }>(reply: R): R => {
      answers.push(reply.text);
      return reply;
    };
    for (const name of ["user", "session", "account", "verification", "session_ext", "mfa_state", "recovery_code", "trusted_device", "app_setting", "idempotency_entry", "owner_settings", "config_entry", "reg_ksiazki", "sqlite_master", "registry;--", "registry where 1", "..", "REGISTRY", "constructor", "__proto__", "toString"]) {
      const reply = keep(await send(setup.server, "GET", systemTablePath(name), undefined, { cookie }));
      expect([reply.status, code(reply)], name).toEqual([404, "NOT_FOUND"]);
    }
    for (const search of ["?page=0", "?page=-1", "?page=1e3", "?pageSize=0", "?pageSize=101", "?page=1&page=2"]) {
      const reply = keep(await send(setup.server, "GET", `${systemTablePath("registry")}${search}`, undefined, { cookie }));
      expect([reply.status, code(reply)], search).toEqual([422, "VALIDATION_FAILED"]);
    }
    keep(await send(setup.server, "GET", SYSTEM_TABLES_PATH, undefined, { cookie }));
    for (const name of SYSTEM_TABLE_NAMES) keep(await send(setup.server, "GET", `${systemTablePath(name)}?pageSize=100`, undefined, { cookie }));

    const before = stored(setup);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const path of [SYSTEM_TABLES_PATH, systemTablePath("registry")]) {
        const reply = keep(await send(setup.server, method, path, { name: "registry", rows: [] }, { cookie }));
        expect([reply.status, code(reply)], `${method} ${path}`).toEqual([404, "NOT_FOUND"]);
      }
    }
    expect(stored(setup)).toBe(before);

    const secrets = [
      ...setup.instance.secrets,
      ...query<{ password: string }>(setup.instance, `SELECT password FROM account WHERE password IS NOT NULL`).map((row) => row.password),
      ...query<{ token: string }>(setup.instance, `SELECT token FROM session`).map((row) => row.token),
      ...query<{ secret: string | null }>(setup.instance, `SELECT active_secret AS secret FROM mfa_state`).flatMap((row) => (row.secret === null ? [] : [row.secret])),
      ...query<{ hash: string }>(setup.instance, `SELECT code_hash AS hash FROM recovery_code`).map((row) => row.hash),
    ];
    expect(secrets.length).toBeGreaterThan(4);
    for (const secret of secrets) expect(answers.some((text) => text.includes(secret))).toBe(false);
  });

  it("no session and a session before the second factor are refused on both routes", async () => {
    const { setup } = await booksOverApi("d32-1-gate");
    for (const path of [SYSTEM_TABLES_PATH, systemTablePath("registry"), systemTablePath("user")]) {
      const anonymous = await send(setup.server, "GET", path, undefined, { cookie: null });
      expect([anonymous.status, code(anonymous)], path).toEqual([401, "AUTH_REQUIRED"]);
      const password = (await signIn(setup.server)).cookie ?? "";
      const early = await send(setup.server, "GET", path, undefined, { cookie: password });
      expect([early.status, code(early)], path).toEqual([403, "MFA_REQUIRED"]);
    }
  });
});
