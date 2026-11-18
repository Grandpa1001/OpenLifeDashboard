// D60.2 — the address of the client on the built server (DEV §9.59, Architektura §9.4, §14.4). The test peer is 127.0.0.1, so the name
// `localhost` stands for the Caddy of an installation (it resolves to the address of the peer) and a name that does not resolve for any
// other peer. AC1: X-Forwarded-For counts only from the trusted proxy; the variable is refused in the local mode and for a wrong value.
// AC2: the limit of sign-in requests and the audit use the address of the client.
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_EMAIL, OWNER_PASSWORD, CREATE_OWNER, installation, post, query, serve, signIn, stopServers } from "../../support/auth-http.ts";
import { CONFIG_CHECK_ENTRY, runBuiltScript, startedInstallation } from "../../support/server-process.ts";

const SERVER_ORIGIN = "https://dashboard.example.invalid";
const SIGN_IN = "/api/auth/sign-in/email";
afterEach(stopServers);

/** A server installation with its owner; `proxy` is the name of the trusted proxy. */
async function behindProxy(proxy?: string) {
  const instance = await startedInstallation({ installMode: "server" });
  const created = await runBuiltScript(CREATE_OWNER, ["--installation", instance.dir], { PATH: process.env["PATH"] ?? "", ...instance.env }, JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }));
  expect(created.code, created.output).toBe(0);
  const server = await serve(instance, undefined, proxy === undefined ? {} : { TRUSTED_PROXY_HOST: proxy });
  return { instance, server };
}
const via = (forwarded: string) => ({ origin: SERVER_ORIGIN, headers: { "X-Forwarded-For": forwarded } });
/** The requests that are counted by the limit and refused cheaply (a body that is no sign-in). */
const counted = (server: Parameters<typeof post>[0], forwarded: string) => post(server, SIGN_IN, {}, via(forwarded));
const auditedIps = (instance: Parameters<typeof query>[0]) => query<{ ip: string | null }>(instance, "SELECT ip FROM audit_log WHERE ip IS NOT NULL").map((row) => row.ip);

describe("D60.2 whose X-Forwarded-For is believed", () => {
  it("D60.2-AC1 and AC2 from the trusted proxy it is the client: every address has its own limit, and the audit holds it", async () => {
    const { instance, server } = await behindProxy("localhost");
    for (let index = 0; index < 10; index += 1) expect((await counted(server, "203.0.113.50")).status).toBe(422);
    expect((await counted(server, "203.0.113.50")).status).toBe(429);
    expect((await counted(server, "203.0.113.51")).status).toBe(422);
    const signed = await post(server, SIGN_IN, { email: OWNER_EMAIL, password: OWNER_PASSWORD }, via("203.0.113.77"));
    expect(signed.status).toBe(200);
    expect(auditedIps(instance)).toContain("203.0.113.77");
  });

  it("D60.2-AC1 without a trusted proxy the header is not read: changing it does not change the limit or the audit", async () => {
    const { instance, server } = await behindProxy();
    for (let index = 0; index < 10; index += 1) expect((await counted(server, `203.0.113.${index + 1}`)).status).toBe(422);
    expect((await counted(server, "203.0.113.200")).status).toBe(429);
    expect(auditedIps(instance)).not.toContain("203.0.113.200");
  });

  it("D60.2-AC1 a proxy name that is not the peer is a stranger: the header is not read", async () => {
    const { instance, server } = await behindProxy("no-such-proxy.invalid");
    for (let index = 0; index < 10; index += 1) expect((await counted(server, `203.0.113.${index + 1}`)).status).toBe(422);
    expect((await counted(server, "203.0.113.200")).status).toBe(429);
    expect(auditedIps(instance)).toEqual([]);
    expect(server.output()).toContain('"event":"proxy.resolve_failed"');
  });

  it("D60.2-AC2 the local mode keeps the address of the connection, and its audit holds it", async () => {
    const { instance, server } = await installation();
    const response = await signIn(server);
    expect(response.status).toBe(200);
    const forged = await post(server, SIGN_IN, { email: OWNER_EMAIL, password: OWNER_PASSWORD }, { headers: { "X-Forwarded-For": "203.0.113.9" } });
    expect(forged.status).toBe(200);
    expect(auditedIps(instance).every((ip) => ip === "127.0.0.1")).toBe(true);
  });

  it("D60.2-AC1 the variable is refused in the local mode and for a value that is no service name, with the field and not the value", async () => {
    const instance = await startedInstallation();
    const refuse = async (env: Record<string, string>, expectedField: string) => {
      const run = await runBuiltScript(CONFIG_CHECK_ENTRY, [], { PATH: process.env["PATH"] ?? "", ...env });
      expect(run.code).toBe(1);
      const line = JSON.parse(run.output.trim()) as { code: string; fields: string[] };
      expect(line).toMatchObject({ code: "CONFIG_INVALID", fields: [expectedField] });
      return run.output;
    };
    await refuse({ ...instance.env, TRUSTED_PROXY_HOST: "caddy" }, "TRUSTED_PROXY_HOST");
    const server = await startedInstallation({ installMode: "server" });
    expect(await refuse({ ...server.env, TRUSTED_PROXY_HOST: "10.20.30.40" }, "TRUSTED_PROXY_HOST")).not.toContain("10.20.30.40");
    const ready = await runBuiltScript(CONFIG_CHECK_ENTRY, [], { PATH: process.env["PATH"] ?? "", ...server.env, TRUSTED_PROXY_HOST: "caddy" });
    expect(ready.code, ready.output).toBe(0);
  });
});
