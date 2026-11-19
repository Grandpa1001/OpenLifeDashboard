// The files a release is published with (Architektura Załącznik I; DEV §9.60 D61.2): the installers, the Compose files, the Caddyfile, `.env.example`, the
// package of D58.1 (the archive that pins the image of the release), `release-manifest.json` (the images and what the release may be installed over) and
// SHA256SUMS over all the others. `assembleRelease` makes the folder from the digests of D61.1; `verifyReleaseAssets` checks a folder the way a user
// who downloaded it can: exactly these files, every sum, the manifest, and that the archive pins the image the manifest names.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RELEASE_MANIFEST_FILE, RELEASE_MANIFEST_MAX_BYTES, releaseManifestSchema, type ReleaseManifest } from "@openlife/contracts/updates/release-manifest";
import { assertRepositoryVersion, DIGEST_PATTERN, IMAGES, type PublishedImages } from "./image-publish.ts";
import { buildReleasePackage, MANIFEST_FILE as PACKAGE_MANIFEST_FILE } from "./release-package.ts";

export const SUMS_FILE = "SHA256SUMS";
/** The loose files of a release and where each comes from in the repository. */
export const LOOSE_FILES: Readonly<Record<string, string>> = {
  Caddyfile: "docker/Caddyfile",
  "compose.local.yml": "docker/compose.local.yml",
  "compose.server.yml": "docker/compose.server.yml",
  "compose.yml": "docker/compose.yml",
  "install.ps1": "install/install.ps1",
  "install.sh": "install/install.sh",
  ".env.example": ".env.example",
};
export const archiveName = (version: string): string => `openlife-dashboard-${version}.tar.gz`;
/** Every file of the release of a version, SHA256SUMS included, in the order of their names. */
export const assetNames = (version: string): string[] => [...Object.keys(LOOSE_FILES), archiveName(version), RELEASE_MANIFEST_FILE, SUMS_FILE].sort();

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The number of migrations of this checkout: the version of the database schema the release writes (the files are 0001-..., 0002-... without a gap). */
export function databaseSchemaVersion(repositoryRoot: string): number {
  const numbers = readdirSync(path.join(repositoryRoot, "packages/sqlite/src/migrations")).flatMap((name) => {
    const match = /^(\d{4})-.+\.ts$/.exec(name);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  numbers.sort((a, b) => a - b);
  if (numbers.length === 0 || numbers.some((value, index) => value !== index + 1)) throw new Error("the migrations of packages/sqlite are not numbered 0001 upward without a gap");
  return numbers.length;
}

/** `repository@sha256:digest` as the pin of the manifest, or an error that names the image. */
function pinOf(name: string, key: keyof typeof IMAGES, image: string): { repository: string; digest: string } {
  const at = image.lastIndexOf("@");
  const repository = at < 0 ? "" : image.slice(0, at);
  const digest = at < 0 ? "" : image.slice(at + 1);
  if (!DIGEST_PATTERN.test(digest)) throw new Error(`the ${name} image is not pinned by a digest (name@sha256:<64 hex>): ${image}`);
  if (!repository.endsWith(`/${IMAGES[key].name}`)) throw new Error(`the ${name} image is not a ${IMAGES[key].name} image: ${repository}`);
  return { repository, digest };
}

export type AssembleOptions = Readonly<{ repositoryRoot: string; outDir: string; version: string; minFrom: string | null; images: PublishedImages }>;

export function assembleRelease(options: AssembleOptions): Readonly<{ dir: string; files: readonly string[]; manifest: ReleaseManifest }> {
  assertRepositoryVersion(options.repositoryRoot, options.version);
  if (options.images.version !== options.version) throw new Error(`the images were published for ${options.images.version}, not ${options.version}`);
  const manifest = releaseManifestSchema.parse({
    v: 1,
    version: options.version,
    buildRevision: options.images.buildRevision,
    app: pinOf("app", "app", options.images.app),
    updater: pinOf("updater", "updater", options.images.updater),
    minFrom: options.minFrom,
    databaseSchemaVersion: databaseSchemaVersion(options.repositoryRoot),
  });
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });
  for (const [name, source] of Object.entries(LOOSE_FILES)) copyFileSync(path.join(options.repositoryRoot, source), path.join(options.outDir, name));
  // The package is the one of D58.1, made for the digest of the app image; only its archive is a file of the release.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-assemble-"));
  try {
    const built = buildReleasePackage({ repositoryRoot: options.repositoryRoot, outDir: scratch, version: options.version, image: `${manifest.app.repository}@${manifest.app.digest}` });
    copyFileSync(built.archive, path.join(options.outDir, archiveName(options.version)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(path.join(options.outDir, RELEASE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = assetNames(options.version)
    .filter((name) => name !== SUMS_FILE)
    .map((name) => `${sha256(path.join(options.outDir, name))}  ${name}\n`)
    .join("");
  writeFileSync(path.join(options.outDir, SUMS_FILE), sums);
  return { dir: options.outDir, files: assetNames(options.version), manifest };
}

/** What is wrong with a downloaded folder of a release, one sentence each; empty when it is whole. */
export function verifyReleaseAssets(dir: string): string[] {
  const problems: string[] = [];
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return [`${dir} is not a folder`];
  const manifestFile = path.join(dir, RELEASE_MANIFEST_FILE);
  if (!existsSync(manifestFile) || lstatSync(manifestFile).size > RELEASE_MANIFEST_MAX_BYTES) return [`${RELEASE_MANIFEST_FILE} is missing or larger than ${RELEASE_MANIFEST_MAX_BYTES} bytes`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    return [`${RELEASE_MANIFEST_FILE} is not JSON`];
  }
  const checked = releaseManifestSchema.safeParse(parsed);
  if (!checked.success) return checked.error.issues.map((issue) => `${RELEASE_MANIFEST_FILE}: ${issue.path.join(".") || "(the file)"}: ${issue.message}`);
  const manifest = checked.data;

  const expected = assetNames(manifest.version);
  const present = readdirSync(dir).sort();
  for (const name of expected) {
    const file = path.join(dir, name);
    if (!existsSync(file) || !lstatSync(file).isFile()) problems.push(`${name} is missing or is not a plain file`);
  }
  for (const name of present) if (!expected.includes(name)) problems.push(`${name} is not a file of the release`);
  if (problems.length > 0) return problems;

  const listed = new Map<string, string>();
  for (const line of readFileSync(path.join(dir, SUMS_FILE), "utf8").split("\n").filter((each) => each !== "")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) problems.push(`${SUMS_FILE} has a line that is not '<sha256>  <file>': ${line}`);
    else if (listed.has(match[2])) problems.push(`${SUMS_FILE} lists ${match[2]} twice`);
    else listed.set(match[2], match[1]);
  }
  for (const name of expected.filter((each) => each !== SUMS_FILE)) {
    const sum = listed.get(name);
    if (sum === undefined) problems.push(`${SUMS_FILE} does not list ${name}`);
    else if (sum !== sha256(path.join(dir, name))) problems.push(`${name} does not match ${SUMS_FILE}: it is damaged or was changed`);
  }
  for (const name of listed.keys()) if (!expected.includes(name) || name === SUMS_FILE) problems.push(`${SUMS_FILE} lists ${name}, which is not a file of the release`);
  if (problems.length > 0) return problems;

  // The archive is the package of D58.1: the files in it are the loose ones, and it pins the image that the manifest names.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-verify-assets-"));
  try {
    const unpacked = spawnSync("tar", ["-xzf", path.join(dir, archiveName(manifest.version)), "-C", scratch], { encoding: "utf8" });
    const inside = path.join(scratch, `openlife-dashboard-${manifest.version}`);
    if (unpacked.status !== 0 || !existsSync(inside)) return [`${archiveName(manifest.version)} does not unpack to openlife-dashboard-${manifest.version}`];
    const pinned = JSON.parse(readFileSync(path.join(inside, PACKAGE_MANIFEST_FILE), "utf8")) as { version?: unknown; image?: unknown };
    if (pinned.version !== manifest.version) problems.push(`the package says version ${String(pinned.version)}, the manifest ${manifest.version}`);
    if (pinned.image !== `${manifest.app.repository}@${manifest.app.digest}`) problems.push(`the package pins ${String(pinned.image)}, the manifest names ${manifest.app.repository}@${manifest.app.digest}`);
    for (const name of readdirSync(inside)) {
      if (name === PACKAGE_MANIFEST_FILE || name === SUMS_FILE) continue;
      if (sha256(path.join(inside, name)) !== sha256(path.join(dir, name))) problems.push(`${name} in the package is not the file of the release`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}
