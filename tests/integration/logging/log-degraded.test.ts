// D06.2-AC2 on the built server: the log folder cannot be written, the server starts and serves,
// every request line is still on stdout, stderr carries one limited notice without a path or
// secret, and the rotation options are part of the effective option set.
import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { freshTestInstance, outputEvent, startBuiltServer, waitForExit } from "../../support/server-process.ts";

const restoreModes: string[] = [];
afterAll(() => {
  for (const dir of restoreModes) chmodSync(dir, 0o755);
});

describe("D06.2-AC2 the server with an unwritable log folder", () => {
  it("serves, logs to stdout, reports one notice and writes no file", async () => {
    const instance = freshTestInstance();
    const logs = path.join(instance.dir, "data", "logs", "app");
    chmodSync(logs, 0o555);
    restoreModes.push(logs);

    const server = await startBuiltServer({ installation: instance });
    const first = await fetch(`${server.baseUrl}/api/nothing`);
    for (let index = 0; index < 5; index += 1) await fetch(`${server.baseUrl}/api/nothing-${index}`);
    expect((await fetch(`${server.baseUrl}/api/health`)).status).toBe(200);
    expect(first.status).toBe(404);
    // The sink drains in a later turn of the event loop; give it that turn.
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    expect(exit.code).toBe(0);

    const requestLines = exit.output.split("\n").filter((entry) => entry.includes('"event":"http.request"'));
    expect(requestLines).toHaveLength(6);
    const notices = exit.output.split("\n").filter((entry) => entry.includes('"logger.sink_degraded"'));
    expect(notices).toHaveLength(1);
    expect(JSON.parse(notices[0] ?? "")).toMatchObject({ event: "logger.sink_degraded", code: "LOG_SINK_UNAVAILABLE" });
    expect(notices[0]).not.toMatch(/EACCES|\/|app\.jsonl/);
    expect(exit.output).toContain('{"event":"bootstrap.degraded","code":"LOG_SINK_UNAVAILABLE","fields":["logs"]}');
    expect(readdirSync(logs)).toEqual([]);
    for (const secret of instance.secrets) expect(exit.output.includes(secret)).toBe(false);
  });

  it("the rotation options are in the effective option set with their defaults", async () => {
    const server = await startBuiltServer();
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    const ready = outputEvent(exit.output, "bootstrap.ready");
    const settings = (ready?.["settings"] ?? []) as Array<{ key: string; value: number; source: string }>;
    expect(settings.filter((setting) => setting.key.startsWith("logs."))).toEqual([
      { key: "logs.fileMaxMiB", value: 10, source: "default" },
      { key: "logs.maxFiles", value: 5, source: "default" },
      { key: "logs.retentionDays", value: 14, source: "default" },
    ]);
  });
});
