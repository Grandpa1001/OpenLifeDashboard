// D03.3 — the built `paths` CLI (Architektura §15.3).
// AC1: valid POSIX/Windows metadata print host paths and the fixed container paths, without any
//      environment key or secret; running it again keeps the same instance ID and file.
// AC2: unknown version, missing or malformed metadata exit 1 naming the file and the container
//      paths, invent no host path and create no identity, secret, database or directory; the
//      host path from the metadata is never touched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBootstrapCases } from "../../support/bootstrap-cases.ts";
import { repoRoot, runBuiltScript } from "../../support/server-process.ts";

const PATHS_ENTRY = path.join(repoRoot, "apps/server/dist/cli/paths.js");
// Only PATH: the CLI must work without INSTALL_MODE, BASE_URL or any secret.
const BARE_ENV = { PATH: process.env["PATH"] ?? "" };
const baseline = loadBootstrapCases().baseline.instance;

let root: string;
let hostOnlyPath: string;

const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort();
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function writeInstance(name: string, content: unknown): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "instance.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "openlife-paths-"));
  // A host path that does not exist here: the CLI must describe it, never create or open it.
  hostOnlyPath = path.join(root, "host only", "Zażółć gęślą");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("D03.3-AC1 paths for valid metadata", () => {
  it("POSIX: host paths from metadata, fixed container paths, no env needed; restart keeps the ID", async () => {
    const file = writeInstance("posix", { ...baseline, installationPath: hostOnlyPath });
    const before = sha256(file);
    const runs = [await runBuiltScript(PATHS_ENTRY, ["--instance", file], BARE_ENV), await runBuiltScript(PATHS_ENTRY, ["--instance", file], BARE_ENV)];
    const outputs = runs.map((run) => {
      expect(run.code).toBe(0);
      return JSON.parse(run.output.trim()) as { instanceId: string; host: Record<string, string>; container: Record<string, string> };
    });
    expect(outputs[0]?.host["database"]).toBe(`${hostOnlyPath}/data/app.db`);
    expect(outputs[0]?.container["database"]).toBe("/data/app.db");
    expect(outputs[0]?.instanceId).toBe(baseline["instanceId"]);
    expect(outputs[1]?.instanceId).toBe(outputs[0]?.instanceId);
    expect(sha256(file)).toBe(before);
    expect(existsSync(hostOnlyPath)).toBe(false);
  });

  it("Windows: backslash host paths, container database stays /data/app.db", async () => {
    const file = writeInstance("windows", {
      ...baseline,
      hostPlatform: "windows",
      installationPath: "C:\\Users\\Test User\\OpenLifeDashboard\\Zażółć",
    });
    const run = await runBuiltScript(PATHS_ENTRY, ["--instance", file], BARE_ENV);
    expect(run.code).toBe(0);
    const output = JSON.parse(run.output.trim()) as { host: Record<string, string>; container: Record<string, string> };
    expect(output.host["database"]).toBe("C:\\Users\\Test User\\OpenLifeDashboard\\Zażółć\\data\\app.db");
    expect(output.container["database"]).toBe("/data/app.db");
  });
});

describe("D03.3-AC2 invalid metadata is refused without side effects", () => {
  it.each([
    ["unknown format version", { ...baseline, formatVersion: 2 }, ["formatVersion"]],
    ["malformed JSON", "{ broken", ["instance.json"]],
    ["missing file", null, ["instance.json"]],
  ])("%s → exit 1 naming the file and container paths, nothing created", async (label, content, fields) => {
    const dir = path.join(root, `invalid-${label.replace(/\s+/g, "-")}`);
    mkdirSync(dir, { recursive: true });
    const file = content === null ? path.join(dir, "instance.json") : writeInstance(path.basename(dir), content);
    const before = snapshot(dir);
    const run = await runBuiltScript(PATHS_ENTRY, ["--instance", file], BARE_ENV);
    expect(run.code).toBe(1);
    const output = JSON.parse(run.output.trim()) as Record<string, unknown>;
    expect(output["code"]).toBe("INSTANCE_METADATA_INVALID");
    expect(output["fields"]).toEqual(fields);
    expect(output["instanceFile"]).toBe(file);
    expect(output["container"]).toMatchObject({ database: "/data/app.db", instanceFile: "/instance/instance.json" });
    expect(output).not.toHaveProperty("host");
    expect(snapshot(dir)).toEqual(before);
  });
});
