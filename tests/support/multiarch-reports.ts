// Combines verify:task reports produced on linux/amd64 and linux/arm64 hosts (DEV D02.3-AC3).
// A report counts only when it passed, refers to the expected clean commit and carries
// execution evidence: a build without a run never closes D02.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isJsonObject, type JsonObject } from "../../scripts/support/workspaces.ts";
import { nodeArchFor, type DockerArch } from "./docker.ts";

export const REQUIRED_ARCHES: readonly DockerArch[] = ["amd64", "arm64"];
export type Verdict = "passed" | "failed" | "blocked";
export type ArchVerdict = Readonly<{ arch: DockerArch; verdict: Verdict; reasons: readonly string[]; reports: readonly string[] }>;

type LoadedReport = Readonly<{ file: string; report: JsonObject }>;
type EvidenceRule = Readonly<{ file: (arch: DockerArch) => string; executed: (evidence: JsonObject, arch: DockerArch) => boolean }>;

const field = (value: unknown, key: string): unknown => (isJsonObject(value) ? value[key] : undefined);

/** What each per-architecture step must prove it actually ran, beyond a passed result. */
const EVIDENCE: Readonly<Record<string, EvidenceRule>> = {
  "D02.2": {
    file: (arch) => `image-${arch}.json`,
    executed: (evidence, arch) => {
      const probe = evidence["probe"];
      return (
        field(probe, "platform") === "linux" &&
        field(probe, "arch") === nodeArchFor(arch) &&
        field(probe, "rowsAfterCommit") === 3 &&
        field(probe, "rowsAfterRollback") === 3 &&
        field(probe, "rowsAfterReopen") === 3
      );
    },
  },
  "D02.3": {
    file: (arch) => `container-${arch}.json`,
    executed: (evidence) =>
      Array.isArray(evidence["responses"]) &&
      evidence["responses"].length >= 4 &&
      evidence["healthcheck"] === "healthy" &&
      field(evidence["stop"], "exitCode") === 0,
  },
};
export const REQUIRED_TASKS = Object.keys(EVIDENCE);

function loadReports(dir: string): LoadedReport[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }).map(String);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => path.basename(entry) === "verification.json")
    .flatMap((entry) => {
      const file = path.join(dir, entry);
      try {
        const report: unknown = JSON.parse(readFileSync(file, "utf8"));
        return isJsonObject(report) ? [{ file, report }] : [];
      } catch {
        return [];
      }
    });
}

function readEvidence(loaded: LoadedReport, name: string): JsonObject | undefined {
  const checks = loaded.report["checks"];
  const files = Array.isArray(checks) ? checks.flatMap((check) => {
    const evidence = field(check, "evidence");
    return Array.isArray(evidence) ? evidence.map(String) : [];
  }) : [];
  const match = files.find((file) => path.basename(file) === name);
  if (!match) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(path.dirname(loaded.file), match), "utf8"));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function evaluateArchReports(dir: string, expectedCommit: string): ArchVerdict[] {
  const reports = loadReports(dir);
  return REQUIRED_ARCHES.map((arch) => {
    const reasons: string[] = [];
    const used: string[] = [];
    let failed = false;
    let blocked = false;
    for (const task of REQUIRED_TASKS) {
      const candidates = reports
        .filter(({ report }) => report["task"] === task)
        .filter(({ report }) => field(report["environment"], "arch") === nodeArchFor(arch) && field(report["environment"], "platform") === "linux")
        .sort((a, b) => String(a.report["finishedAt"]).localeCompare(String(b.report["finishedAt"])));
      const latest = candidates.at(-1);
      const rule = EVIDENCE[task];
      if (!latest || !rule) {
        blocked = true;
        reasons.push(`no ${task} report from a linux/${arch} host`);
        continue;
      }
      used.push(path.relative(dir, latest.file));
      const code = latest.report["code"];
      if (latest.report["result"] !== "passed") {
        failed = true;
        reasons.push(`${task} on ${arch} is ${String(latest.report["result"])}`);
      }
      if (field(code, "commit") !== expectedCommit || field(code, "dirty") !== false) {
        failed = true;
        reasons.push(`${task} on ${arch} refers to ${String(field(code, "commit"))} (dirty: ${String(field(code, "dirty"))}), expected clean ${expectedCommit}`);
      }
      const evidence = readEvidence(latest, rule.file(arch));
      if (!evidence || !rule.executed(evidence, arch)) {
        failed = true;
        reasons.push(`${task} on ${arch} has no execution evidence (${rule.file(arch)})`);
      }
    }
    const verdict: Verdict = failed ? "failed" : blocked ? "blocked" : "passed";
    return { arch, verdict, reasons, reports: used };
  });
}
