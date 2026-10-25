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
    id: "D03.3",
    ready: true,
    title: "instance.json v1, installation paths and the paths CLI",
    criteria: ["D03.3-AC1", "D03.3-AC2", "D03.3-regression"],
    checks: [
      {
        // Runs first: the paths CLI test uses this build.
        id: "workspace-build",
        criteria: ["D03.3-AC1", "D03.3-AC2"],
        description: "pnpm -r build produces the server and its CLIs",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/cli/paths.ts", "apps/server/src/bootstrap/instance-metadata.ts"],
      },
      {
        id: "instance-metadata",
        criteria: ["D03.3-AC1", "D03.3-AC2"],
        description: "F08 D03.3 cases through the bootstrap; POSIX/Windows paths; malformed metadata refused",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/bootstrap/instance-metadata.test.ts"],
        requires: ["tests/unit/bootstrap/instance-metadata.test.ts", "tests/fixtures/cases/bootstrap-v1.cases.json"],
      },
      {
        id: "paths-cli",
        criteria: ["D03.3-AC1", "D03.3-AC2"],
        description: "Built paths CLI without env: same ID on restart; invalid metadata exits 1 without side effects",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/bootstrap/paths-cli.test.ts"],
        requires: ["tests/integration/bootstrap/paths-cli.test.ts"],
      },
      ...regressionChecks("D03.3-regression"),
    ],
  },
  {
    id: "D03.4",
    ready: true,
    title: "Storage preflight, test instances and the full server bootstrap",
    criteria: ["D03.4-AC1", "D03.4-AC2", "D03.4-AC3", "D03.4-regression"],
    checks: [
      {
        // Runs first: every check below starts the built server or its CLIs.
        id: "workspace-build",
        criteria: ["D03.4-AC1", "D03.4-AC2", "D03.4-AC3"],
        description: "pnpm -r build produces the server, its CLIs and the SPA",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/filesystem/storage-preflight.ts", "tests/support/test-instance.ts"],
      },
      {
        id: "storage-preflight",
        criteria: ["D03.4-AC1", "D03.4-AC2"],
        description: "Non-root probe on spaces/Unicode, fresh-folder refusal, RO/symlink/missing dirs, degraded logs",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/bootstrap/storage-preflight.test.ts"],
        requires: ["tests/integration/bootstrap/storage-preflight.test.ts", "scripts/prepare-test-instance.ts"],
      },
      {
        id: "container-preflight-native",
        criteria: ["D03.4-AC2"],
        description: "In the image as non-root: read-only FS, 32 MiB data mount below the reserve, degraded logs",
        command: ["node", "tests/system/container-preflight.ts"],
        requires: ["tests/system/container-preflight.ts", "docker/Dockerfile"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "full-bootstrap-f08",
        criteria: ["D03.4-AC3"],
        description: "All 17 F08 cases through the real server start and a secret scan of every run",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/bootstrap/full-bootstrap.test.ts"],
        requires: ["tests/integration/bootstrap/full-bootstrap.test.ts", "tests/fixtures/cases/bootstrap-v1.cases.json"],
      },
      ...regressionChecks("D03.4-regression"),
    ],
  },
  {
    // The parent passes only through its work orders, including the full bootstrap of D03.4.
    id: "D03",
    ready: true,
    title: "Bootstrap: environment, settings, instance metadata, paths and storage preflight",
    steps: ["D03.1", "D03.2", "D03.3", "D03.4"],
    criteria: [],
    checks: [],
  },
  {
    id: "D04.1",
    ready: true,
    title: "Writer lease, durable maintenance gate and their place in the server lifecycle",
    criteria: ["D04.1-AC1", "D04.1-AC2", "D04.1-regression"],
    checks: [
      {
        // Runs first: the tests start the built server and drive the built adapters.
        id: "workspace-build",
        criteria: ["D04.1-AC1", "D04.1-AC2"],
        description: "pnpm -r build produces the server with its lease and gate adapters",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/filesystem/writer-lease.ts", "apps/server/src/adapters/filesystem/maintenance-gate.ts"],
      },
      {
        id: "writer-lease-processes",
        criteria: ["D04.1-AC1"],
        description: "Two servers → one writer and INSTANCE_BUSY; SIGKILL recovery on the same lock file; no lease kept by a child",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/writer-lease.test.ts"],
        requires: ["tests/integration/maintenance/writer-lease.test.ts", "tests/support/writer-holder.ts"],
      },
      {
        id: "maintenance-gate-restarts",
        criteria: ["D04.1-AC2"],
        description: "Unfinished operation of a killed writer, unknown/unreadable/missing gate keep writes closed after restart",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/maintenance-gate.test.ts"],
        requires: ["tests/integration/maintenance/maintenance-gate.test.ts", "tests/support/writer-holder.ts"],
      },
      {
        id: "container-lease-native",
        criteria: ["D04.1-AC1", "D04.1-AC2"],
        description: "Containers on a shared bind mount: INSTANCE_BUSY, recovery after docker kill, host writer and its unfinished operation",
        command: ["node", "tests/system/container-lease.ts"],
        requires: ["tests/system/container-lease.ts", "docker/Dockerfile"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D04.1-regression"),
    ],
  },
  {
    id: "D04.2",
    ready: true,
    title: "SQLite connections with confirmed settings and the synchronous unit of work",
    criteria: ["D04.2-AC1", "D04.2-AC2", "D04.2-regression"],
    checks: [
      {
        // Runs first: the tests use the built core, sqlite and the native driver.
        id: "workspace-build",
        criteria: ["D04.2-AC1", "D04.2-AC2"],
        description: "pnpm -r build produces core/foundation and the sqlite connection and transactions",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/connection/open-database.ts", "packages/sqlite/src/transactions/unit-of-work.ts"],
      },
      {
        id: "unit-of-work-file-db",
        criteria: ["D04.2-AC1", "D04.2-AC2"],
        description: "PRAGMA read-back, commit/rollback across two ports, FK orphan, async guard, SIGKILL inside/after commit on a file",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/sqlite/unit-of-work.test.ts"],
        requires: ["tests/integration/sqlite/unit-of-work.test.ts", "tests/support/test-ports.ts", "tests/support/uow-crash.ts"],
      },
      {
        id: "unit-of-work-async-types",
        criteria: ["D04.2-AC2"],
        description: "Strict compiler rejects async and Promise-returning callbacks; a synchronous control compiles",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/foundation/unit-of-work-types.test.ts"],
        requires: ["tests/unit/foundation/unit-of-work-types.test.ts", "packages/core/src/foundation/unit-of-work.ts"],
      },
      ...regressionChecks("D04.2-regression"),
    ],
  },
  {
    id: "D04.3",
    ready: true,
    title: "Migration manifest, empty-database initialization and refusal of unknown databases",
    criteria: ["D04.3-AC1", "D04.3-AC2", "D04.3-regression"],
    checks: [
      {
        // Runs first: the tests start the built server and use the built migrations.
        id: "workspace-build",
        criteria: ["D04.3-AC1", "D04.3-AC2"],
        description: "pnpm -r build produces the migrations, the bootstrap database step and the server",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/public.ts", "apps/server/src/bootstrap/database.ts"],
      },
      {
        id: "migrations-file-db",
        criteria: ["D04.3-AC1", "D04.3-AC2"],
        description: "Plan checksums, atomic initialization, classification of pending/newer/foreign/tampered files without change",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/sqlite/migrations.test.ts", "tests/support/migration-plans.ts"],
      },
      {
        id: "database-bootstrap",
        criteria: ["D04.3-AC1", "D04.3-AC2"],
        description: "Real starts: init and two restarts, SIGKILL inside init, closing a committed init, refusals with unchanged files",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-bootstrap.test.ts"],
        requires: ["tests/integration/maintenance/database-bootstrap.test.ts", "tests/support/database-holder.ts"],
      },
      ...regressionChecks("D04.3-regression"),
    ],
  },
  {
    // The parent passes only through its work orders, D04.1 including the container check.
    id: "D04",
    ready: true,
    title: "Writer lease, maintenance gate, connections, unit of work and the first schema",
    steps: ["D04.1", "D04.2", "D04.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D05.1",
    ready: true,
    title: "Database snapshots through the SQLite Backup API and package verification",
    criteria: ["D05.1-AC1", "D05.1-AC2", "D05.1-regression"],
    checks: [
      {
        // Runs first: the tests use the built snapshot adapter, sqlite and the native driver.
        id: "workspace-build",
        criteria: ["D05.1-AC1", "D05.1-AC2"],
        description: "pnpm -r build produces the snapshot copy, the package format and the file adapter",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/snapshots/copy-database.ts", "apps/server/src/adapters/filesystem/database-snapshots.ts"],
      },
      {
        id: "database-snapshots-file-db",
        criteria: ["D05.1-AC1", "D05.1-AC2"],
        description: "WAL-only rows in a restored copy, package of exactly three files, invalid packages and refused sources",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-snapshots.test.ts"],
        requires: ["tests/integration/maintenance/database-snapshots.test.ts", "tests/support/migration-plans.ts"],
      },
      ...regressionChecks("D05.1-regression"),
    ],
  },
  {
    id: "D05.2",
    ready: true,
    title: "Upgrade of an existing database after a verified pre_migration snapshot",
    criteria: ["D05.2-AC1", "D05.2-AC2", "D05.2-regression"],
    checks: [
      {
        // Runs first: the tests use the built migrator, snapshot adapter and bootstrap step.
        id: "workspace-build",
        criteria: ["D05.2-AC1", "D05.2-AC2"],
        description: "pnpm -r build produces the migration runner and the upgrade flow of the bootstrap",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/migrate-database.ts", "apps/server/src/bootstrap/database.ts"],
      },
      {
        id: "database-upgrade",
        criteria: ["D05.2-AC1", "D05.2-AC2"],
        description: "B→C on real installations: snapshot before migration, one transaction, SIGKILL inside it, snapshot/SQL/orphan failures",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-upgrade.test.ts"],
        requires: ["tests/integration/maintenance/database-upgrade.test.ts", "tests/support/database-holder.ts"],
      },
      {
        id: "database-bootstrap-regression",
        criteria: ["D05.2-regression"],
        description: "D04.3 start, restart and refusal cases still hold with the real snapshot provider",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-bootstrap.test.ts"],
        requires: ["tests/integration/maintenance/database-bootstrap.test.ts"],
      },
      ...regressionChecks("D05.2-regression"),
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
