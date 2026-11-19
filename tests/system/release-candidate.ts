// D61.4-AC1 — the candidate of a release on a clean Linux (DEV §9.60). A container of Ubuntu 24.04 with its own Docker daemon and a registry in it plays the
// registry of the release (GHCR); the files of a release are assembled for the digest of the app image in that registry (the real assembler of D61.2), copied
// to the box as a user's downloads and installed by scripts/ci/release-candidate.sh, the very script of the candidate job, with nothing of the repository and
// no login to the registry. The candidate passes only when the files are whole, the installation completes, the application reports the version of the release
// and the owner signs in; and it refuses, before anything is installed, a file that was changed, an extra file, a file the sums do not list and another version.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { assembleRelease, verifyReleaseAssets } from "../../scripts/support/release-assets.ts";
import { createCheck } from "../support/check-report.ts";
import { HOME, withCleanLinux } from "../support/clean-linux.ts";
import { requireNativeDocker } from "../support/docker.ts";
import { repoRoot } from "../support/repository-copy.ts";

const VERSION = (JSON.parse(readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8")) as { version: string }).version;
const REGISTRY_REPOSITORY = "registry.test/openlife";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
// The updater is not installed by the installer of D61, so its pin only has to be well formed.
const UPDATER_DIGEST = `sha256:${"b".repeat(64)}`;
const PASSWORD = "Zażółć gęślą jaźń 2026";
const PORT = 18081;

const { arch, platform } = requireNativeDocker(repoRoot);
const check = createCheck(`the candidate of a release installed from its own files on a clean Linux (${platform})`);
const evidence: Record<string, unknown> = {};
const scratch = mkdtempSync(path.join(os.tmpdir(), "openlife-candidate-"));

try {
  await withCleanLinux(check, { name: "d61" }, async ({ facts, image, copyIn, inside, insideDocker, waitFor }) => {
    evidence["linux"] = facts;
    // The release names the repositories openlifedashboard and openlifedashboard-updater: the image of the box is pushed under the first name. It is the same
    // manifest, so the digest does not change.
    check.expect(insideDocker(["pull", image]).status === 0, "the application image is taken from the registry of the box", image);
    const named = `${REGISTRY_REPOSITORY}/openlifedashboard`;
    insideDocker(["tag", image, `${named}:${VERSION}`]);
    const pushed = insideDocker(["push", `${named}:${VERSION}`]);
    const digest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.output)?.[1] ?? "";
    check.expect(pushed.status === 0 && image.endsWith(`@${digest}`), "the image is pushed under the name of the release with the same digest", pushed.output);
    insideDocker(["image", "rm", "--force", `${named}:${VERSION}`, image]);

    // ---- The files of the release, made by the real assembler for that digest.
    const assets = path.join(scratch, "release-assets");
    const built = assembleRelease({
      repositoryRoot: repoRoot,
      outDir: assets,
      version: VERSION,
      minFrom: null,
      images: { version: VERSION, buildRevision: REVISION, app: `${named}@${digest}`, updater: `${REGISTRY_REPOSITORY}/openlifedashboard-updater@${UPDATER_DIGEST}` },
    });
    check.expect(verifyReleaseAssets(assets).length === 0, `the folder of the release (${built.files.length} files) is whole before it leaves the pipeline`, verifyReleaseAssets(assets).join("\n"));

    // ---- Downloaded to the box like a user's files; the script of the candidate is the one of the repository.
    const stage = (name: string, source: string): boolean => {
      const copied = copyIn(source, `/tmp/${name}`);
      const placed = inside(["sh", "-c", `rm -rf ${HOME}/${name} && cp -r /tmp/${name} ${HOME}/${name} && chown -R tester ${HOME}/${name}`], { root: true });
      return copied.status === 0 && placed.status === 0;
    };
    check.expect(stage("downloaded", assets), "the files are in the box as downloaded files");
    const scriptSource = path.join(repoRoot, "scripts/ci/release-candidate.sh");
    check.expect(stage("release-candidate.sh", scriptSource), "the script of the candidate job is in the box");
    const candidate = (folder: string, version = VERSION, env: Readonly<Record<string, string>> = { OPENLIFE_CANDIDATE_PASSWORD: PASSWORD }): ReturnType<typeof inside> =>
      inside(["bash", `${HOME}/release-candidate.sh`, `${HOME}/${folder}`, version, String(PORT)], { env, timeoutMs: 20 * 60 * 1000 });
    const containers = (): string => insideDocker(["ps", "--all", "--format", "{{.Names}}"]).stdout.trim();
    const quiet = containers();

    // ---- Files that are not whole are refused before anything is installed.
    const damaged = (name: string, change: (folder: string) => void): void => {
      const folder = path.join(scratch, name);
      cpSync(assets, folder, { recursive: true });
      change(folder);
      check.expect(stage(name, folder), `the damaged copy ${name} is in the box`);
    };
    damaged("changed", (folder) => appendFileSync(path.join(folder, "compose.yml"), "# changed\n"));
    damaged("extra", (folder) => writeFileSync(path.join(folder, "extra.txt"), "not a file of the release\n"));
    damaged("unlisted", (folder) => writeFileSync(path.join(folder, "SHA256SUMS"), readFileSync(path.join(folder, "SHA256SUMS"), "utf8").split("\n").filter((line) => !line.endsWith("  Caddyfile")).join("\n")));
    damaged("nomanifest", (folder) => rmSync(path.join(folder, "release-manifest.json")));
    const refusals: ReadonlyArray<readonly [string, string, string, RegExp]> = [
      ["a changed file", "changed", VERSION, /does not match SHA256SUMS/],
      ["a file that is not in SHA256SUMS", "extra", VERSION, /SHA256SUMS does not list it/],
      ["a file that SHA256SUMS does not list but the folder holds", "unlisted", VERSION, /does not list it/],
      ["a folder without the manifest", "nomanifest", VERSION, /not match SHA256SUMS|release-manifest\.json is missing/],
      ["the files of another version", "downloaded", "9.9.9", /not the manifest of the version 9\.9\.9|archive|missing/],
    ];
    for (const [what, folder, version, expected] of refusals) {
      const refused = candidate(folder, version);
      check.expect(refused.status !== 0 && expected.test(refused.output), `the candidate refuses ${what}`, `${refused.status}\n${refused.output}`);
      check.expect(containers() === quiet && !refused.output.includes(PASSWORD), `and installs nothing (${what})`, containers());
    }

    // ---- The files that are whole: installed from the digest, the application reports the version, the owner signs in.
    const startedAt = Date.now();
    const passed = candidate("downloaded");
    check.expect(passed.status === 0 && passed.output.includes(`the release ${VERSION} is whole, installs from its own files and the owner signs in`), "the candidate passes on the whole files", `${passed.status}\n${passed.output}`);
    check.expect(!passed.output.includes(PASSWORD), "the password is not in the output");
    check.expect(passed.output.includes("every file matches SHA256SUMS"), "the installer of the package checked the package again", passed.output);
    const health = inside(["curl", "-s", `http://127.0.0.1:${PORT}/api/health`]).stdout;
    const runningContainer = insideDocker(["ps", "--quiet", "--filter", `publish=${PORT}`]).stdout.trim().split("\n")[0] ?? "";
    const reported = insideDocker(["exec", runningContainer, "cat", "apps/server/package.json"]).stdout;
    check.expect(health.includes('"ok"') && (JSON.parse(reported || "{}") as { version?: string }).version === VERSION, "the application answers and the running image is the version of the release", `${health} ${reported.slice(0, 80)}`);
    const published = insideDocker(["ps", "--format", "{{.Ports}}"]).stdout;
    check.expect(published.includes(`127.0.0.1:${PORT}->8080/tcp`), "the application is published on 127.0.0.1 only", published);
    const pulled = insideDocker(["image", "ls", "--digests", "--format", "{{.Repository}}@{{.Digest}}"]).stdout;
    check.expect(pulled.includes(`${named}@${digest}`), "the image was pulled by the digest of the manifest", pulled);
    evidence["candidate"] = { version: VERSION, files: built.files, seconds: (Date.now() - startedAt) / 1000, health };
    await waitFor("the application", () => inside(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${PORT}/api/health`]).stdout === "200", 20);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) {
  writeFileSync(path.join(evidenceDir, `release-candidate-${arch}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
check.finish();
