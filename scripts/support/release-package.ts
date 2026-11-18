// The release package (Architektura §12.4 point 1; DEV §9.57, §9.58): the files of one release that belong
// together — the installers (install.sh for Linux and macOS, install.ps1 for Windows), the Compose files, a manifest that names the version and the image, and
// the SHA256SUMS of all of them — in one folder and one archive. install/install.sh checks the same
// list (install.ps1 does too, with Get-FileHash) before it writes anything, so a package that lost or changed a file is refused. The sums
// find damage; they do not prove who published the package (the trust in a publication is D61).
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const PACKAGE_PRODUCT = "openlife-dashboard";
export const PACKAGE_FORMAT_VERSION = 1;
export const MANIFEST_FILE = "release.json";
export const SUMS_FILE = "SHA256SUMS";
/** The files of a package with their place in the repository; the order is the order of SHA256SUMS. */
export const PACKAGE_SOURCES: Readonly<Record<string, string>> = {
  "compose.local.yml": "docker/compose.local.yml",
  "compose.yml": "docker/compose.yml",
  "install.ps1": "install/install.ps1",
  "install.sh": "install/install.sh",
  [MANIFEST_FILE]: "",
};
export const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
/** An image that the package may name: always pinned by digest, so the files and the image fit one release. */
export const PINNED_IMAGE_PATTERN = /^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

export type ReleasePackage = Readonly<{ folder: string; archive: string; files: readonly string[]; sums: string }>;

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

export function manifestText(version: string, image: string): string {
  return `${JSON.stringify({ formatVersion: PACKAGE_FORMAT_VERSION, product: PACKAGE_PRODUCT, version, image }, null, 2)}\n`;
}

/** Builds `<outDir>/openlife-dashboard-<version>/` and `<outDir>/openlife-dashboard-<version>.tar.gz`; an earlier build of the same version is replaced. */
export function buildReleasePackage(options: Readonly<{ repositoryRoot: string; outDir: string; version: string; image: string }>): ReleasePackage {
  const { repositoryRoot, outDir, version, image } = options;
  if (!VERSION_PATTERN.test(version)) throw new Error(`the version must look like 1.2.3, got: ${version}`);
  if (!PINNED_IMAGE_PATTERN.test(image)) throw new Error(`the image must be pinned by digest (name@sha256:<64 hex>), got: ${image}`);
  const name = `${PACKAGE_PRODUCT}-${version}`;
  const folder = path.join(outDir, name);
  const archive = path.join(outDir, `${name}.tar.gz`);
  rmSync(folder, { recursive: true, force: true });
  rmSync(archive, { force: true });
  mkdirSync(folder, { recursive: true });

  const files = Object.keys(PACKAGE_SOURCES);
  for (const file of files) {
    const target = path.join(folder, file);
    if (file === MANIFEST_FILE) writeFileSync(target, manifestText(version, image));
    else copyFileSync(path.join(repositoryRoot, PACKAGE_SOURCES[file]!), target);
  }
  chmodSync(path.join(folder, "install.sh"), 0o755);
  const sums = files.map((file) => `${sha256(readFileSync(path.join(folder, file)))}  ${file}\n`).join("");
  writeFileSync(path.join(folder, SUMS_FILE), sums);

  // The archive holds the one folder, so unpacking it never scatters files into the current folder.
  // COPYFILE_DISABLE: the tar of macOS otherwise adds an AppleDouble file `._<name>` for the extended attributes of every file,
  // and a package with a file that is not its own is refused by the installer on the computer that unpacks it.
  const packed = spawnSync("tar", ["-czf", archive, "-C", outDir, name], { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`);
  return { folder, archive, files: [...files, SUMS_FILE], sums };
}
