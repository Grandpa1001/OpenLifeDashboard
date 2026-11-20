// D61.4-AC2 — the release pipeline has the order, the permissions and the attestations of DEV §9.60: Release Please, the images, the files, the attestations,
// the draft, the candidate and only then the publication; each job has exactly its permissions; the same rules refuse a pipeline that does not (the faults
// below, one each). A real release (the public pull without an account, `gh attestation verify`, the visibility of the packages) is the manual protocol.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../support/repository-copy.ts";
import { checkReleasePipeline } from "../../support/release-pipeline.ts";
import { checkWorkflow, type WorkflowExpectation } from "../../support/workflow-policy.ts";

const text = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
const expectation: WorkflowExpectation = {
  jobs: {
    "release-please": { contents: "write", "pull-requests": "write" },
    images: { contents: "read", packages: "write" },
    assets: { contents: "read" },
    attest: { "id-token": "write", attestations: "write", packages: "write" },
    upload: { contents: "write" },
    candidate: { contents: "write" },
    publish: { contents: "write" },
  },
};

describe("D61.4-AC2 the release pipeline follows the rules of a workflow that publishes", () => {
  it("has nothing wrong in its permissions, its pins and its secrets", () => {
    expect(checkWorkflow(text, expectation)).toEqual([]);
  });

  it("runs in the order of the pipeline and has nothing wrong in its steps", () => {
    expect(checkReleasePipeline(text)).toEqual([]);
  });

  it("builds the images with the reusable workflow of D61.1, with the version and the commit of Release Please", () => {
    expect(text).toContain("uses: ./.github/workflows/release-images.yml");
    expect(text).toContain("version: ${{ needs.release-please.outputs.version }}");
    expect(text).toContain("revision: ${{ needs.release-please.outputs.sha }}");
  });

  it("takes the oldest version to install over from a file of the repository, none by default", () => {
    expect(text).toContain(".release-min-from");
    expect(text).toContain("scripts/assemble-release.ts");
    expect(text).toContain("scripts/verify-release-assets.ts release-assets");
  });
});

const faults: ReadonlyArray<readonly [string, (source: string) => string, RegExp]> = [
  ["the publication before the candidate", (source) => source.replace("needs: [release-please, candidate]", "needs: [release-please, upload]"), /only after the candidate|publish must run after candidate/],
  ["a candidate that does not wait for the files", (source) => source.replace("needs: [release-please, upload]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30", "needs: [release-please]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30"), /candidate must run after upload/],
  ["files uploaded before they are attested", (source) => source.replace("needs: [release-please, assets, attest]", "needs: [release-please, assets]"), /upload must run after attest/],
  ["images built without a release", (source) => source.replace("    if: ${{ needs.release-please.outputs.release_created == 'true' }}\n", ""), /only when Release Please created a release/],
  ["a publication in another job", (source) => source.replace('run: gh release upload "$TAG" release-assets/* --repo "$GITHUB_REPOSITORY" --clobber', 'run: gh release upload "$TAG" release-assets/* --repo "$GITHUB_REPOSITORY" --clobber && gh release edit "$TAG" --draft=false'), /the job upload publishes the release/],
  ["a publication that does not publish", (source) => source.replace("--draft=false --latest", "--latest"), /does not publish the draft/],
  ["no attestation of the files", (source) => source.replace("subject-path: release-assets/*", "show-summary: true"), /files of the release are attested/],
  ["one image not attested", (source) => source.replace("subject-name: ${{ steps.images.outputs.updater_name }}", "show-summary: true").replace("          subject-digest: ${{ steps.images.outputs.updater_digest }}\n", ""), /both images are attested/],
  ["attestations pushed without a login to the registry", (source) => source.replace("      - uses: docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550 # v4.8.0\n        with:\n          registry: ghcr.io\n          username: ${{ github.actor }}\n          password: ${{ secrets.GITHUB_TOKEN }}\n      - name: Read the pinned", "      - name: Read the pinned"), /attest job logs in to the registry/],
  ["the upload of another folder than the attested one", (source) => source.replace("          name: release-assets\n          path: release-assets\n      - name: Upload exactly", "          name: something-else\n          path: release-assets\n      - name: Upload exactly"), /the very files that were attested/],
  ["a login to the registry in the candidate", (source) => source.replace("      - name: Download the files of the draft like a user", "      - run: docker login ghcr.io\n      - name: Download the files of the draft like a user"), /must not log in/],
  ["a whole checkout in the candidate", (source) => source.replace("          sparse-checkout: scripts/ci\n", ""), /only scripts\/ci/],
  ["a candidate that does not run its script", (source) => source.replace("run: bash scripts/ci/release-candidate.sh downloaded", "run: echo downloaded"), /runs scripts\/ci\/release-candidate\.sh/],
  ["a pull request that starts the release", (source) => source.replace("on:\n  push:\n    branches: [main]", "on:\n  pull_request:\n  push:\n    branches: [main]"), /only a push starts the release/],
  ["another branch", (source) => source.replace("branches: [main]", "branches: [main, develop]"), /push to main only/],
  ["no queue of releases", (source) => source.replace("cancel-in-progress: false", "cancel-in-progress: true"), /two releases must not run at once/],
];

describe("D61.4-AC2 the pipeline faults are found", () => {
  it.each(faults)("finds %s", (_name, mutate, expected) => {
    const changed = mutate(text);
    expect(changed).not.toBe(text);
    expect(checkReleasePipeline(changed).join("\n")).toMatch(expected);
  });

  const policyFaults: ReadonlyArray<readonly [string, (source: string) => string, RegExp]> = [
    ["a permission that the attestation does not need", (source) => source.replace("      attestations: write\n      packages: write", "      attestations: write\n      packages: write\n      contents: write"), /expected/],
    ["a write for the files before the candidate", (source) => source.replace("  assets:\n    name: files of the release\n    needs: [release-please, images]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: read", "  assets:\n    name: files of the release\n    needs: [release-please, images]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 20\n    permissions:\n      contents: write"), /expected/],
    ["an action that is not pinned to a commit", (source) => source.replace("actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8", "actions/attest-build-provenance@v4"), /not pinned to a commit/],
    ["the release action that is not pinned to a commit", (source) => source.replace("googleapis/release-please-action@5c625bfb5d1ff62eadeeb3772007f7f66fdcf071", "googleapis/release-please-action@v4"), /not pinned to a commit/],
    ["a token of the owner", (source) => source.replace("secrets.GITHUB_TOKEN", "secrets.RELEASE_PAT"), /RELEASE_PAT/],
    ["a permission at the top", (source) => source.replace("permissions: {}", "permissions:\n  contents: write"), /grant nothing at the top/],
  ];
  it.each(policyFaults)("finds %s", (_name, mutate, expected) => {
    const changed = mutate(text);
    expect(changed).not.toBe(text);
    expect(checkWorkflow(changed, expectation).join("\n")).toMatch(expected);
  });
});
