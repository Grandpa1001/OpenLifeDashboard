// D59.4 — install/install.ps1 from a release package (DEV §9.58), run by PowerShell 7 in a Linux container with a fake Docker, as a copy that believes
// it is on Windows (tests/support/powershell-rig.ts). The package is built by the real builder from that copy, so the sums are the ones of the
// files that run. A package that is whole installs without -Image from its manifest; a package that is changed, incomplete or has an extra file is
// refused before Docker is asked for anything or a folder is written. A real Windows with Docker Desktop is the manual trial of D59.4.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { buildReleasePackage, MANIFEST_FILE, PACKAGE_SOURCES, SUMS_FILE } from "../../scripts/support/release-package.ts";
import { createCheck } from "../support/check-report.ts";
import { docker } from "../support/docker.ts";
import { powershellRig, POWERSHELL_IMAGE } from "../support/powershell-rig.ts";
import { repoRoot } from "../support/repository-copy.ts";

const check = createCheck("install.ps1 from a release package, PowerShell 7 with a fake Docker");
const probe = docker(["image", "inspect", POWERSHELL_IMAGE], repoRoot);
if (probe.status !== 0) {
  const pulled = docker(["pull", "--platform", "linux/amd64", POWERSHELL_IMAGE], repoRoot, 10 * 60 * 1000);
  if (!check.expect(pulled.status === 0, "the PowerShell image is on this computer", pulled.output)) {
    check.finish();
    process.exit(process.exitCode ?? 1);
  }
}

const DIGEST = "a".repeat(64);
const IMAGE = `registry.example.test/openlife/app@sha256:${DIGEST}`;
const VERSION = "1.4.0";
const EMAIL = "wlasciciel@example.com";
const PASSWORD = "Zażółć gęślą jaźń 2026";
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

const rig = powershellRig();
try {
  // The package is built from the tree of the rig, whose install.ps1 is the copy that believes it is Windows.
  cpSync(path.join(repoRoot, "install", "install.sh"), path.join(rig.work, "tree", "install", "install.sh"));
  const built = buildReleasePackage({ repositoryRoot: path.join(rig.work, "tree"), outDir: path.join(rig.work, "built"), version: VERSION, image: IMAGE });
  let counter = 0;
  const copyOfPackage = (): string => {
    const name = `p${(counter += 1)}`;
    cpSync(built.folder, path.join(rig.work, name), { recursive: true });
    return name;
  };
  const reseal = (name: string): void => {
    const files = Object.keys(PACKAGE_SOURCES);
    writeFileSync(path.join(rig.work, name, SUMS_FILE), files.map((file) => `${sha(path.join(rig.work, name, file))}  ${file}\n`).join(""));
  };
  const input = { stdin: `${PASSWORD}\n` } as const;
  const args = (target: string, extra: readonly string[] = []): readonly string[] => ["-Dir", `/work/${target}`, "-Yes", "-Port", "18080", "-OwnerEmail", EMAIL, "-OwnerPasswordStdin", ...extra];
  const refused = (name: string, folder: string, message: RegExp, status = 1, extra: readonly string[] = []): void => {
    const target = `t-${name.replaceAll(/[^a-z0-9]+/gi, "-")}`;
    const callsBefore = rig.dockerCalls().length;
    const result = rig.run(args(target, extra), { ...input, script: `${folder}/install.ps1` });
    const untouched = !existsSync(path.join(rig.work, target)) && rig.dockerCalls().length === callsBefore;
    check.expect(result.status === status && message.test(result.output) && untouched, `${name} is refused before Docker is asked or a folder is written`, `${result.status}\n${result.output}`);
  };

  // ---- A package that is whole installs from itself, without -Image.
  const good = copyOfPackage();
  const installed = rig.run(args("installed"), { ...input, script: `${good}/install.ps1` });
  check.expect(installed.status === 0 && /OpenLifeDashboard is installed/.test(installed.output), "a whole package installs without -Image", `${installed.status}\n${installed.output}`);
  check.expect(installed.output.includes(`openlife-dashboard ${VERSION} (every file matches SHA256SUMS)`), "the installer says that it checked the package and names its version", installed.output);
  check.expect(rig.read("installed/control/compose.release.yml") === `services:\n  app:\n    image: "${IMAGE}"\n`, "the image of the installation is the one of the manifest");
  for (const file of ["compose.yml", "compose.local.yml"]) check.expect(rig.read(`installed/${file}`) === readFileSync(path.join(rig.work, good, file), "utf8"), `${file} is the one of the package`);
  check.expect(rig.dockerCalls().some((call) => call === `image inspect ${IMAGE}`), "Docker was asked for the image of the manifest", rig.dockerCalls().join(" | "));

  // ---- AC1: a changed, a missing or an extra file is refused.
  for (const file of ["compose.yml", "compose.local.yml", "install.ps1", "install.sh", MANIFEST_FILE]) {
    const folder = copyOfPackage();
    writeFileSync(path.join(rig.work, folder, file), `${readFileSync(path.join(rig.work, folder, file), "utf8")}\n# changed\n`);
    refused(`a changed ${file}`, folder, new RegExp(`${file.replace(".", "\\.")} does not match SHA256SUMS`));
  }
  for (const file of ["compose.yml", "compose.local.yml", "install.sh", MANIFEST_FILE, SUMS_FILE]) {
    const folder = copyOfPackage();
    rmSync(path.join(rig.work, folder, file));
    refused(`a missing ${file}`, folder, new RegExp(`${file.replace(".", "\\.")} is missing`));
  }
  const extraFile = copyOfPackage();
  writeFileSync(path.join(rig.work, extraFile, "extra.ps1"), "Write-Host hi\n");
  refused("an extra file", extraFile, /not part of it: extra\.ps1/);
  const extraFolder = copyOfPackage();
  mkdirSync(path.join(rig.work, extraFolder, "docs"));
  refused("an extra folder", extraFolder, /not part of it: docs/);

  // ---- The sums and the manifest themselves.
  const leftOut = copyOfPackage();
  const lines = readFileSync(path.join(rig.work, leftOut, SUMS_FILE), "utf8").trimEnd().split("\n");
  writeFileSync(path.join(rig.work, leftOut, SUMS_FILE), `${lines.slice(0, 4).join("\n")}\n`);
  refused("a SHA256SUMS that leaves a file out", leftOut, /must list all 5 files/);
  const twice = copyOfPackage();
  writeFileSync(path.join(rig.work, twice, SUMS_FILE), `${[...lines, lines[0]].join("\n")}\n`);
  refused("a SHA256SUMS that lists a file twice", twice, /twice/);
  const tagOnly = copyOfPackage();
  writeFileSync(path.join(rig.work, tagOnly, MANIFEST_FILE), readFileSync(path.join(rig.work, tagOnly, MANIFEST_FILE), "utf8").replace(/"image": "[^"]+"/, '"image": "registry.example.test/openlife/app:1.4.0"'));
  reseal(tagOnly);
  refused("a manifest with an image that has no digest", tagOnly, /not pinned by digest/);
  const another = copyOfPackage();
  refused("an -Image that is not the one of the package", another, /pins its image/, 2, ["-Image", "openlife-app:other"]);

  check.expect(existsSync(path.join(rig.work, good, "install.ps1")), "the package that was installed from is still whole");
} finally {
  rig.cleanup();
}
check.finish();
