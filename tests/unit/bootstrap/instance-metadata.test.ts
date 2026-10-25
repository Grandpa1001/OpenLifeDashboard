// D03.3 — instance.json v1 and installation paths (Architektura §14.5, §15.1).
// AC1: F08 D03.3 cases through the bootstrap (env → metadata → settings); POSIX and Windows
//      metadata give descriptive host paths and the fixed container database path.
// AC2: unknown version, mode mismatch, missing or malformed metadata are refused with
//      INSTANCE_METADATA_INVALID and the offending fields.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTAINER_PATHS, describeInstallation } from "../../../apps/server/src/adapters/filesystem/installation-paths.js";
import { loadBootstrapConfig } from "../../../apps/server/src/bootstrap/bootstrap-config.js";
import { parseInstanceMetadata, readInstanceMetadata } from "../../../apps/server/src/bootstrap/instance-metadata.js";
import { environmentFor, loadBootstrapCases } from "../../support/bootstrap-cases.ts";

const fixture = loadBootstrapCases();
const baselineInstance = fixture.baseline.instance;
const cases = fixture.cases.filter((testCase) => testCase.task === "D03.3");
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-instance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function writeInstance(name: string, content: unknown): string {
  const file = path.join(scratch, `${name}.json`);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("D03.3-AC1/AC2 F08 cases through the bootstrap", () => {
  it("covers every D03.3 case of the fixture", () => {
    expect(cases.map((testCase) => testCase.id)).toEqual([
      "unknown-instance-format",
      "instance-mode-disagrees-with-environment",
      "windows-host-path-is-descriptive-metadata",
    ]);
  });

  it.each(cases)("$id", (testCase) => {
    const { env } = environmentFor(fixture, testCase);
    const instanceFile = writeInstance(testCase.id, { ...baselineInstance, ...testCase.instancePatch });
    const result = loadBootstrapConfig({ env, instanceFile });
    const expected = testCase.expected;
    if (expected.kind === "error") {
      expect(result).toEqual({ ok: false, code: expected.code, fields: [...expected.fields].sort() });
    } else {
      expect(result.ok).toBe(true);
      expect(result.ok && result.config.paths.container.database).toBe(expected.containerDatabasePath);
    }
  });
});

describe("D03.3-AC1 descriptive host paths", () => {
  it("POSIX metadata joins host paths with forward slashes, keeping spaces and Unicode", () => {
    const parsed = parseInstanceMetadata(baselineInstance);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const paths = describeInstallation(parsed.metadata);
      expect(paths.host.database).toBe("/tmp/OpenLife Test/Zażółć/data/app.db");
      expect(paths.host.instanceFile).toBe("/tmp/OpenLife Test/Zażółć/control/instance.json");
      expect(paths.container).toEqual(CONTAINER_PATHS);
      expect(paths.container.database).toBe("/data/app.db");
    }
  });

  it("Windows metadata keeps backslashes; the container path stays /data/app.db", () => {
    const parsed = parseInstanceMetadata({
      ...baselineInstance,
      hostPlatform: "windows",
      installationPath: "C:\\Users\\Test User\\OpenLifeDashboard\\Zażółć",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const paths = describeInstallation(parsed.metadata);
      expect(paths.host.database).toBe("C:\\Users\\Test User\\OpenLifeDashboard\\Zażółć\\data\\app.db");
      expect(paths.host.logs).toBe("C:\\Users\\Test User\\OpenLifeDashboard\\Zażółć\\data\\logs\\app");
      expect(paths.container.database).toBe("/data/app.db");
    }
  });

  it("reading the same file again yields the same identity (restart keeps the ID)", () => {
    const file = writeInstance("restart", baselineInstance);
    const first = readInstanceMetadata(file);
    const second = readInstanceMetadata(file);
    expect(first.ok && second.ok && first.metadata.instanceId === second.metadata.instanceId).toBe(true);
  });
});

describe("D03.3-AC2 invalid metadata is refused", () => {
  const field = (patch: Record<string, unknown>) => parseInstanceMetadata({ ...baselineInstance, ...patch });

  it.each([
    ["an extra field", { secret: "x" }, ["secret"]],
    ["a UUIDv7 instead of a random UUIDv4", { instanceId: "019a0000-0000-7000-8000-000000000001" }, ["instanceId"]],
    ["an unknown install mode", { installMode: "cloud" }, ["installMode"]],
    ["a project name outside openlife-<12 hex>", { composeProjectName: "openlife-prod" }, ["composeProjectName"]],
    ["an unknown host platform", { hostPlatform: "macos" }, ["hostPlatform"]],
    ["a relative POSIX path", { installationPath: "OpenLife/data" }, ["installationPath"]],
    ["a Windows path without a drive", { hostPlatform: "windows", installationPath: "\\OpenLife" }, ["installationPath"]],
    ["a POSIX path declared as Windows", { hostPlatform: "windows", installationPath: "/srv/openlife" }, ["installationPath"]],
    ["a non-UTC timestamp", { createdAt: "2026-10-23T12:00:00+02:00" }, ["createdAt"]],
    ["a rolled-over calendar date", { createdAt: "2026-02-31T12:00:00Z" }, ["createdAt"]],
    ["formatVersion 2", { formatVersion: 2 }, ["formatVersion"]],
    ["formatVersion as text", { formatVersion: "1" }, ["formatVersion"]],
  ])("%s", (_label, patch, fields) => {
    expect(field(patch)).toEqual({ ok: false, code: "INSTANCE_METADATA_INVALID", fields });
  });

  it.each([
    ["a missing file", null],
    ["invalid JSON", "{ not json"],
    ["a JSON array", "[]"],
  ])("%s → the file itself is reported", (_label, content) => {
    const file = content === null ? path.join(scratch, "does-not-exist.json") : writeInstance(`bad-${_label.length}`, content);
    expect(readInstanceMetadata(file)).toEqual({ ok: false, code: "INSTANCE_METADATA_INVALID", fields: ["instance.json"] });
  });
});
