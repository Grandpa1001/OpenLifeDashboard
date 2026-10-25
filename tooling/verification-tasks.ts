// The single map from DEV tasks, work orders and gates to the checks that prove them
// (DEV §8.3). `pnpm verify:task -- <ID>` reads it; each new step adds its own entry.
// IDs without checks stay "not ready" so the runner reports blocked instead of success.

/**
 * Exit code a check uses when a precondition it needs is unavailable (no git checkout,
 * missing tool, no network). The runner reports it as blocked, never as failed or passed.
 */
export const BLOCKED_EXIT_CODE = 78;

/**
 * Environment variable with a per-check directory where a check may save evidence (e.g. HTTP
 * responses); the runner lists the saved files in the report. Unset outside verify:task.
 */
export const EVIDENCE_DIR_ENV = "OPENLIFE_VERIFY_EVIDENCE_DIR";

export type CheckDefinition = Readonly<{
  id: string;
  /** Acceptance criteria this check provides evidence for, e.g. "D01.1-AC1". */
  criteria: readonly string[];
  description: string;
  /** argv without a shell; "node" and "pnpm" resolve to the pinned toolchain. */
  command: readonly [string, ...string[]];
  /** Repository files the check needs; a missing one makes the check blocked. */
  requires: readonly string[];
  timeoutMs?: number;
}>;

export type TaskDefinition =
  | Readonly<{ id: string; ready: false }>
  | Readonly<{
      id: string;
      ready: true;
      title: string;
      /** Every criterion must be covered by a check, otherwise it is blocked. */
      criteria: readonly string[];
      checks: readonly CheckDefinition[];
      /** Work orders that must all pass before the parent (and its smoke) can pass. */
      steps?: readonly string[];
    }>;

const TASK_COUNT = 66;
const GATE_COUNT = 8;
/** Work orders specified in DEV §9.4/§9.6/§9.7, per parent task. */
const WORK_ORDER_COUNTS: Readonly<Record<string, number>> = {
  D01: 3, D02: 3, D03: 4, D04: 3, D05: 3, D06: 3, D07: 3, D08: 3, D09: 4, D10: 3, D11: 4, D12: 3, D13: 3,
};
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

const architectureCheck: CheckDefinition = {
  id: "check-architecture",
  criteria: ["D01.2-AC1", "D01.2-AC2"],
  description: "Repository import graph is clean and every synthetic negative graph is rejected",
  command: ["node", "scripts/check-architecture.ts"],
  requires: [
    "scripts/check-architecture.ts",
    "tests/architecture/cases.ts",
    "tooling/dependency-cruiser/config.cjs",
    "tooling/eslint/config.js",
  ],
};

