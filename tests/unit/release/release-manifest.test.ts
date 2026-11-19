// D61.2-AC1/AC2 — the manifest of a release (packages/contracts/src/updates/release-manifest.ts): the shape the files of a release are checked
// against, and the catalog entry the installer or the administrator makes from it for the updater.
import { releaseCatalogSchema } from "@openlife/contracts/updates/catalog";
import { catalogReleaseFromManifest, isOlderVersion, releaseManifestSchema } from "@openlife/contracts/updates/release-manifest";
import { describe, expect, it } from "vitest";

const DIGEST = (character: string): string => `sha256:${character.repeat(64)}`;
const manifest = {
  v: 1,
  version: "1.4.0",
  buildRevision: "0123456789abcdef0123456789abcdef01234567",
  app: { repository: "ghcr.io/owner/openlifedashboard", digest: DIGEST("a") },
  updater: { repository: "ghcr.io/owner/openlifedashboard-updater", digest: DIGEST("b") },
  minFrom: "1.2.0",
  databaseSchemaVersion: 17,
};

describe("D61.2 the manifest of a release", () => {
  it("accepts the manifest of a release and the first release, which may be installed over nothing", () => {
    expect(releaseManifestSchema.safeParse(manifest).success).toBe(true);
    expect(releaseManifestSchema.safeParse({ ...manifest, version: "0.1.0", minFrom: null }).success).toBe(true);
  });

  it("makes the entry of the trusted catalog that the updater reads", () => {
    const entry = catalogReleaseFromManifest(releaseManifestSchema.parse(manifest));
    expect(entry).toEqual({ version: "1.4.0", app: manifest.app, updater: manifest.updater, minFrom: "1.2.0", schemaVersion: 17 });
    expect(releaseCatalogSchema.safeParse({ v: 1, releases: [entry] }).success).toBe(true);
  });

  it("orders versions as numbers, not as text", () => {
    expect(isOlderVersion("1.2.0", "1.10.0")).toBe(true);
    expect(isOlderVersion("1.10.0", "1.2.0")).toBe(false);
    expect(isOlderVersion("1.4.0", "1.4.0")).toBe(false);
    expect(isOlderVersion("0.9.9", "1.0.0")).toBe(true);
  });

  const faults: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["a version that is not x.y.z", { version: "1.4" }, "version"],
    ["a version with a suffix", { version: "1.4.0-rc1" }, "version"],
    ["a revision that is not a commit", { buildRevision: "main" }, "buildRevision"],
    ["a digest without sha256", { app: { repository: "ghcr.io/o/a", digest: "abc" } }, "digest"],
    ["a digest of the wrong length", { updater: { repository: "ghcr.io/o/b", digest: "sha256:abcd" } }, "digest"],
    ["a minFrom equal to the version", { minFrom: "1.4.0" }, "minFrom"],
    ["a minFrom newer than the version", { minFrom: "1.5.0" }, "minFrom"],
    ["the same repository for both images", { updater: { repository: "ghcr.io/owner/openlifedashboard", digest: DIGEST("b") } }, "repository"],
    ["no database schema version", { databaseSchemaVersion: 0 }, "databaseSchemaVersion"],
    ["another format", { v: 2 }, "v"],
    ["a field that is not part of it", { extra: true }, "extra"],
  ];
  for (const [name, change, field] of faults) {
    it(`refuses ${name}`, () => {
      const result = releaseManifestSchema.safeParse({ ...manifest, ...change });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(field);
    });
  }
});
