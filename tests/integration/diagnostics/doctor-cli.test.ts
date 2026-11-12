// D44.4 — the built `doctor` command (Architektura §15.3; DEV §9.41).
// AC1: a healthy installation passes every offline check, with the running app too (it takes no lease), and
//      changes nothing; the online check passes against a ready app and tells an app that is not there, one
//      that is unavailable and one that answers something else; offline and online are separate groups.
// AC2: a broken installation exits 1 with the stable code and the names of the fields of the check that
//      failed, the checks that depend on it are skipped, nothing is repaired or created, no value of the
//      environment is printed; a wrong command line exits 2.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, stopServers } from "../../support/auth-http.ts";
import { freshTestInstance, repoRoot, runBuiltScript, startedInstallation } from "../../support/server-process.ts";
import type { TestInstance } from "../../support/test-instance.ts";

const DOCTOR = path.join(repoRoot, "apps/server/dist/cli/doctor.js");

type Check = { id: string; status: string; code?: string; fields?: string[]; facts?: Record<string, unknown> };
type Report = { event: string; ok: boolean; offline: { ok: boolean; checks: Check[] }; online: { ok: boolean; checks: Check[] } | null };

const envOf = (instance: TestInstance) => ({ PATH: process.env["PATH"] ?? "", ...instance.env });
const run = (instance: TestInstance, extra: string[] = [], env: Record<string, string> = envOf(instance)) => runBuiltScript(DOCTOR, ["--installation", instance.dir, ...extra], env);
const reportOf = (output: string): Report => JSON.parse(output.trim().split("\n").filter((line) => line.startsWith("{")).at(-1) ?? "{}") as Report;
const checkOf = (report: Report, id: string): Check => report.offline.checks.find((check) => check.id === id) ?? { id, status: "missing" };

