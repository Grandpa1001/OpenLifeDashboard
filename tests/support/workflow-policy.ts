// The rules a workflow that publishes must follow (DEV §9.60 D61.1, D61.4; Architektura Załącznik I): nothing is granted at the top, every job has exactly
// the permissions it needs, every action is pinned to a commit, the only secret is the built-in token, and no job that writes can be reached from a pull
// request of a fork. `checkWorkflow` returns what is wrong; the tests run it on the real files (nothing wrong) and on copies with one fault each (found).
import { parse } from "yaml";

export type Permissions = Readonly<Record<string, "read" | "write">>;
export type WorkflowExpectation = Readonly<{
  /** The permissions each job has, exactly; a job that is not here, or has others, is wrong. */
  jobs: Readonly<Record<string, Permissions>>;
}>;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const SECRET = /secrets\.([A-Za-z0-9_]+)/g;
const FORK_GUARD = /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/;

export function checkWorkflow(text: string, expectation: WorkflowExpectation): string[] {
  const problems: string[] = [];
  const workflow = parse(text) as unknown;
  if (!isObject(workflow)) return ["the file is not a workflow"];

  if (!isObject(workflow["permissions"]) || Object.keys(workflow["permissions"]).length > 0) problems.push("the workflow must grant nothing at the top (permissions: {})");
  const events = workflow["on"];
  const triggers = isObject(events) ? Object.keys(events) : typeof events === "string" ? [events] : Array.isArray(events) ? events.map(String) : [];
  if (triggers.includes("pull_request_target")) problems.push("pull_request_target runs with secrets on the code of a pull request");
  const jobs = isObject(workflow["jobs"]) ? workflow["jobs"] : {};

  for (const name of Object.keys(expectation.jobs)) if (!(name in jobs)) problems.push(`the job ${name} is missing`);
  for (const [name, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    const expected = expectation.jobs[name];
    if (expected === undefined) problems.push(`the job ${name} is not one that the workflow is expected to have`);
    const granted = job["permissions"];
    if (!isObject(granted)) problems.push(`the job ${name} must list its permissions (a missing list is the default of the repository)`);
    else {
      for (const [permission, level] of Object.entries(granted)) if (level !== "read" && level !== "write") problems.push(`the job ${name} has the permission ${permission}: ${String(level)}`);
      if (expected !== undefined && JSON.stringify(Object.entries(granted).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
        problems.push(`the job ${name} has the permissions ${JSON.stringify(granted)}, expected ${JSON.stringify(expected)}`);
      }
      if (triggers.includes("pull_request") && Object.values(granted).includes("write") && !FORK_GUARD.test(String(job["if"] ?? ""))) {
        problems.push(`the job ${name} writes and runs on pull requests without the guard against forks`);
      }
    }
    const uses = [job["uses"], ...(Array.isArray(job["steps"]) ? job["steps"].map((step) => (isObject(step) ? step["uses"] : undefined)) : [])];
    for (const used of uses) {
      if (typeof used !== "string" || used.startsWith("./")) continue;
      if (!PINNED.test(used)) problems.push(`the job ${name} uses ${used}, which is not pinned to a commit`);
    }
  }

  if (/permissions:\s*(write-all|read-all)/.test(text)) problems.push("write-all and read-all are not allowed");
  if (/secrets:\s*inherit/.test(text)) problems.push("secrets: inherit passes every secret to another workflow");
  for (const match of text.matchAll(SECRET)) if (match[1] !== "GITHUB_TOKEN") problems.push(`the secret ${match[1]} is used; the built-in token is the only one allowed`);
  return problems;
}
