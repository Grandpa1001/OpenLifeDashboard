// The first line of a commit message, as Release Please reads it (Conventional Commits; DEV §9.60 D61.3): a type, an optional scope, an optional `!` for a
// breaking change, a colon and a description. The type decides the version of the next release: feat the minor, fix the patch. The commits of the owner
// go to main without a pull request, so a step of CI checks the range of a push. The commits up to the one that introduced the rule are not checked.
import { spawnSync } from "node:child_process";

export const COMMIT_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"] as const;
export const SUBJECT_MAX_LENGTH = 100;
/** The last commit made before the rule: it and its ancestors are exempt, every later commit must follow it. */
export const LEGACY_UNTIL = "87bbdcfbaf15277b9f35f0bcff7adfd6399492fa";
const SUBJECT = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`);

/** What is wrong with a first line, or null. A merge commit and the commit that `git revert` writes are not ours to rename. */
export function subjectProblem(subject: string): string | null {
  if (/^Merge /.test(subject) || /^Revert "/.test(subject)) return null;
  if (subject.length > SUBJECT_MAX_LENGTH) return `the first line is longer than ${SUBJECT_MAX_LENGTH} characters`;
  if (SUBJECT.test(subject)) return null;
  const type = /^([A-Za-z]+)(\(|!|:)/.exec(subject)?.[1];
  if (type !== undefined && !(COMMIT_TYPES as readonly string[]).includes(type)) return `the type '${type}' is not one of ${COMMIT_TYPES.join(", ")}`;
  return `the first line must be 'type: description' or 'type(scope): description' with a type of ${COMMIT_TYPES.join(", ")}, in lower case, and a description after ': '`;
}

export type CommitProblem = Readonly<{ commit: string; subject: string; problem: string }>;

function git(root: string, args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

/** The commits of `from..to` (only `to` when `from` is empty or not a commit of this clone, e.g. the first push of a branch) that do not follow the rule. */
export function commitProblems(root: string, from: string, to: string, legacyUntil: string = LEGACY_UNTIL): CommitProblem[] {
  const known = from !== "" && !/^0+$/.test(from) && git(root, ["cat-file", "-e", `${from}^{commit}`]).status === 0;
  const listed = git(root, ["log", "--format=%H%x1f%s", ...(known ? [`${from}..${to}`] : ["-1", to])]);
  if (listed.status !== 0) throw new Error(`git log could not list ${known ? `${from}..${to}` : to}`);
  const legacyKnown = git(root, ["cat-file", "-e", `${legacyUntil}^{commit}`]).status === 0;
  const problems: CommitProblem[] = [];
  for (const line of listed.stdout.split("\n").filter((each) => each !== "")) {
    const [commit = "", subject = ""] = line.split("\x1f");
    if (legacyKnown && git(root, ["merge-base", "--is-ancestor", commit, legacyUntil]).status === 0) continue;
    const problem = subjectProblem(subject);
    if (problem !== null) problems.push({ commit, subject, problem });
  }
  return problems;
}
