// D41.3 — the options survive a restart of the built server on a real file database (Architektura
// §14.1; DEV §9.38): two options changed at once are still there after the process stops and starts
// again, the session of the owner still opens them, the log of the audit holds the change, and a reset
// made after the restart removes the stored value.
// AC2: the values come back from the file, not from the memory of the process that wrote them.
import { settingListSchema, settingPath, SETTINGS_PATH } from "@openlife/contracts/http/settings";
import { afterEach, describe, expect, it } from "vitest";
import { installation, query, readyOwner, send, serve, stopServer, stopServers } from "../../support/auth-http.ts";

afterEach(stopServers);

const valueOf = (reply: { json: () => unknown }, key: string) => settingListSchema.parse(reply.json()).settings.find((setting) => setting.key === key);

describe("D41.3-AC2 the options come back from the file after a restart", () => {
  it("two options changed at once are the same after the server is stopped and started again, and a reset after it removes the stored value", async () => {
    const setup = await installation();
    const { sessionCookie } = await readyOwner(setup);

    // The level of the log applies to the next line: requests are written at "info" before the change and not after it.
    const requests = () => setup.server.output().split("\n").filter((line) => line.includes('"event":"http.request"') && line.includes('"route":"/api/v1/settings"')).length;
    await send(setup.server, "GET", SETTINGS_PATH, undefined, { cookie: sessionCookie });
    const before = requests();
    expect(before).toBeGreaterThan(0);

    const changed = await send(setup.server, "PATCH", SETTINGS_PATH, { values: { "limits.registries": 12, "logs.level": "warn" } }, { cookie: sessionCookie });
    expect(changed.status).toBe(200);
    expect(valueOf(changed, "limits.registries")).toMatchObject({ value: 12, source: "db" });

    await send(setup.server, "GET", SETTINGS_PATH, undefined, { cookie: sessionCookie });
    expect(requests(), "nothing is written at info once the level is warn").toBe(before);

    await stopServer(setup.server);
    const again = await serve(setup.instance);
    const read = await send(again, "GET", SETTINGS_PATH, undefined, { cookie: sessionCookie });
    expect(read.status).toBe(200);
    expect(valueOf(read, "limits.registries")).toMatchObject({ value: 12, source: "db" });
    expect(valueOf(read, "logs.level")).toMatchObject({ value: "warn", source: "db" });
    expect(valueOf(read, "tables.defaultPageSize")).toMatchObject({ value: 25, source: "default" });
    expect(query<{ key: string; value_json: string }>(setup.instance, "SELECT key, value_json FROM app_setting ORDER BY key")).toEqual([
      { key: "limits.registries", value_json: "12" },
      { key: "logs.level", value_json: '"warn"' },
    ]);
    expect(query<{ n: number }>(setup.instance, "SELECT count(*) AS n FROM audit_log WHERE action = 'setting.changed'")[0]!.n).toBe(2);

    const reset = await send(again, "DELETE", settingPath("limits.registries"), {}, { cookie: sessionCookie });
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ key: "limits.registries", value: 200, source: "default" });
    expect(query<{ key: string }>(setup.instance, "SELECT key FROM app_setting")).toEqual([{ key: "logs.level" }]);
  });
});
