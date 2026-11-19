// node scripts/check-commit-messages.ts --from <commit or empty> --to <commit>
// The first lines of the commits of a push or a pull request must be Conventional Commits (scripts/support/commit-messages.ts), because Release Please
// reads them. Prints each commit that does not follow the rule with the reason and exits 1; exits 0 when all do.
import { fileURLToPath } from "node:url";
import { commitProblems } from "./support/commit-messages.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function valueOf(args: readonly string[], flag: string): string {
  const at = args.indexOf(flag);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined) throw new Error(`usage: check-commit-messages --from <commit or ""> --to <commit> (${flag} is missing)`);
  return value;
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const problems = commitProblems(root, valueOf(args, "--from"), valueOf(args, "--to"));
  for (const entry of problems) console.error(`${entry.commit.slice(0, 12)} "${entry.subject}": ${entry.problem}`);
  if (problems.length > 0) {
    console.error(`${problems.length} commit(s) do not follow Conventional Commits (feat: ..., fix: ..., ci: ...); see the README, section Commit messages.`);
    process.exit(1);
  }
  console.log("every commit of the range follows Conventional Commits");
} catch (error) {
  console.error(`check-commit-messages: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
