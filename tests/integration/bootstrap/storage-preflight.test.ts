// D03.4-AC1/AC2 — storage preflight on a real file system, run by a non-root process.
// AC1: the create/read/delete probe and the paths CLI work in a folder with spaces and Unicode;
//      preparing the same folder again is refused and leaves data and keys untouched.
// AC2: a read-only, missing or symlinked-out critical directory stops the start with
//      STORAGE_UNWRITABLE; an unwritable log folder only degrades it, without secrets on stderr.
// Low disk space needs a size-limited file system and is covered in tests/system (container).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NotFreshDirectoryError, prepareTestInstance } from "../../support/test-instance.ts";
import { repoRoot, runBuiltScript, runServerEntry, startBuiltServer, waitForExit } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-preflight-"));
const restoreModes: string[] = [];
afterAll(() => {
  for (const dir of restoreModes) chmodSync(dir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const processEnv = (env: Readonly<Record<string, string>>) => ({ PATH: process.env["PATH"] ?? "", ...env });

async function expectRefused(instanceDir: string, env: Readonly<Record<string, string>>, fields: string[]): Promise<void> {
  const exit = await runServerEntry(["--port", "0", "--installation", instanceDir], processEnv(env));
  expect(exit.code).toBe(1);
  const failure = exit.output.split("\n").find((line) => line.includes('"bootstrap.failed"'));
  expect(failure, exit.output).toBeDefined();
  expect(JSON.parse(failure ?? "{}")).toEqual({ event: "bootstrap.failed", code: "STORAGE_UNWRITABLE", fields });
  expect(exit.output).not.toContain('"server.listening"');
}

describe("D03.4 preconditions", () => {
  it("permission checks run as a non-root process", () => {
    expect(process.getuid?.()).not.toBe(0);
  });
});

describe("D03.4-AC1 probe, paths and fresh folders", () => {
  const dir = path.join(root, "OpenLife Test", "Zażółć gęślą jaźń");
  const instance = prepareTestInstance(dir);

  it("the server starts on a folder with spaces and Unicode and leaves no probe files", async () => {
    const server = await startBuiltServer({ installation: instance });
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    expect(exit.code).toBe(0);
    expect(exit.output).toContain('"bootstrap.ready"');
    for (const sub of ["data", "data/backup", "data/tmp", "control/maintenance"]) {
      expect(readdirSync(path.join(dir, sub)).filter((name) => name.startsWith(".openlife-preflight-"))).toEqual([]);
    }
  });

  it("the paths CLI reads the same folder", async () => {
    const run = await runBuiltScript(path.join(repoRoot, "apps/server/dist/cli/paths.js"), ["--instance", instance.instanceFile], processEnv({}));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.output.trim()).host.database).toBe(path.join(dir, "data", "app.db"));
  });

  it("preparing the same folder again is refused without touching keys or metadata", async () => {
    const before = [sha256(instance.envFile), sha256(instance.instanceFile)];
    expect(() => prepareTestInstance(dir)).toThrow(NotFreshDirectoryError);
    const cli = await runBuiltScript(path.join(repoRoot, "scripts/prepare-test-instance.ts"), [dir], processEnv({}));
    expect(cli.code).toBe(1);
    expect(cli.output).toContain("test-instance.refused");
    expect([sha256(instance.envFile), sha256(instance.instanceFile)]).toEqual(before);
    for (const secret of instance.secrets) expect(cli.output.includes(secret)).toBe(false);
  });

  // POSIX mode bits; Windows ACLs are checked with the Windows installer (D59).
  it.runIf(process.platform !== "win32")("the generated .env is readable by its owner only (0600)", () => {
    expect(statSync(instance.envFile).mode & 0o777).toBe(0o600);
  });
});

describe("D03.4-AC2 critical directories stop the start", () => {
  it("a read-only backup folder → STORAGE_UNWRITABLE [backups]", async () => {
    const instance = prepareTestInstance(path.join(root, "read-only"));
    const backups = path.join(instance.dir, "data", "backup");
    chmodSync(backups, 0o555);
    restoreModes.push(backups);
    await expectRefused(instance.dir, instance.env, ["backups"]);
  });

  it("a tmp folder symlinked outside the data mount → STORAGE_UNWRITABLE [tmp]", async () => {
    const instance = prepareTestInstance(path.join(root, "symlink"));
    const outside = path.join(root, "outside-target");
    mkdirSync(outside);
    const tmp = path.join(instance.dir, "data", "tmp");
    rmdirSync(tmp);
    symlinkSync(outside, tmp, "dir");
    await expectRefused(instance.dir, instance.env, ["tmp"]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("a missing maintenance folder → STORAGE_UNWRITABLE [maintenance], nothing is created", async () => {
    const instance = prepareTestInstance(path.join(root, "missing"));
    const maintenance = path.join(instance.dir, "control", "maintenance");
    rmdirSync(maintenance);
    await expectRefused(instance.dir, instance.env, ["maintenance"]);
    expect(readdirSync(path.join(instance.dir, "control"))).toEqual(["instance.json"]);
  });

  it("an unwritable log folder only degrades the start; stderr carries no secret", async () => {
    const instance = prepareTestInstance(path.join(root, "logs-read-only"));
    const logs = path.join(instance.dir, "data", "logs", "app");
    chmodSync(logs, 0o555);
    restoreModes.push(logs);
    const server = await startBuiltServer({ installation: instance });
    const health = await fetch(`${server.baseUrl}/api/health`);
    expect(health.status).toBe(200);
    server.child.kill("SIGTERM");
    const exit = await waitForExit(server.child, server.output, 15_000);
    expect(exit.output).toContain('{"event":"bootstrap.degraded","code":"LOG_SINK_UNAVAILABLE","fields":["logs"]}');
    for (const secret of instance.secrets) expect(exit.output.includes(secret)).toBe(false);
  });
});
