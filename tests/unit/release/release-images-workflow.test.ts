// D61.1-AC2 — the workflow that publishes the images grants nothing at the top, the build and the join jobs only `contents: read` and `packages: write`,
// pins every action to a commit and uses no secret but the built-in token; the same rules refuse a workflow that does not (the faults below, one each).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../support/repository-copy.ts";
import { checkWorkflow, type WorkflowExpectation } from "../../support/workflow-policy.ts";

const text = readFileSync(path.join(repoRoot, ".github/workflows/release-images.yml"), "utf8");
const expectation: WorkflowExpectation = {
  jobs: {
    build: { contents: "read", packages: "write" },
    merge: { contents: "read", packages: "write" },
  },
};

describe("D61.1-AC2 the workflow of the images follows the rules of a workflow that publishes", () => {
  it("has nothing wrong", () => {
    expect(checkWorkflow(text, expectation)).toEqual([]);
  });

  it("builds each architecture on a runner of that architecture and joins them after both", () => {
    expect(text).toContain("runner: ubuntu-24.04\n");
    expect(text).toContain("runner: ubuntu-24.04-arm");
    expect(text).toMatch(/merge:[\s\S]*needs: build/);
    expect(text).toContain("scripts/publish-images.ts build");
    expect(text).toContain("scripts/publish-images.ts merge");
  });

  const faults: ReadonlyArray<readonly [string, (source: string) => string, RegExp]> = [
    ["write-all", (source) => source.replace("permissions: {}", "permissions: write-all"), /top|write-all/],
    ["a permission at the top", (source) => source.replace("permissions: {}", "permissions:\n  contents: read"), /grant nothing at the top/],
    ["a job without its permissions", (source) => source.replace("    permissions:\n      contents: read\n      packages: write\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ inputs.revision }}\n          persist-credentials: false\n      - uses: actions/setup-node", "    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: ${{ inputs.revision }}\n          persist-credentials: false\n      - uses: actions/setup-node"), /must list its permissions/],
    ["a permission that the job does not need", (source) => source.replace("      contents: read\n      packages: write\n    steps:", "      contents: write\n      packages: write\n    steps:"), /expected/],
    ["an action that is not pinned to a commit", (source) => source.replace("docker/login-action@8aa5831fb8d48d8f76594c7ddde61ae58019f550", "docker/login-action@v4"), /not pinned to a commit/],
    ["a secret of the repository", (source) => source.replace("secrets.GITHUB_TOKEN", "secrets.GHCR_PAT"), /GHCR_PAT/],
    ["all the secrets passed on", (source) => `${source}\n# secrets: inherit\n`, /secrets: inherit/],
    ["pull_request_target", (source) => source.replace("on:\n  workflow_call:", "on:\n  pull_request_target:\n  workflow_call:"), /pull_request_target/],
    ["a write on a pull request without the guard against forks", (source) => source.replace("on:\n  workflow_call:", "on:\n  pull_request:\n  workflow_call:"), /guard against forks/],
    ["a job that is not expected", (source) => `${source}  extra:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n    steps:\n      - run: echo\n`, /not one that the workflow is expected to have/],
  ];
  for (const [name, change, message] of faults) {
    it(`finds ${name}`, () => {
      const changed = change(text);
      expect(changed).not.toBe(text);
      expect(checkWorkflow(changed, expectation).join("\n")).toMatch(message);
    });
  }
});