const defined: readonly TaskDefinition[] = [
  {
    id: "D00",
    ready: true,
    title: "Specification review",
    criteria: ["D00-smoke"],
    checks: [
      {
        id: "verify-specs",
        criteria: ["D00-smoke"],
        description: "Local specification and fixtures pass their validator (Analiza/ is not versioned)",
        command: ["python3", "Analiza/scripts/verify_specs.py", "--self-test"],
        requires: ["Analiza/scripts/verify_specs.py"],
      },
    ],
  },
  {
    id: "D01",
    ready: true,
    title: "Product monorepo foundation",
    steps: ["D01.1", "D01.2", "D01.3"],
    criteria: ["D01-smoke"],
    checks: [
      {
        id: "clean-checkout-smoke",
        criteria: ["D01-smoke"],
        description: "A fresh copy installs, builds, type-checks, lints and passes both boundary checks",
        command: ["node", "tests/workspace/clean-checkout.ts", "--through=all"],
        requires: ["tests/workspace/clean-checkout.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
    ],
  },
  {
    id: "D01.1",
    ready: true,
    title: "Workspace, pinned toolchain and strict build",
    criteria: ["D01.1-AC1", "D01.1-AC2", "D01.1-AC3"],
    checks: [
      {
        id: "clean-checkout-build",
        criteria: ["D01.1-AC1", "D01.1-AC3"],
        description: "Fresh copy: frozen install and recursive build on the declared Node cover all five packages",
        command: ["node", "tests/workspace/clean-checkout.ts", "--through=build"],
        requires: ["tests/workspace/clean-checkout.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
      {
        id: "lockfile-drift",
        criteria: ["D01.1-AC2"],
        description: "A manifest that no longer matches the lockfile fails the frozen install",
        command: ["node", "tests/workspace/lockfile-drift.ts"],
        requires: ["tests/workspace/lockfile-drift.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
      {
        id: "strict-types",
        criteria: ["D01.1-AC3"],
        description: "Strict compiler options reject a control type error in a test copy",
        command: ["node", "tests/workspace/strict-types.ts"],
        requires: ["tests/workspace/strict-types.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
    ],
  },
  {
    id: "D01.2",
    ready: true,
    title: "Architecture and contract checks",
    criteria: ["D01.2-AC1", "D01.2-AC2", "D01.2-AC3"],
    checks: [
      architectureCheck,
      {
        id: "check-contracts",
        criteria: ["D01.2-AC1"],
        description: "Package exports, build artifacts and runtime loading match the contract",
        command: ["node", "scripts/check-contracts.ts"],
        requires: ["scripts/check-contracts.ts", "tests/contracts/cases.ts", "scripts/support/manifest-policy.ts"],
      },
      {
        id: "architecture-control-coverage",
        criteria: ["D01.2-AC2"],
        description: "Every boundary rule and ARCH-01…05 has a negative control, incl. indirect SQLite and deep import",
        command: ["node", "tests/architecture/coverage.ts"],
        requires: ["tests/architecture/coverage.ts", "tests/architecture/cases.ts"],
      },
      {
        id: "faulty-graph",
        criteria: ["D01.2-AC3"],
        description: "In a test copy, a forbidden graph and a wildcard export make the checks exit nonzero",
        command: ["node", "tests/workspace/faulty-graph.ts"],
        requires: ["tests/workspace/faulty-graph.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
    ],
  },
  {
    id: "D01.3",
    ready: true,
    title: "Verification runner and CI",
    criteria: ["D01.3-AC1", "D01.3-AC2", "D01.3-AC3"],
    checks: [
      {
        id: "runner-self-test",
        criteria: ["D01.3-AC1", "D01.3-AC2", "D01.3-AC3"],
        description: "The runner on an isolated task map: report fields, passed/failed/blocked, unknown ID, parent gating",
        command: ["node", "tests/verification/runner.ts"],
        requires: ["tests/verification/runner.ts", "scripts/verify-task.ts"],
      },
      {
        id: "ci-workflow",
        criteria: ["D01.3-AC3"],
        description: "CI installs with the frozen lockfile and runs the same runner for D01",
        command: ["node", "tests/verification/ci-workflow.ts"],
        requires: ["tests/verification/ci-workflow.ts", ".github/workflows/ci.yml"],
      },
    ],
  },
];

/** Repository-wide checks every implementation step repeats (CLAUDE.md step 5). */
function regressionChecks(criterion: string): CheckDefinition[] {
  const script = (name: string, file: string): CheckDefinition => ({
    id: `regression-${name.replace(":", "-")}`,
    criteria: [criterion],
    description: `pnpm ${name} still passes`,
    command: ["pnpm", "run", name],
    requires: [file],
  });
  return [
    script("typecheck", "tsconfig.tooling.json"),
    script("lint", "eslint.config.js"),
    script("check:architecture", "scripts/check-architecture.ts"),
    script("check:contracts", "scripts/check-contracts.ts"),
  ];
}

const definedLater: readonly TaskDefinition[] = [
  {
    id: "D02.1",
    ready: true,
    title: "HTTP server, SPA build and production serving",
    criteria: ["D02.1-AC1", "D02.1-AC2", "D02.1-AC3", "D02.1-regression"],
    checks: [
      {
        // Runs first: the HTTP tests exercise these build artifacts.
        id: "workspace-build",
        criteria: ["D02.1-AC1"],
        description: "pnpm -r build produces the server (tsc) and the SPA (Vite)",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts", "apps/web/vite.config.ts", "apps/web/index.html"],
      },
      {
        id: "http-integration",
        criteria: ["D02.1-AC1", "D02.1-AC2", "D02.1-AC3"],
        description: "Built server over real HTTP: health, SPA reload, API/asset 404, exposure, SIGTERM",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/http"],
        requires: ["tests/integration/http/server.test.ts", "tests/support/server-process.ts", "vitest.config.ts"],
      },
      ...regressionChecks("D02.1-regression"),
    ],
  },
  {
    id: "D02.2",
    ready: true,
    // Verifies the host's native architecture only; CI runs it on linux/amd64 and linux/arm64
    // runners, and D02.3 combines both reports. Without Docker the check is blocked.
    title: "App image with the native SQLite driver (host architecture)",
    criteria: ["D02.2-AC1", "D02.2-AC2", "D02.2-regression"],
    checks: [
      {
        id: "sqlite-image-native",
        criteria: ["D02.2-AC1", "D02.2-AC2"],
        description: "Native docker build, non-root image, driver probe counts, forced failure and missing module",
        command: ["node", "tests/system/sqlite-image.ts"],
        requires: ["docker/Dockerfile", ".dockerignore", "tests/system/sqlite-image.ts", "tests/support/docker.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D02.2-regression"),
    ],
  },
  {
    id: "D02.3",
    ready: true,
    // Like D02.2 it verifies the host's native architecture; D02 joins both architectures.
    title: "App container start/stop (host architecture) and the D02 report join",
    criteria: ["D02.3-AC1", "D02.3-AC2", "D02.3-AC3", "D02.3-regression"],
    checks: [
      {
        id: "container-lifecycle-native",
        criteria: ["D02.3-AC1", "D02.3-AC2"],
        description: "Container serves health/SPA/API 404, reports healthy, stops on SIGTERM; bad start args exit 1",
        command: ["node", "tests/system/container-lifecycle.ts"],
        requires: ["docker/Dockerfile", "tests/system/container-lifecycle.ts", "tests/support/docker.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "multiarch-join-rules",
        criteria: ["D02.3-AC3"],
        description: "D02 joins passed, current, executed reports of both architectures; CI wiring",
        command: ["node", "tests/verification/d02-multiarch.ts"],
        requires: ["tests/verification/d02-multiarch.ts", "tests/support/multiarch-reports.ts"],
      },
      ...regressionChecks("D02.3-regression"),
    ],
  },
  {
    id: "D03.1",
    ready: true,
    title: "Private environment parser, public bootstrap DTO and F08 harness",
    criteria: ["D03.1-AC1", "D03.1-AC2", "D03.1-regression"],
    checks: [
      {
        // Runs first: the CLI, server and asset checks below use these build artifacts.
        id: "workspace-build",
        criteria: ["D03.1-AC1", "D03.1-AC2"],
        description: "pnpm -r build produces the server, its CLIs and the SPA",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/cli/config-check.ts", "apps/server/src/bootstrap/environment.ts"],
      },
      {
        id: "f08-environment-cases",
        criteria: ["D03.1-AC1"],
        description: "Every F08 case of D03.1 through the parser and the config-check CLI (codes, fields, exit 1)",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/bootstrap"],
        requires: ["tests/unit/bootstrap/environment.test.ts", "tests/fixtures/cases/bootstrap-v1.cases.json"],
      },
      {
        id: "secret-marker-scan",
        criteria: ["D03.1-AC2"],
        description: "Random secret markers absent from CLI output, an isolated server and the built assets",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/bootstrap"],
        requires: ["tests/integration/bootstrap/secret-exposure.test.ts"],
      },
      ...regressionChecks("D03.1-regression"),
    ],
  },
  {
    id: "D03.2",
    ready: true,
    title: "Settings catalog and pure resolver (default < DB < env)",
    criteria: ["D03.2-AC1", "D03.2-AC2", "D03.2-regression"],
    checks: [
      {
        // Runs first: the config-check CLI used by the F08 cases comes from this build.
        id: "workspace-build",
        criteria: ["D03.2-AC1"],
        description: "pnpm -r build produces the server, its CLIs and the SPA",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/contracts/src/settings/catalog.ts", "packages/core/src/modules/settings/public.ts"],
      },
      {
        id: "settings-resolution",
        criteria: ["D03.2-AC1", "D03.2-AC2"],
        description: "F08 D03.2 cases, whole-set rejection without partial results, no env/fs in core/settings",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/settings"],
        requires: ["tests/unit/settings/resolve-settings.test.ts", "tests/fixtures/cases/bootstrap-v1.cases.json"],
      },
      ...regressionChecks("D03.2-regression"),
    ],
  },
  {
    id: "D02",
    ready: true,
    title: "HTTP/SPA foundation and native app image on amd64 and arm64",
    steps: ["D02.1", "D02.2", "D02.3"],
    criteria: ["D02-multiarch"],
    checks: [
      {
        id: "multiarch-reports",
        criteria: ["D02-multiarch"],
        description: "D02.2/D02.3 reports from linux/amd64 and linux/arm64 hosts passed for this commit",
        command: ["node", "tests/system/multiarch-reports.ts"],
        requires: ["tests/system/multiarch-reports.ts", "tests/support/multiarch-reports.ts"],
      },
    ],
  },
];

function notReady(id: string): TaskDefinition {
  return { id, ready: false };
}

function allIds(): string[] {
  const ids: string[] = [];
  for (let task = 0; task < TASK_COUNT; task += 1) {
    const parent = `D${String(task).padStart(2, "0")}`;
    ids.push(parent);
    for (let step = 1; step <= (WORK_ORDER_COUNTS[parent] ?? 0); step += 1) {
      ids.push(`${parent}.${step}`);
    }
  }
  for (let gate = 0; gate < GATE_COUNT; gate += 1) {
    ids.push(`G${gate}`);
  }
  return ids;
}

const definedById = new Map([...defined, ...definedLater].map((task) => [task.id, task]));

export const verificationTasks: readonly TaskDefinition[] = allIds().map(
  (id) => definedById.get(id) ?? notReady(id),
);
