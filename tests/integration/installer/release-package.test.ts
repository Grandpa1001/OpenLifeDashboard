// D58.1 — the release package and the installer that runs from it, without Docker: the builder makes a
// folder and an archive whose files are the ones of this repository, a manifest and SHA256SUMS; the
// installer run from it takes the image from the manifest and checks every file first. Any file that
// is changed, missing, extra or not listed, and any manifest that is not ours, ends the run before
// anything is written. The same package on a real Docker is D58.4.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { buildReleasePackage, manifestText, MANIFEST_FILE, PACKAGE_SOURCES, SUMS_FILE } from "../../../scripts/support/release-package.ts";
import { dockerCalls, installerRig, runInstaller, type InstallerRig } from "../../support/installer-rig.ts";
import { repoRoot } from "../../support/server-process.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-release-package-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const VERSION = "1.4.0";
const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/openlife/app@sha256:${DIGEST}`;
const OWNER_ARGS = ["--owner-email", "wlasciciel@example.com", "--owner-password-stdin"] as const;
const PASSWORD_LINE = "Zażółć gęślą jaźń 2026\n";
let counter = 0;
const nextDir = (name: string): string => path.join(root, `${name} ${(counter += 1)}`);

const built = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "built"), version: VERSION, image: IMAGE });
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const entries = (dir: string): string[] => readdirSync(dir).sort();

/** The installer of a package in a folder, run to completion against a fake Docker (nothing is asked: e-mail and password come as arguments and stdin). */
const installFrom = (folder: string, rig: InstallerRig, target: string, extra: readonly string[] = []) =>
  runInstaller(rig, ["--dir", target, "--port", "18500", "--yes", ...OWNER_ARGS, ...extra], { script: path.join(folder, "install.sh"), input: PASSWORD_LINE });

/** A copy of the built package that a test may damage. */
function copyOfPackage(): string {
  const folder = nextDir("package");
  cpSync(built.folder, folder, { recursive: true });
  return folder;
}

/** SHA256SUMS written again for the files as they are, so only the manifest itself is under test. */
function reseal(folder: string): void {
  const files = Object.keys(PACKAGE_SOURCES);
  writeFileSync(path.join(folder, SUMS_FILE), files.map((file) => `${sha256(path.join(folder, file))}  ${file}\n`).join(""));
}

describe("D58.1-AC1 a release package carries the files of one release and installs from itself", () => {
  it("holds both installers, the three Compose files, the Caddyfile, a manifest and SHA256SUMS, and the files are the ones of the repository", () => {
    expect(entries(built.folder)).toEqual([MANIFEST_FILE, SUMS_FILE, "Caddyfile", "compose.local.yml", "compose.server.yml", "compose.yml", "install.ps1", "install.sh"].sort());
    for (const [file, source] of Object.entries(PACKAGE_SOURCES)) {
      if (source !== "") expect(sha256(path.join(built.folder, file)), file).toBe(sha256(path.join(repoRoot, source)));
    }
    expect(statSync(path.join(built.folder, "install.sh")).mode & 0o111).not.toBe(0);
    const sums = readFileSync(path.join(built.folder, SUMS_FILE), "utf8").trimEnd().split("\n");
    expect(sums).toEqual(Object.keys(PACKAGE_SOURCES).map((file) => `${sha256(path.join(built.folder, file))}  ${file}`));
    expect(readFileSync(path.join(built.folder, MANIFEST_FILE), "utf8")).toBe(manifestText(VERSION, IMAGE));
    expect(JSON.parse(readFileSync(path.join(built.folder, MANIFEST_FILE), "utf8"))).toEqual({ formatVersion: 1, product: "openlife-dashboard", version: VERSION, image: IMAGE });
  });

  it("is built the same twice, and refuses a version that is not x.y.z or an image that is not pinned by digest", () => {
    const again = buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "again"), version: VERSION, image: IMAGE });
    expect(again.sums).toBe(built.sums);
    for (const version of ["1.4", "v1.4.0", "1.4.0-rc1", ""]) {
      expect(() => buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "refused"), version, image: IMAGE }), version).toThrow(/version/);
    }
    for (const image of ["registry.example.test/openlife/app:1.4.0", "app@sha256:abc", `app @sha256:${DIGEST}`, ""]) {
      expect(() => buildReleasePackage({ repositoryRoot: repoRoot, outDir: path.join(root, "refused"), version: VERSION, image }), image).toThrow(/digest/);
    }
    expect(existsSync(path.join(root, "refused"))).toBe(false);
  });

  it("is one archive with one folder, and its files are the same as the folder's", () => {
    // The names in the archive itself: unpacking on macOS would hide a `._name` file of extended attributes, which a Linux unpack shows.
    const listed = spawnSync("tar", ["-tzf", built.archive], { encoding: "utf8" }).stdout.split("\n").filter((name) => name !== "").map((name) => name.replace(/\/$/, ""));
    const name = `openlife-dashboard-${VERSION}`;
    expect(listed.sort()).toEqual([name, ...[...Object.keys(PACKAGE_SOURCES), SUMS_FILE].map((file) => `${name}/${file}`)].sort());
    const unpacked = nextDir("unpacked");
    mkdirSync(unpacked);
    const result = spawnSync("tar", ["-xzf", built.archive, "-C", unpacked], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(entries(unpacked)).toEqual([`openlife-dashboard-${VERSION}`]);
    const inside = path.join(unpacked, `openlife-dashboard-${VERSION}`);
    expect(entries(inside)).toEqual(entries(built.folder));
    for (const file of entries(inside)) expect(sha256(path.join(inside, file)), file).toBe(sha256(path.join(built.folder, file)));
  });

  it("installs from the unpacked archive without --image: the image is the manifest's, the files are the package's, the version is told", () => {
    const unpacked = nextDir("unpacked");
    mkdirSync(unpacked);
    spawnSync("tar", ["-xzf", built.archive, "-C", unpacked]);
    const folder = path.join(unpacked, `openlife-dashboard-${VERSION}`);
    const rig = installerRig();
    const target = nextDir("Instalacja");
    const result = installFrom(folder, rig, target);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`openlife-dashboard ${VERSION}`);
    expect(readFileSync(path.join(target, "control", "compose.release.yml"), "utf8")).toContain(IMAGE);
    for (const file of ["compose.yml", "compose.local.yml"]) expect(sha256(path.join(target, file)), file).toBe(sha256(path.join(folder, file)));
    expect(dockerCalls(rig).some((call) => call.includes(IMAGE))).toBe(true);
    // The same image given again is the same image.
    const second = installFrom(folder, rig, nextDir("Instalacja"), ["--image", IMAGE]);
    expect(second.status, second.stderr).toBe(0);
  });
});

describe("D58.1-AC2 a package that is not whole and unchanged is refused before anything is written", () => {
  /** The installer is run from the damaged package: nonzero, a message that names the problem, no folder, no call of Docker. */
  function refused(folder: string, message: RegExp, extra: readonly string[] = []): void {
    const rig = installerRig();
    const target = nextDir("Instalacja");
    const result = installFrom(folder, rig, target, extra);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(existsSync(target), "the folder of the installation").toBe(false);
    expect(dockerCalls(rig)).toEqual([]);
  }

  for (const file of ["Caddyfile", "compose.yml", "compose.local.yml", "compose.server.yml", "install.ps1", "install.sh", "release.json"]) {
    it(`a changed ${file}`, () => {
      const folder = copyOfPackage();
      writeFileSync(path.join(folder, file), `${readFileSync(path.join(folder, file), "utf8")}\n# changed\n`);
      refused(folder, new RegExp(`${file.replace(".", "\\.")} does not match SHA256SUMS`));
    });
    it(`a missing ${file}`, () => {
      const folder = copyOfPackage();
      unlinkSync(path.join(folder, file));
      // A missing install.sh cannot be run at all; the others are named.
      if (file === "install.sh") return;
      refused(folder, new RegExp(`${file.replace(".", "\\.")} is missing`));
    });
  }

  it("a missing SHA256SUMS", () => {
    const folder = copyOfPackage();
    unlinkSync(path.join(folder, SUMS_FILE));
    refused(folder, /SHA256SUMS is missing/);
  });

  it("an extra file or folder", () => {
    const withFile = copyOfPackage();
    writeFileSync(path.join(withFile, "extra.sh"), "echo hi\n");
    refused(withFile, /not part of it: extra\.sh/);
    const withFolder = copyOfPackage();
    mkdirSync(path.join(withFolder, "docs"));
    refused(withFolder, /not part of it: docs/);
  });

  it("a file that is a link instead of a plain file", () => {
    const folder = copyOfPackage();
    const real = path.join(root, "real-compose.yml");
    writeFileSync(real, readFileSync(path.join(folder, "compose.yml")));
    unlinkSync(path.join(folder, "compose.yml"));
    symlinkSync(real, path.join(folder, "compose.yml"));
    refused(folder, /compose\.yml is missing or is not a plain file/);
  });

  it("a SHA256SUMS that lists a file twice, a file that is not ours, too few files or a line that is not a sum", () => {
    const lines = readFileSync(path.join(built.folder, SUMS_FILE), "utf8").trimEnd().split("\n");
    const cases: Array<[string, string[], RegExp]> = [
      ["twice", [...lines, lines[0]!], /twice/],
      ["unknown file", [...lines.slice(0, 3), `${DIGEST}  other.txt`], /not part of the package: other\.txt/],
      ["a file left out", lines.slice(0, 3), /must list all 7 files/],
      ["not a sum", [...lines.slice(0, 3), "not a sum"], /not '<sha256> {2}<file>'/],
      ["upper case digits", [...lines.slice(0, 3), lines[3]!.toUpperCase()], /not '<sha256> {2}<file>'/],
      ["one space between the sum and the name", [...lines.slice(0, 3), lines[3]!.replace("  ", " ")], /not '<sha256> {2}<file>'/],
    ];
    for (const [name, content, message] of cases) {
      const folder = copyOfPackage();
      writeFileSync(path.join(folder, SUMS_FILE), `${content.join("\n")}\n`);
      expect(() => refused(folder, message), name).not.toThrow();
    }
  });

  it("a manifest that is sealed but is not ours: another product or format, a version that is not x.y.z, an image without a digest, a key twice or missing", () => {
    const manifest = readFileSync(path.join(built.folder, MANIFEST_FILE), "utf8");
    const cases: Array<[string, string, RegExp]> = [
      ["another format", manifest.replace('"formatVersion": 1', '"formatVersion": 2'), /format this installer does not know/],
      ["another product", manifest.replace("openlife-dashboard", "other-product"), /not the manifest of openlife-dashboard/],
      ["a short version", manifest.replace(`"${VERSION}"`, '"1.4"'), /version that is not x\.y\.z/],
      ["a pre-release version", manifest.replace(`"${VERSION}"`, '"1.4.0-rc1"'), /version that is not x\.y\.z/],
      ["an image with a tag only", manifest.replace(/"image": "[^"]+"/, '"image": "registry.example.test/openlife/app:1.4.0"'), /not pinned by digest/],
      ["an image with a space", manifest.replace(/"image": "[^"]+"/, `"image": "app @sha256:${DIGEST}"`), /not pinned by digest/],
      ["no image", manifest.replace(/ {2}"image": "[^"]+"\n/, "").replace(/,\n}/, "\n}"), /"image" exactly once/],
      ["the version twice", manifest.replace(/ {2}"version": "[^"]+",\n/, (line) => `${line}${line}`), /"version" exactly once/],
    ];
    for (const [name, content, message] of cases) {
      const folder = copyOfPackage();
      writeFileSync(path.join(folder, MANIFEST_FILE), content);
      reseal(folder);
      chmodSync(path.join(folder, "install.sh"), 0o755);
      expect(() => refused(folder, message), name).not.toThrow();
    }
  });

  it("an --image that is not the one the package pins", () => {
    const folder = copyOfPackage();
    const rig = installerRig();
    const target = nextDir("Instalacja");
    const result = installFrom(folder, rig, target, ["--image", "openlife-app:test"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pins its image");
    expect(existsSync(target)).toBe(false);
    expect(dockerCalls(rig)).toEqual([]);
  });
});
