// D61.3-AC1 — Release Please is set up for one version of the whole product: the manifest mode, the type node, the tag vX.Y.Z, a draft release, and every
// file that carries the version is either the root (changed by Release Please itself) or listed in extra-files. The four package files and the manifest
// agree, and a drift of one of them, or a file left out of extra-files, is found (the faults below, one each, on a copy of the files).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RELEASE_CONFIG_FILE, RELEASE_MANIFEST_FILE, releaseConfigProblems } from "../../../scripts/support/release-config.ts";
import { VERSIONED_PACKAGES } from "../../../scripts/support/image-publish.ts";
import { repoRoot } from "../../support/repository-copy.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-release-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
/** A copy of the files the check reads, with `change` applied to it. */
function copy(change: (dir: string) => void): string {
  const dir = path.join(root, `copy-${(counter += 1)}`);
  for (const file of [RELEASE_CONFIG_FILE, RELEASE_MANIFEST_FILE, ...VERSIONED_PACKAGES]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    cpSync(path.join(repoRoot, file), path.join(dir, file));
  }
  change(dir);
  return dir;
}
const edit = (dir: string, file: string, change: (json: Record<string, unknown>) => void): void => {
  const json = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(path.join(dir, file), JSON.stringify(json, null, 2));
};

describe("D61.3-AC1 the versions and the configuration of Release Please", () => {
  it("are consistent in the repository", () => {
    expect(releaseConfigProblems(repoRoot)).toEqual([]);
  });

  it("list every file that carries the version, but the root, in extra-files, and the config asks for a draft with a tag of vX.Y.Z", () => {
    const config = JSON.parse(readFileSync(path.join(repoRoot, RELEASE_CONFIG_FILE), "utf8")) as { packages: { "."?: { "extra-files": { path: string }[] } } };
    expect(config.packages["."]?.["extra-files"].map((entry) => entry.path).sort()).toEqual(VERSIONED_PACKAGES.filter((file) => file !== "package.json").sort());
    const settings = JSON.parse(readFileSync(path.join(repoRoot, RELEASE_CONFIG_FILE), "utf8")) as Record<string, unknown>;
    expect(settings).toMatchObject({ "release-type": "node", draft: true, "force-tag-creation": true, "include-v-in-tag": true, "include-component-in-tag": false });
  });

  const faults: ReadonlyArray<readonly [string, (dir: string) => void, RegExp]> = [
    ["the version of the server that differs", (dir) => edit(dir, "apps/server/package.json", (json) => (json["version"] = "0.0.1")), /apps\/server\/package\.json has the version 0\.0\.1/],
    ["the version of the updater that differs", (dir) => edit(dir, "apps/updater/package.json", (json) => (json["version"] = "1.0.0")), /apps\/updater\/package\.json has the version 1\.0\.0/],
    ["the version of the web app that is missing", (dir) => edit(dir, "apps/web/package.json", (json) => delete json["version"]), /apps\/web\/package\.json has the version undefined/],
    ["a version that is not x.y.z in the root", (dir) => edit(dir, "package.json", (json) => (json["version"] = "1.0")), /no version x\.y\.z/],
    ["the manifest of Release Please at another version", (dir) => writeFileSync(path.join(dir, RELEASE_MANIFEST_FILE), '{ ".": "0.5.0" }'), /\.release-please-manifest\.json must be/],
    ["a manifest with another package", (dir) => writeFileSync(path.join(dir, RELEASE_MANIFEST_FILE), '{ ".": "0.0.0", "apps/web": "0.0.0" }'), /must be/],
    ["a file left out of extra-files", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => ((json["packages"] as { "."?: { "extra-files": unknown[] } })["."]!["extra-files"].pop())), /must be in extra-files/],
    ["a file in extra-files that carries no version", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => ((json["packages"] as { "."?: { "extra-files": unknown[] } })["."]!["extra-files"].push({ type: "json", path: "apps/other/package.json", jsonpath: "$.version" }))), /not a file that carries the version/],
    ["a release that is not a draft", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => (json["draft"] = false)), /draft must be true/],
    ["a tag with the name of the component", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => (json["include-component-in-tag"] = true)), /include-component-in-tag must be false/],
    ["another type of release", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => (json["release-type"] = "simple")), /release-type must be "node"/],
    ["a second package of the repository", (dir) => edit(dir, RELEASE_CONFIG_FILE, (json) => ((json["packages"] as Record<string, unknown>)["apps/web"] = {})), /root "\." and nothing else/],
    ["no configuration", (dir) => rmSync(path.join(dir, RELEASE_CONFIG_FILE)), /release-please-config\.json is missing/],
  ];
  for (const [name, change, message] of faults) {
    it(`finds ${name}`, () => {
      expect(releaseConfigProblems(copy(change)).join("\n")).toMatch(message);
    });
  }
});
