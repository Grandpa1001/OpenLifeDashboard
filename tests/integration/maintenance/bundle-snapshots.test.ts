// D48.1 — the package of scope `bundle` (Architektura §11.3.1, §11.4): app.db, export.json, meta.json and
// checksums.json of ONE state, on a real installation holding the F01 fixture.
// AC1: the published package holds exactly the four files; its export.json is the export of F01 in its
//      canonical form and is accepted by the parser; it is made from the copy, so a record written to the
//      live database after the copy is in neither file; the package is found again by its operation.
// AC2: a changed byte of export.json, a missing or an extra file, a bundle without a checksum of export.json
//      and an export.json of another format version make the package invalid with the part named; an exporter
//      that fails publishes nothing and leaves no staging; a store without an exporter refuses a bundle; a
//      package of scope `database` stays three files and an extra export.json makes it invalid.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundleSnapshotMetaSchema } from "@openlife/contracts/backups/database-snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseSnapshots, SNAPSHOT_STAGING_DIR, verifyDatabaseSnapshot } from "../../../apps/server/dist/adapters/filesystem/database-snapshots.js";
import { canonicalExport } from "../../../apps/server/dist/portability/canonical.js";
import { parseExportFile } from "../../../apps/server/dist/portability/parse-export.js";
import { DEFAULT_CONFIG_LIMITS } from "../../../packages/core/src/modules/configuration/public.js";
import { DEFAULT_DICTIONARY_LIMITS } from "../../../packages/core/src/modules/dictionaries/public.js";
import { DEFAULT_REGISTRY_LIMITS } from "../../../packages/core/src/modules/registries/public.js";
import { openDatabase } from "../../../packages/sqlite/dist/connection/open-database.js";
import { closeHarnesses, createAppHarness, type AppHarness } from "../../support/app-harness.ts";
import { F01, F01_TEXT, loadFixture } from "../../support/export-fixture.ts";

afterEach(closeHarnesses);

const LIMITS = { maxBytes: 100 * 1024 * 1024, registry: DEFAULT_REGISTRY_LIMITS, dictionary: DEFAULT_DICTIONARY_LIMITS, config: DEFAULT_CONFIG_LIMITS, recordMaxBytes: 192 * 1024 };
const parsedOk = (text: string) => {
  const result = parseExportFile(text, LIMITS);
  if (!result.ok) throw new Error(`the export is not accepted: ${JSON.stringify(result.issues.slice(0, 3))}`);
  return result.file;
};
const request = (scope: "database" | "bundle") => ({ reason: "manual", scope, operationId: randomUUID(), fence: 1 }) as const;
const published = (h: AppHarness): string[] => readdirSync(h.backupsDir).filter((name) => !name.startsWith(".")).sort().map((name) => path.join(h.backupsDir, name));
const readMeta = (dir: string) => JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")) as Record<string, unknown>;

async function withFixture(): Promise<AppHarness> {
  const h = await createAppHarness();
  loadFixture(h);
  return h;
}

async function bundleOf(h: AppHarness): Promise<string> {
  const result = await h.snapshots.create(request("bundle"));
  expect(result.ok).toBe(true);
  const [dir] = published(h);
  return dir!;
}

describe("D48.1-AC1 a bundle is one state in four files", () => {
  it("holds exactly app.db, export.json, meta.json and checksums.json, verifies, and names the format version", async () => {
    const h = await withFixture();
    const dir = await bundleOf(h);
    expect(readdirSync(dir).sort()).toEqual(["app.db", "checksums.json", "export.json", "meta.json"]);
    const verification = verifyDatabaseSnapshot(dir);
    expect(verification.ok).toBe(true);
    const meta = bundleSnapshotMetaSchema.parse(readMeta(dir));
    expect([meta.scope, meta.reason, meta.formatVersion]).toEqual(["bundle", "manual", 1]);
  });

  it("has an export.json that is the export of F01 in its canonical form and that the parser accepts", async () => {
    const h = await withFixture();
    const dir = await bundleOf(h);
    const file = parsedOk(readFileSync(path.join(dir, "export.json"), "utf8"));
    // The version of the app that wrote the file is the one thing that differs from the fixture.
    expect(canonicalExport({ ...file, appVersion: F01.appVersion })).toBe(canonicalExport(parsedOk(F01_TEXT)));
    expect(file.registries.flatMap((registry) => registry.records).length).toBe(F01.registries.flatMap((registry) => registry.records).length);
  });

  it("is made from the copy: a record written to the live database after the copy is in neither file", async () => {
    const h = await withFixture();
    const before = h.rows<{ n: number }>("SELECT COUNT(*) AS n FROM reg_ksiazki")[0]!.n;
    let sawWrite = false;
    const store = createDatabaseSnapshotsAround(h, () => {
      // Runs while the export of the copy is being written: the live database moves on.
      const result = h.elsewhere.run((ports) => {
        const registry = ports.registries.find("owner-1", "ksiazki");
        if (registry === null) throw new Error("no such registry");
        ports.records.insert(registry, { id: "019b0000-0000-7000-8000-00000000ffff", registryId: registry.id, ownerId: "owner-1", revision: 1, createdAt: "2026-10-03T10:00:00Z", updatedAt: "2026-10-03T10:00:00Z", values: { tytul: "Po kopii" } });
        return { value: null, invalidations: [] };
      });
      expect(result.ok).toBe(true);
      sawWrite = true;
    });
    expect((await store.create(request("bundle"))).ok).toBe(true);
    expect(sawWrite).toBe(true);
    const [dir] = published(h);
    const exported = parsedOk(readFileSync(path.join(dir!, "export.json"), "utf8"));
    expect(exported.registries.flatMap((registry) => registry.records).length).toBe(before);
    const copy = openDatabase(path.join(dir!, "app.db"), { role: "reader", busyTimeoutMs: 5000, journal: "delete" });
    try {
      expect((copy.handle.prepare("SELECT COUNT(*) AS n FROM reg_ksiazki").get() as { n: number }).n).toBe(before);
    } finally {
      copy.close();
    }
    expect(h.rows<{ n: number }>("SELECT COUNT(*) AS n FROM reg_ksiazki")[0]!.n).toBe(before + 1);
  });

  it("is found again by its operation and is not found by another", async () => {
    const h = await withFixture();
    const operationId = randomUUID();
    expect((await h.snapshots.create({ reason: "manual", scope: "bundle", operationId, fence: 1 })).ok).toBe(true);
    expect((await h.snapshots.findPublished(operationId))?.schemaVersion).toBeGreaterThan(0);
    expect(await h.snapshots.findPublished(randomUUID())).toBeUndefined();
  });
});