/** Every file of the installation with its size, so that "nothing changed" is a comparison; the database companions that SQLite makes and removes are left out. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && !/-(wal|shm)$/.test(entry.name))
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return `${path.relative(dir, file)} ${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    })
    .sort();
}
const folders = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();

const servers: Server[] = [];
afterEach(async () => {
  await stopServers();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function answering(status: number, body: string): Promise<string> {
  const server = createServer((_request, response) => response.writeHead(status, { "Content-Type": "application/json" }).end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
}

describe("D44.4-AC1 a healthy installation", () => {
  it("passes every offline check, prints no secret, and changes nothing", async () => {
    const instance = await startedInstallation();
    const before = snapshot(instance.dir);
    const result = await run(instance);
    expect(result.code).toBe(0);
    const report = reportOf(result.output);
    expect(report).toMatchObject({ event: "doctor", ok: true, online: null });
    expect(report.offline.checks.map((check) => [check.id, check.status])).toEqual([["environment", "pass"], ["instance", "pass"], ["options", "pass"], ["storage", "pass"], ["logs", "pass"], ["database", "pass"]]);
    expect(checkOf(report, "database").facts).toMatchObject({ schemaVersion: expect.any(Number) });
    for (const secret of instance.secrets) expect(result.output).not.toContain(secret);
    expect(snapshot(instance.dir)).toEqual(before);
    expect(reportOf((await run(instance)).output)).toEqual(report);
  });

  it("passes while the app runs, takes no lease, and leaves the app serving", async () => {
    const instance = await startedInstallation();
    const server = await serve(instance);
    const result = await run(instance, ["--online", "--url", server.baseUrl]);
    expect(result.code).toBe(0);
    const report = reportOf(result.output);
    expect(report.offline.ok).toBe(true);
    expect(report.online).toEqual({ ok: true, checks: [{ id: "health", status: "pass", facts: { httpStatus: 200 } }] });
    expect((await fetch(`${server.baseUrl}/api/health`)).status).toBe(200);
  });

  it("tells an app that is not there, one that is unavailable, one that answers something else and an address that is not one", async () => {
    const instance = await startedInstallation();
    const gone = await answering(200, '{"status":"ok"}');
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    const cases: Array<[string, string, string]> = [
      ["CONNECTION_FAILED", gone, ""],
      ["HEALTH_UNAVAILABLE", await answering(503, '{"status":"unavailable"}'), ""],
      ["HEALTH_UNEXPECTED", await answering(200, "<html>a proxy</html>"), ""],
      ["HEALTH_UNEXPECTED", await answering(200, '{"status":"maybe"}'), ""],
      ["URL_INVALID", "ftp://127.0.0.1/", ""],
      ["URL_INVALID", "http://user:pass@127.0.0.1:1/", ""],
      ["URL_INVALID", "not a url", ""],
    ];
    for (const [code, url] of cases) {
      const result = await run(instance, ["--online", "--url", url]);
      const report = reportOf(result.output);
      expect(result.code, `${code} ${url}`).toBe(1);
      expect(report.online?.checks[0], `${code} ${url}`).toMatchObject({ id: "health", status: "fail", code });
      // The offline group is its own: a failing online check does not touch it.
      expect(report.offline.ok, url).toBe(true);
    }
  });
});

describe("D44.4-AC2 a broken installation", () => {
  it("names the failing environment keys, skips what depends on it and prints no value", async () => {
    const instance = await startedInstallation();
    const before = snapshot(instance.dir);
    const withoutSecret = Object.fromEntries(Object.entries(instance.env).filter(([key]) => key !== "BETTER_AUTH_SECRET"));
    const result = await run(instance, [], { PATH: process.env["PATH"] ?? "", ...withoutSecret, BASE_URL: "" });
    expect(result.code).toBe(1);
    const report = reportOf(result.output);
    expect(checkOf(report, "environment")).toMatchObject({ status: "fail", fields: expect.arrayContaining(["BETTER_AUTH_SECRET", "BASE_URL"]) });
    expect(["options", "storage", "logs"].map((id) => checkOf(report, id).status)).toEqual(["skipped", "skipped", "skipped"]);
    for (const secret of instance.secrets) expect(result.output).not.toContain(secret);
    expect(snapshot(instance.dir)).toEqual(before);
  });

  it("tells missing metadata and skips the database", async () => {
    const instance = await startedInstallation();
    rmSync(instance.instanceFile);
    const result = await run(instance);
    expect(result.code).toBe(1);
    const report = reportOf(result.output);
    expect(checkOf(report, "instance")).toMatchObject({ status: "fail", code: "INSTANCE_METADATA_INVALID" });
    expect(checkOf(report, "database").status).toBe("skipped");
    expect(checkOf(report, "environment").status).toBe("pass");
  });

  it("tells a database that does not exist and creates nothing", async () => {
    const instance = freshTestInstance();
    const folderBefore = folders(instance.dir);
    const result = await run(instance);
    expect(result.code).toBe(1);
    expect(checkOf(reportOf(result.output), "database")).toMatchObject({ status: "fail", code: "DATABASE_MISSING" });
    expect(folders(instance.dir)).toEqual(folderBefore);
    expect(readdirSync(path.join(instance.dir, "data"))).not.toContain("app.db");
  });

  it("tells a database of another installation", async () => {
    const instance = await startedInstallation();
    const metadata = JSON.parse(readFileSync(instance.instanceFile, "utf8")) as Record<string, unknown>;
    writeFileSync(instance.instanceFile, JSON.stringify({ ...metadata, instanceId: "00000000-0000-4000-8000-000000000000" }));
    const result = await run(instance);
    expect(result.code).toBe(1);
    const database = checkOf(reportOf(result.output), "database");
    // The database names the installation it belongs to: another identity in the metadata is refused as that.
    expect(database).toMatchObject({ status: "fail", code: "INSTANCE_METADATA_INVALID" });
    expect(database.fields).toEqual(expect.arrayContaining(["instanceId"]));
  });

  it("tells a folder that cannot be used and a log folder that can only be warned of, repairing neither", async () => {
    const backups = await startedInstallation();
    rmSync(path.join(backups.dir, "data", "backup"), { recursive: true });
    writeFileSync(path.join(backups.dir, "data", "backup"), "a file where the folder belongs");
    const broken = await run(backups);
    expect(broken.code).toBe(1);
    expect(checkOf(reportOf(broken.output), "storage")).toMatchObject({ status: "fail", code: "STORAGE_UNWRITABLE", fields: ["backups"] });
    expect(checkOf(reportOf(broken.output), "logs").status).toBe("skipped");
    expect(readFileSync(path.join(backups.dir, "data", "backup"), "utf8")).toBe("a file where the folder belongs");

    const logs = await startedInstallation();
    rmSync(path.join(logs.dir, "data", "logs", "app"), { recursive: true });
    writeFileSync(path.join(logs.dir, "data", "logs", "app"), "a file where the folder belongs");
    const warned = await run(logs);
    expect(warned.code).toBe(0);
    expect(checkOf(reportOf(warned.output), "logs")).toMatchObject({ status: "warn", code: "LOG_SINK_UNAVAILABLE", fields: ["logs"] });
    expect(reportOf(warned.output).ok).toBe(true);
  });

  it("exits 2 with the usage for a wrong command line and does nothing else", async () => {
    const instance = await startedInstallation();
    const before = snapshot(instance.dir);
    for (const args of [["--url", "http://127.0.0.1:1"], ["--online", "--url"], ["--installation"], ["--unknown"], ["--installation", instance.dir, "--password", "x"]]) {
      const result = await runBuiltScript(DOCTOR, args, envOf(instance));
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.output).toContain("usage: doctor");
    }
    expect(snapshot(instance.dir)).toEqual(before);
  });
});
