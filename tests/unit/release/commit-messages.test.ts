// D61.3-AC2 — the first line of a commit as Release Please reads it, and the check of a range of commits of a real (temporary) repository: the types
// feat, fix and the rest with a scope or a `!` pass; no type, an unknown type, a type in capitals, no description and a line that is too long do not;
// a merge commit and the commit `git revert` writes pass; the commits up to the one that introduced the rule are not looked at.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { COMMIT_TYPES, commitProblems, LEGACY_UNTIL, subjectProblem } from "../../../scripts/support/commit-messages.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "openlife-commit-messages-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("D61.3-AC2 the first line of a commit", () => {
  const accepted = [
    "feat: D61.2 assemble and check the files of a release",
    "fix: D61.1 give the publication test the time a cold build needs",
    "ci: retry the install of the browser",
    "feat(installer): ask for the owner",
    "fix(release-images): lower case owner",
    "feat!: the first line of a breaking change",
    "refactor(core)!: move the port",
    "chore(main): release 0.1.0",
    "build(deps): bump hono from 4.13.12 to 4.13.13",
    "revert: feat: D61.2 assemble",
    'Merge pull request 12 from owner/branch',
    'Revert "feat: D61.2 assemble"',
    ...COMMIT_TYPES.map((type) => `${type}: x`),
  ];
  for (const subject of accepted) {
    it(`passes ${JSON.stringify(subject)}`, () => {
      expect(subjectProblem(subject)).toBeNull();
    });
  }

  const refused: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["a title without a type", "D61.2", /must be 'type: description'/],
    ["a title in prose", "Add the security headers to every response", /must be 'type: description'/],
    ["a type that is not known", "feature: add a thing", /the type 'feature' is not one of/],
    ["a type in capitals", "Feat: add a thing", /must be 'type: description'|type 'Feat'/],
    ["a colon without a space", "feat:add a thing", /must be 'type: description'/],
    ["no description", "feat: ", /must be 'type: description'/],
    ["a scope in capitals", "feat(Installer): add a thing", /must be 'type: description'/],
    ["an empty scope", "feat(): add a thing", /must be 'type: description'/],
    ["a line that is too long", `feat: ${"x".repeat(100)}`, /longer than 100/],
    ["an empty line", "", /must be 'type: description'/],
  ];
  for (const [name, subject, message] of refused) {
    it(`refuses ${name}`, () => {
      expect(subjectProblem(subject)).toMatch(message);
    });
  }
});

describe("D61.3-AC2 a range of commits of a repository", () => {
  const dir = path.join(root, "repository");
  const git = (...args: string[]): string => {
    const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (subject: string): string => {
    writeFileSync(path.join(dir, "file.txt"), `${subject}\n${Math.random()}`);
    git("add", "file.txt");
    git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  spawnSync("mkdir", ["-p", dir]);
  git("init", "-q", "-b", "main");
  const legacyOne = commit("D60.4");
  const legacyTwo = commit("Copy every file of docker to the tree of the PowerShell rig");
  const good = commit("feat: D61.3 set up the versions");
  const bad = commit("D61.4 a commit without a type");
  const also = commit("fix: D61.4 one that is right");
  const merged = commit("Merge branch 'x'");

  it("passes the commits up to the one that introduced the rule, whatever they say, and lists the ones after it that are wrong", () => {
    const found = commitProblems(dir, legacyOne, merged, legacyTwo);
    expect(found.map((entry) => entry.commit)).toEqual([bad]);
    expect(found[0]?.subject).toBe("D61.4 a commit without a type");
    expect(found[0]?.problem).toMatch(/must be 'type: description'/);
    expect(good).not.toBe(also);
  });

  it("checks every commit of the range and none before it", () => {
    expect(commitProblems(dir, bad, merged, legacyTwo)).toEqual([]);
    expect(commitProblems(dir, good, merged, legacyTwo).map((entry) => entry.commit)).toEqual([bad]);
  });

  it("checks only the last commit when there is no base: the first push of a branch, or a base that is not here", () => {
    expect(commitProblems(dir, "", bad, legacyTwo).map((entry) => entry.commit)).toEqual([bad]);
    expect(commitProblems(dir, "0".repeat(40), also, legacyTwo)).toEqual([]);
    expect(commitProblems(dir, "f".repeat(40), bad, legacyTwo).map((entry) => entry.commit)).toEqual([bad]);
  });

  it("looks at every commit when the commit of the rule is not known to the clone", () => {
    expect(commitProblems(dir, "", bad, "e".repeat(40)).map((entry) => entry.commit)).toEqual([bad]);
    expect(commitProblems(dir, legacyOne, also, "e".repeat(40)).map((entry) => entry.commit).sort()).toEqual([legacyTwo, bad].sort());
  });

  it("names the commit of the rule by its full hash (a shallow clone has no such commit, so the check of CI clones the whole history)", () => {
    expect(LEGACY_UNTIL).toMatch(/^[0-9a-f]{40}$/);
  });
});
