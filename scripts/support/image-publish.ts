// The publication of the two images of a release (Architektura Załącznik I; DEV §9.60 D61.1). Each architecture is built on a runner of its own
// and pushed under a tag of that architecture, its digest is the answer of the registry; the digests of the architectures are then joined
// into one index under the tag of the version, and the digest of that index is the only name the release uses (`name@sha256:...`). The
// builds carry no attestation of their own (--provenance=false and --sbom=false): an attestation inside the per-architecture image would
// make the index nest, and the provenance of the release is the signed attestation of the pipeline over the digest of the index.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The two images, the stage of docker/Dockerfile each is built from and its name in the registry. */
export const IMAGES = {
  app: { target: "runtime", name: "openlifedashboard" },
  updater: { target: "updater", name: "openlifedashboard-updater" },
} as const;
export type ImageKey = keyof typeof IMAGES;

export const PLATFORMS = { "linux/amd64": "amd64", "linux/arm64": "arm64" } as const;
export type Platform = keyof typeof PLATFORMS;

export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const REVISION_PATTERN = /^[0-9a-f]{7,40}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A registry with the owner or the folder the images live under, lower case as GHCR needs: `ghcr.io/owner`, `localhost:5000/openlife`. */
export const REGISTRY_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+$/;
/** The packages that carry the version of the product: the image of the app reports the first, and all must agree. */
const VERSIONED_PACKAGES = ["package.json", "apps/server/package.json", "apps/updater/package.json", "apps/web/package.json"] as const;

export type PlatformDigests = Readonly<Record<ImageKey, string>>;
export type PlatformResult = Readonly<{ platform: Platform; digests: PlatformDigests }>;
export type PublishedImages = Readonly<{ version: string; buildRevision: string; app: string; updater: string }>;

export type PublishOptions = Readonly<{ repositoryRoot: string; registry: string; version: string; revision: string }>;

export function repositoryOf(registry: string, key: ImageKey): string {
  return `${registry}/${IMAGES[key].name}`;
}

/** The input of a publication, refused before a build starts. */
export function validatePublishOptions(options: PublishOptions): void {
  if (!VERSION_PATTERN.test(options.version)) throw new Error(`the version must be x.y.z, got: ${options.version}`);
  if (!REVISION_PATTERN.test(options.revision)) throw new Error(`the revision must be 7 to 40 hex digits of a commit, got: ${options.revision}`);
  if (!REGISTRY_PATTERN.test(options.registry)) throw new Error(`the registry must be lower case host/owner such as ghcr.io/owner, got: ${options.registry}`);
}

/** The version in the packages of the repository is the version the image reports; a release of another number would lie about it. */
export function assertRepositoryVersion(repositoryRoot: string, version: string): void {
  for (const file of VERSIONED_PACKAGES) {
    const found = (JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8")) as { version?: unknown }).version;
    if (found !== version) throw new Error(`${file} has the version ${String(found)}, not ${version}: the images would report a version that is not the release's`);
  }
}

function docker(args: readonly string[], cwd: string): string {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** Builds and pushes both images for one architecture; the digest of each is what the registry answered. */
export function buildAndPushPlatform(options: PublishOptions & Readonly<{ platform: Platform }>): PlatformResult {
  validatePublishOptions(options);
  assertRepositoryVersion(options.repositoryRoot, options.version);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-publish-"));
  try {
    const digests = {} as Record<ImageKey, string>;
    for (const key of Object.keys(IMAGES) as ImageKey[]) {
      const metadata = path.join(scratch, `${key}.json`);
      docker(
        [
          "buildx", "build", "--platform", options.platform, "--target", IMAGES[key].target, "--build-arg", `BUILD_REVISION=${options.revision}`,
          "--provenance=false", "--sbom=false", "--push", "--tag", `${repositoryOf(options.registry, key)}:${options.version}-${PLATFORMS[options.platform]}`,
          "--metadata-file", metadata, "-f", "docker/Dockerfile", ".",
        ],
        options.repositoryRoot,
      );
      const digest = (JSON.parse(readFileSync(metadata, "utf8")) as Record<string, unknown>)["containerimage.digest"];
      if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) throw new Error(`the build of ${key} did not report the digest of the pushed image`);
      digests[key] = digest;
    }
    return { platform: options.platform, digests };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Joins the architectures of each image into the index of the version and returns the pinned name of each index. */
export function mergePlatforms(options: PublishOptions & Readonly<{ results: readonly PlatformResult[] }>): PublishedImages {
  validatePublishOptions(options);
  if (options.results.length === 0) throw new Error("there is no architecture to join");
  const platforms = options.results.map((result) => result.platform);
  if (new Set(platforms).size !== platforms.length) throw new Error(`an architecture is given twice: ${platforms.join(", ")}`);
  const pinned = {} as Record<ImageKey, string>;
  for (const key of Object.keys(IMAGES) as ImageKey[]) {
    const repository = repositoryOf(options.registry, key);
    const sources = options.results.map((result) => {
      const digest = result.digests[key];
      if (!DIGEST_PATTERN.test(digest)) throw new Error(`the digest of ${key} for ${result.platform} is not sha256:<64 hex>: ${digest}`);
      return `${repository}@${digest}`;
    });
    docker(["buildx", "imagetools", "create", "--tag", `${repository}:${options.version}`, ...sources], options.repositoryRoot);
    const digest = docker(["buildx", "imagetools", "inspect", `${repository}:${options.version}`, "--format", "{{.Manifest.Digest}}"], options.repositoryRoot).trim();
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`the registry did not report the digest of the index of ${key}: ${digest}`);
    pinned[key] = `${repository}@${digest}`;
  }
  return { version: options.version, buildRevision: options.revision, app: pinned.app, updater: pinned.updater };
}