describe("D48.1-AC2 a damaged or unfinished bundle is not a bundle", () => {
  it("names export.json when a byte of it changes and the checksum no longer agrees", async () => {
    const h = await withFixture();
    const dir = await bundleOf(h);
    const file = path.join(dir, "export.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("Książki", "Ksiązki"));
    expect(verifyDatabaseSnapshot(dir)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields: ["export.json"] });
  });

  it("calls the files wrong when export.json is missing from a bundle or present in a database package", async () => {
    const h = await withFixture();
    const dir = await bundleOf(h);
    rmSync(path.join(dir, "export.json"));
    expect(verifyDatabaseSnapshot(dir)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields: ["files"] });
    const h2 = await withFixture();
    expect((await h2.snapshots.create(request("database"))).ok).toBe(true);
    const [database] = published(h2);
    expect(readdirSync(database!).sort()).toEqual(["app.db", "checksums.json", "meta.json"]);
    writeFileSync(path.join(database!, "export.json"), "{}");
    expect(verifyDatabaseSnapshot(database!)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields: ["files"] });
  });

  it("refuses a bundle whose checksums do not list export.json, and one whose export.json is of another format version", async () => {
    const h = await withFixture();
    const dir = await bundleOf(h);
    const checksumsFile = path.join(dir, "checksums.json");
    const checksums = JSON.parse(readFileSync(checksumsFile, "utf8")) as { files: Record<string, string> };
    delete checksums.files["export.json"];
    writeFileSync(checksumsFile, JSON.stringify(checksums));
    expect(verifyDatabaseSnapshot(dir)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields: ["checksums.json"] });
    const h2 = await withFixture();
    const other = await bundleOf(h2);
    const meta = readMeta(other);
    // The meta and its checksum agree with each other but name a version the export.json does not have.
    meta["formatVersion"] = 2;
    const metaText = `${JSON.stringify(meta, null, 2)}\n`;
    writeFileSync(path.join(other, "meta.json"), metaText);
    const sums = JSON.parse(readFileSync(path.join(other, "checksums.json"), "utf8")) as { files: Record<string, string> };
    const { createHash } = await import("node:crypto");
    sums.files["meta.json"] = createHash("sha256").update(metaText).digest("hex");
    writeFileSync(path.join(other, "checksums.json"), JSON.stringify(sums));
    expect(verifyDatabaseSnapshot(other)).toEqual({ ok: false, code: "SNAPSHOT_INVALID", fields: ["export.json"] });
  });

  it("publishes nothing and leaves no staging when the export fails, and refuses a bundle without an exporter", async () => {
    const h = await withFixture();
    const failing = createDatabaseSnapshots(h.connection, { ...storeOptions(h), exportOfCopy: () => failingChunks() });
    expect(await failing.create(request("bundle"))).toEqual({ ok: false, code: "SNAPSHOT_FAILED" });
    expect(published(h)).toEqual([]);
    expect(readdirSync(path.join(h.backupsDir, SNAPSHOT_STAGING_DIR))).toEqual([]);
    const without = createDatabaseSnapshots(h.connection, storeOptions(h));
    expect(await without.create(request("bundle"))).toEqual({ ok: false, code: "SNAPSHOT_UNAVAILABLE" });
    expect(published(h)).toEqual([]);
  });
});

async function* failingChunks(): AsyncGenerator<string> {
  yield '{"format": "openlifedashboard-export",\n';
  throw new Error("the export stopped");
}

function storeOptions(h: AppHarness) {
  return {
    backupsDir: h.backupsDir,
    reserveMiB: 0,
    instanceId: h.instanceId,
    build: { appVersion: "0.0.0", buildRevision: "test", imageDigest: null },
    now: () => new Date().toISOString(),
    newSnapshotId: randomUUID,
  };
}

/** A store whose export of the copy runs `during` once, before it reads the copy. */
function createDatabaseSnapshotsAround(h: AppHarness, during: () => void) {
  return createDatabaseSnapshots(h.connection, {
    ...storeOptions(h),
    exportOfCopy: (copyFile, exportedAt) => (async function* () {
      during();
      const { exportOfCopy } = await import("../../../apps/server/dist/portability/bundle-export.js");
      yield* exportOfCopy(copyFile, { busyTimeoutMs: 5000, appVersion: "0.0.0", exportedAt });
    })(),
  });
}
