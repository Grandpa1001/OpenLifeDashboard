// F08 (tests/fixtures/cases/bootstrap-v1.cases.json): turns a declared case into a concrete
// environment. Secrets are generated per run and never stored in the fixture or reports.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./server-process.ts";

export type BootstrapExpectation =
  | Readonly<{ kind: "ready"; normalizedBaseUrl?: string; updaterEnabled?: boolean }>
  | Readonly<{ kind: "error"; code: string; fields: readonly string[]; exitCode: number }>;

export type BootstrapCase = Readonly<{
  id: string;
  task: string;
  phase?: string;
  envPatch?: Readonly<Record<string, string | null>>;
  instancePatch?: Readonly<Record<string, unknown>>;
  databaseOverrides?: Readonly<Record<string, unknown>>;
  omitGeneratedSecrets?: readonly string[];
  extraGeneratedSecrets?: readonly string[];
  expected: BootstrapExpectation;
}>;

type Fixture = Readonly<{
  baseline: Readonly<{ env: Readonly<Record<string, string>>; generatedSecretKeys: readonly string[] }>;
  cases: readonly BootstrapCase[];
}>;

export const F08_FILE = path.join(repoRoot, "tests/fixtures/cases/bootstrap-v1.cases.json");

export function loadBootstrapCases(): Fixture {
  return JSON.parse(readFileSync(F08_FILE, "utf8")) as Fixture;
}

/** 32 CSPRNG bytes as 64 hex characters, the installer's secret format (Architektura §14.5). */
export const generateSecret = (): string => randomBytes(32).toString("hex");

export type CaseEnvironment = Readonly<{ env: Record<string, string>; secrets: readonly string[] }>;

export function environmentFor(fixture: Fixture, testCase: BootstrapCase): CaseEnvironment {
  const env: Record<string, string> = { ...fixture.baseline.env };
  const secretKeys = [
    ...fixture.baseline.generatedSecretKeys.filter((key) => !(testCase.omitGeneratedSecrets ?? []).includes(key)),
    ...(testCase.extraGeneratedSecrets ?? []),
  ];
  const secrets: string[] = [];
  for (const key of secretKeys) {
    const value = generateSecret();
    env[key] = value;
    secrets.push(value);
  }
  for (const [key, value] of Object.entries(testCase.envPatch ?? {})) {
    if (value === null) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return { env, secrets };
}
