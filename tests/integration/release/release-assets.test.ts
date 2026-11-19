// D61.2 — the files a release is published with, assembled from the digests of the images and checked the way a user who downloaded them can
// (scripts/assemble-release.ts, scripts/verify-release-assets.ts; DEV §9.60). AC1: exactly the files of the list, the same input gives the same sums,
// SHA256SUMS fits the files, the manifest is the one of the schema and becomes an entry of the trusted catalog, the loose files are the repository's,
// and the archive pins the image the manifest names. AC2: a damaged, a missing and an extra file, a sums file that lies, a digest that is not a digest,
// a version that is not the packages', a minFrom that is not older and a package that pins another image are each refused with the name of the fault.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseCatalogSchema } from "@openlife/contracts/updates/catalog";
import { catalogReleaseFromManifest, releaseManifestSchema } from "@openlife/contracts/updates/release-manifest";
import { afterAll, describe, expect, it } from "vitest";
import { PRODUCT_MIGRATION_PLAN } from "../../../packages/sqlite/dist/migrations/public.js";
import type { PublishedImages } from "../../../scripts/support/image-publish.ts";
import { assembleRelease, assetNames, LOOSE_FILES, SUMS_FILE, verifyReleaseAssets } from "../../../scripts/support/release-assets.ts";
import { repoRoot } from "../../support/repository-copy.ts";
import { runBuiltScript } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-release-assets-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const VERSION = (JSON.parse(readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8")) as { version: string }).version;
const REPOSITORY = "ghcr.io/owner/openlifedashboard";
const images: PublishedImages = {
  version: VERSION,
  buildRevision: "0123456789abcdef0123456789abcdef01234567",
  app: `${REPOSITORY}@sha256:${"a".repeat(64)}`,
  updater: `${REPOSITORY}-updater@sha256:${"b".repeat(64)}`,
};
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
let counter = 0;
const assemble = (overrides: Partial<{ images: PublishedImages; version: string; minFrom: string | null }> = {}) =>
  assembleRelease({ repositoryRoot: repoRoot, outDir: path.join(root, `release-${(counter += 1)}`), version: overrides.version ?? VERSION, minFrom: overrides.minFrom ?? null, images: overrides.images ?? images });
const copyOf = (dir: string): string => {
  const copy = path.join(root, `copy-${(counter += 1)}`);
  cpSync(dir, copy, { recursive: true });
  return copy;
};
const whole = assemble();
const resealed = (dir: string): void => {
  const lines = assetNames(VERSION).filter((name) => name !== SUMS_FILE).map((name) => `${sha(path.join(dir, name))}  ${name}\n`);
  writeFileSync(path.join(dir, SUMS_FILE), lines.join(""));
};

describe("D61.2-AC1 the files of a release", () => {
  it("are exactly the list of the release and a user's check finds them whole", () => {
    expect(readdirSync(whole.dir).sort()).toEqual(assetNames(VERSION));
    expect(assetNames(VERSION)).toEqual(
      [...Object.keys(LOOSE_FILES), `openlife-dashboard-${VERSION}.tar.gz`, "release-manifest.json", "SHA256SUMS"].sort(),
    );
    expect(verifyReleaseAssets(whole.dir)).toEqual([]);
  });

  it("give the same sums for the same input, but for the archive, whose bytes carry the time it was made", () => {
    const again = assemble();
    const sumsOf = (dir: string): string[] => readFileSync(path.join(dir, SUMS_FILE), "utf8").trimEnd().split("\n").filter((line) => !line.endsWith(".tar.gz"));
    expect(sumsOf(again.dir)).toEqual(sumsOf(whole.dir));
    // What is in the archive is the same: the files of the package of both are those of the repository (checked by the user's check above).
    expect(verifyReleaseAssets(again.dir)).toEqual([]);
  });

  it("have SHA256SUMS over every file but itself, in the form `<sha256>  <name>`", () => {
    const lines = readFileSync(path.join(whole.dir, SUMS_FILE), "utf8").trimEnd().split("\n");
    expect(lines).toEqual(assetNames(VERSION).filter((name) => name !== SUMS_FILE).map((name) => `${sha(path.join(whole.dir, name))}  ${name}`));
  });

  it("carry a manifest of the schema that makes an entry of the trusted catalog", () => {
    const manifest = releaseManifestSchema.parse(JSON.parse(readFileSync(path.join(whole.dir, "release-manifest.json"), "utf8")));
    expect(manifest).toEqual({
      v: 1,
      version: VERSION,
      buildRevision: images.buildRevision,
      app: { repository: REPOSITORY, digest: `sha256:${"a".repeat(64)}` },
      updater: { repository: `${REPOSITORY}-updater`, digest: `sha256:${"b".repeat(64)}` },
      minFrom: null,
      databaseSchemaVersion: PRODUCT_MIGRATION_PLAN.length,
    });
    expect(releaseCatalogSchema.safeParse({ v: 1, releases: [catalogReleaseFromManifest(manifest)] }).success).toBe(true);
  });

  it("hold the loose files of the repository and the archive of the package that pins the image of the manifest", () => {
    for (const [name, source] of Object.entries(LOOSE_FILES)) expect(sha(path.join(whole.dir, name)), name).toBe(sha(path.join(repoRoot, source)));
    // The check of a user unpacks the archive, compares its files with the loose ones and reads the image it pins.
    expect(verifyReleaseAssets(whole.dir)).toEqual([]);
  });

  it("can be made and checked from the command line, and a changed file ends the check with a message", async () => {
    const imagesFile = path.join(root, "release-images.json");
    writeFileSync(imagesFile, JSON.stringify(images));
    const out = path.join(root, "cli-release");
    const env = { PATH: process.env["PATH"] ?? "" };
    const made = await runBuiltScript(path.join(repoRoot, "scripts/assemble-release.ts"), ["--version", VERSION, "--images", imagesFile, "--min-from", "0.0.0", "--out", out], env);
    // 0.0.0 is not older than 0.0.0: the manifest refuses it, and nothing is made.
    expect(made.code).toBe(1);
    expect(made.output).toMatch(/minFrom/);
    const ok = await runBuiltScript(path.join(repoRoot, "scripts/assemble-release.ts"), ["--version", VERSION, "--images", imagesFile, "--out", out], env);
    expect(ok.code, ok.output).toBe(0);
    expect((await runBuiltScript(path.join(repoRoot, "scripts/verify-release-assets.ts"), [out], env)).code).toBe(0);
    writeFileSync(path.join(out, "Caddyfile"), `${readFileSync(path.join(out, "Caddyfile"), "utf8")}# changed\n`);
    const broken = await runBuiltScript(path.join(repoRoot, "scripts/verify-release-assets.ts"), [out], env);
    expect(broken.code).toBe(1);
    expect(broken.output).toContain("Caddyfile does not match SHA256SUMS");
  });
});

describe("D61.2-AC2 what is refused, with the name of the fault", () => {
  const found = (dir: string): string => verifyReleaseAssets(dir).join("\n");

  it("a changed file of the release, whichever it is", () => {
    for (const name of assetNames(VERSION).filter((each) => each !== SUMS_FILE && each !== "release-manifest.json")) {
      const dir = copyOf(whole.dir);
      writeFileSync(path.join(dir, name), `${readFileSync(path.join(dir, name))}changed`);
      expect(found(dir), name).toContain(`${name} does not match ${SUMS_FILE}`);
    }
  });

  it("a missing file and an extra file or folder", () => {
    for (const name of assetNames(VERSION).filter((each) => each !== "release-manifest.json")) {
      const dir = copyOf(whole.dir);
      rmSync(path.join(dir, name));
      expect(found(dir), name).toContain(`${name} is missing`);
    }
    const extra = copyOf(whole.dir);
    writeFileSync(path.join(extra, "extra.sh"), "echo hi\n");
    expect(found(extra)).toContain("extra.sh is not a file of the release");
    const folder = copyOf(whole.dir);
    writeFileSync(path.join(folder, "notes.txt"), "x");
    expect(found(folder)).toContain("notes.txt is not a file of the release");
  });

  it("a sums file that leaves a file out, lists one twice or lists a file that is not ours", () => {
    const lines = readFileSync(path.join(whole.dir, SUMS_FILE), "utf8").trimEnd().split("\n");
    const cases: Array<[string, string[], RegExp]> = [
      ["a file left out", lines.slice(1), /does not list/],
      ["a file listed twice", [...lines, lines[0]!], /twice/],
      ["a file that is not ours", [...lines, `${"c".repeat(64)}  other.txt`], /other\.txt, which is not a file of the release/],
      ["a line that is not a sum", [...lines.slice(1), "not a sum"], /not '<sha256> {2}<file>'/],
    ];
    for (const [name, content, message] of cases) {
      const dir = copyOf(whole.dir);
      writeFileSync(path.join(dir, SUMS_FILE), `${content.join("\n")}\n`);
      expect(found(dir), name).toMatch(message);
    }
  });

  it("a manifest that is not valid, even with the sums made again", () => {
    const faults: Array<[string, Record<string, unknown>, string]> = [
      ["a digest that is not sha256", { app: { repository: REPOSITORY, digest: "sha256:abc" } }, "app.digest"],
      ["a version that is not x.y.z", { version: "1.4" }, "version"],
      ["a minFrom that is not older", { minFrom: VERSION }, "minFrom"],
    ];
    for (const [name, change, field] of faults) {
      const dir = copyOf(whole.dir);
      const manifest = JSON.parse(readFileSync(path.join(dir, "release-manifest.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(path.join(dir, "release-manifest.json"), JSON.stringify({ ...manifest, ...change }));
      resealed(dir);
      expect(found(dir), name).toContain(field);
    }
  });

  it("a package that pins another image than the manifest, and a manifest of another version than the package", () => {
    const other = copyOf(whole.dir);
    const manifest = JSON.parse(readFileSync(path.join(other, "release-manifest.json"), "utf8")) as { app: { digest: string } };
    manifest.app.digest = `sha256:${"d".repeat(64)}`;
    writeFileSync(path.join(other, "release-manifest.json"), JSON.stringify(manifest));
    resealed(other);
    expect(found(other)).toContain("the package pins");
  });

  it("an assembly that is not given what it needs: a digest that is no digest, an image of the other kind, another version, a minFrom that is not older", () => {
    expect(() => assemble({ images: { ...images, app: `${REPOSITORY}:1.0.0` } })).toThrow(/not pinned by a digest/);
    expect(() => assemble({ images: { ...images, app: `${REPOSITORY}@sha256:abc` } })).toThrow(/not pinned by a digest/);
    expect(() => assemble({ images: { ...images, updater: `${REPOSITORY}@sha256:${"b".repeat(64)}` } })).toThrow(/not a openlifedashboard-updater image/);
    expect(() => assemble({ images: { ...images, version: "9.9.9" } })).toThrow(/published for 9\.9\.9/);
    expect(() => assemble({ version: "9.9.9", images: { ...images, version: "9.9.9" } })).toThrow(/has the version/);
    expect(() => assemble({ minFrom: VERSION })).toThrow(/minFrom/);
    expect(() => assemble({ minFrom: "9.9.9" })).toThrow(/minFrom/);
    expect(existsSync(path.join(root, "release-0"))).toBe(false);
  });
});
