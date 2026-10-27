// Handover of the auth and setup work (DEV §8.4, D13.3): joins the verify:task reports of D09–D13
// that refer to exactly the code being checked and decides, item by item, from the logs of the
// checks that ran them — every F09 flow (read from the fixture, so none can be left out), the
// policy cases and the mandatory items: rotation, replay, Origin, acknowledgment, no way around
// the auth, atomic audit, no secrets, the browser flow. The report names the adapter versions, the
// hashes of what the decisions rest on, and what was not run. A missing report or item is blocked,
// a failed or absent assertion fails, none is dropped from the result.
// Reports come from OPENLIFE_HANDOVER_REPORTS_DIR (default .artifacts; CI keeps them there).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describeCode } from "../../scripts/support/code-state.ts";
import { BLOCKED_EXIT_CODE, EVIDENCE_DIR_ENV } from "../../tooling/verification-tasks.ts";
import { repoRoot } from "../support/repository-copy.ts";
import { FLOW_EVIDENCE, HANDOVER_REPORTS, MANDATORY_EVIDENCE, NOT_RUN, POLICY_EVIDENCE, type HandoverItem } from "./auth-handover-matrix.ts";
import { judgeEvidence, latestReports, loadReports, worst, type Verdict } from "./report-join.ts";

const reportsDir = path.resolve(repoRoot, process.env["OPENLIFE_HANDOVER_REPORTS_DIR"] ?? ".artifacts");
const fixturePath = process.env["OPENLIFE_HANDOVER_FIXTURE"] ?? path.join(repoRoot, "tests/fixtures/cases/auth-v1.cases.json");
const code = describeCode(repoRoot);
const reports = latestReports(loadReports(reportsDir), HANDOVER_REPORTS, code);

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const read = (file: string): string => readFileSync(path.join(repoRoot, file), "utf8");

// The flows of the fixture: each needs evidence here, and evidence here for a flow that is not in
// the fixture is as much a mismatch.
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { flows: ReadonlyArray<{ id: string; task: string }>; policyCases: readonly unknown[] };
const fixtureFlows = fixture.flows.map((entry) => entry.id);
const flowItems: HandoverItem[] = fixtureFlows.map(
  (id) => FLOW_EVIDENCE.find((entry) => entry.id === id) ?? { id, group: "F09 flow", title: `${id} (no evidence is named for it)`, evidence: [] },
);
const orphanFlows = FLOW_EVIDENCE.filter((entry) => !fixtureFlows.includes(entry.id)).map((entry) => entry.id);
const items: HandoverItem[] = [...flowItems, ...POLICY_EVIDENCE, ...MANDATORY_EVIDENCE];

console.log(`Auth and setup handover for ${String(code["commit"]).slice(0, 7)}${code["dirty"] ? " with uncommitted changes" : ""}, reports from ${path.relative(repoRoot, reportsDir) || reportsDir}`);
const reportResults = HANDOVER_REPORTS.map((task) => {
  const source = reports.get(task);
  const verdict: Verdict = !source ? "blocked" : source.report["result"] === "passed" ? "passed" : "failed";
  console.log(`  ${verdict.padEnd(7)} report ${task}${source ? ` (${String(source.report["runId"])}, ${String(source.report["result"])})` : " — none for this code"}`);
  return { task, verdict, runId: source?.report["runId"] ?? null, environment: source?.report["environment"] ?? null };
});

const itemResults = items.map((item) => {
  const judged = item.evidence.map((evidence) => ({ ...evidence, ...judgeEvidence(reports, evidence) }));
  // An item with no evidence named is a missing mandatory test, not a pass.
  const verdict: Verdict = judged.length === 0 ? "failed" : worst(judged.map((entry) => entry.verdict));
  console.log(`  ${verdict.padEnd(7)} ${item.group}: ${item.id} — ${item.title}`);
  if (judged.length === 0) console.log("            failed: no evidence is named for it");
  for (const entry of judged.filter((each) => each.verdict !== "passed")) console.log(`            ${entry.verdict}: ${entry.detail} — "${entry.line}"`);
  return { id: item.id, group: item.group, title: item.title, verdict, evidence: judged };
});
for (const id of orphanFlows) console.log(`  failed  evidence for ${id}, which is not a flow of the fixture`);

const policyCases = fixture.policyCases.length;
const policyCountOk = policyCases === 31;
if (!policyCountOk) console.log(`  failed  the fixture has ${policyCases} policy cases, the handover expects 31`);

const result = worst([...reportResults, ...itemResults.map((entry) => ({ verdict: entry.verdict })), ...orphanFlows.map(() => ({ verdict: "failed" as Verdict })), { verdict: policyCountOk ? ("passed" as Verdict) : "failed" }].map((entry) => entry.verdict));

// What the decisions rest on: the versions of the adapters, and the hashes of the files whose change should be noticed.
const catalog = read("pnpm-workspace.yaml");
const versionOf = (name: string): string => new RegExp(`^\\s*"?${name.replaceAll("/", "\\/")}"?:\\s*([^\\s#]+)`, "m").exec(catalog)?.[1] ?? "unknown";
const migrationsDir = path.join(repoRoot, "packages/sqlite/src/migrations");
const hashed = [
  "tests/fixtures/cases/auth-v1.cases.json",
  "packages/core/src/modules/identity/domain/access-policy.ts",
  "tests/support/route-inventory.ts",
  "tests/verification/auth-handover-matrix.ts",
  ...readdirSync(migrationsDir)
    .filter((name) => /^000[2-9]-/.test(name))
    .sort()
    .map((name) => `packages/sqlite/src/migrations/${name}`),
].map((file) => ({ file, sha256: sha256(path.join(repoRoot, file)) }));
const adapters = {
  "better-auth": versionOf("better-auth"),
  "@node-rs/argon2": versionOf("@node-rs/argon2"),
  "@better-auth/utils": versionOf("@better-auth/utils"),
  hono: versionOf("hono"),
  "better-sqlite3": versionOf("better-sqlite3"),
  uqr: versionOf("uqr"),
};
console.log(`  adapters: ${Object.entries(adapters).map(([name, version]) => `${name} ${version}`).join(", ")}`);
console.log(`  hashed files: ${hashed.length}; not run: ${NOT_RUN.map((entry) => `${entry.item} (${entry.task})`).join("; ")}`);
console.log(`Auth and setup handover ${result}: ${itemResults.filter((entry) => entry.verdict === "passed").length} of ${itemResults.length} items passed`);

const evidenceDir = process.env[EVIDENCE_DIR_ENV];
if (evidenceDir) {
  writeFileSync(
    path.join(evidenceDir, "auth-handover.json"),
    `${JSON.stringify({ code, reportsDir, result, reports: reportResults, items: itemResults, orphanFlows, adapters, hashed, notRun: NOT_RUN }, null, 2)}\n`,
  );
}
process.exitCode = result === "passed" ? 0 : result === "blocked" ? BLOCKED_EXIT_CODE : 1;
