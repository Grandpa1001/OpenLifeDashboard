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
    id: "D05.3",
    ready: true,
    title: "Reconciliation of an interrupted upgrade and snapshot failures on a real file system",
    criteria: ["D05.3-AC1", "D05.3-AC2", "D05.3-regression"],
    checks: [
      {
        // Runs first: the tests use the built snapshot adapter, bootstrap step and server.
        id: "workspace-build",
        criteria: ["D05.3-AC1", "D05.3-AC2"],
        description: "pnpm -r build produces the snapshot recovery port and the resumable upgrade flow",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/filesystem/database-snapshots.ts", "apps/server/src/bootstrap/database.ts"],
      },
      {
        id: "database-recovery",
        criteria: ["D05.3-AC1", "D05.3-AC2"],
        description: "SIGKILL before/after publication and inside the migration, recognized snapshot, committed-not-closed, EACCES on publication",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-recovery.test.ts"],
        requires: ["tests/integration/maintenance/database-recovery.test.ts", "tests/support/database-fixtures.ts"],
      },
      {
        id: "container-snapshot-space-native",
        criteria: ["D05.3-AC2"],
        description: "In the image: ENOSPC on a 16 MiB backup file system, nothing published, good snapshot untouched, retry succeeds",
        command: ["node", "tests/system/container-snapshot-space.ts"],
        requires: ["tests/system/container-snapshot-space.ts", "tests/system/in-container/snapshot-space.mjs", "docker/Dockerfile"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "database-upgrade-regression",
        criteria: ["D05.3-regression"],
        description: "D05.2 upgrade cases and D04.3 start cases still hold with the resumable flow",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance/database-upgrade.test.ts", "tests/integration/maintenance/database-bootstrap.test.ts"],
        requires: ["tests/integration/maintenance/database-upgrade.test.ts", "tests/integration/maintenance/database-bootstrap.test.ts"],
      },
      ...regressionChecks("D05.3-regression"),
    ],
  },
  {
    // The parent passes only through its work orders, D05.3 including the container check.
    id: "D05",
    ready: true,
    title: "Database snapshots, upgrade after a snapshot and recovery",
    steps: ["D05.1", "D05.2", "D05.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D06.1",
    ready: true,
    title: "Technical logger with an allowlist, request IDs and safe handling of failures",
    criteria: ["D06.1-AC1", "D06.1-AC2", "D06.1-regression"],
    checks: [
      {
        // Runs first: the integration tests use the built logger, middleware and server.
        id: "workspace-build",
        criteria: ["D06.1-AC1", "D06.1-AC2"],
        description: "pnpm -r build produces the logger, the request log middleware and the HTTP foundation",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/logging/technical-logger.ts", "apps/server/src/http/foundation.ts"],
      },
      {
        id: "logger-unit",
        criteria: ["D06.1-AC1", "D06.1-AC2"],
        description: "Line shape and order, level filter, refused field values, error reduced to name/code/cause, failing sink",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/logging"],
        requires: ["tests/unit/logging/technical-logger.test.ts"],
      },
      {
        id: "request-log-http",
        criteria: ["D06.1-AC1", "D06.1-AC2"],
        description: "Same request ID in response, request line and error line; markers in headers/query/path/body/nested errors absent from stdout, stderr and app.jsonl",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/logging"],
        requires: ["tests/integration/logging/request-log.test.ts"],
      },
      {
        id: "http-regression",
        criteria: ["D06.1-regression"],
        description: "D02.1 HTTP behaviour and the D03 secret scan still hold with the logger in the app",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/http", "tests/integration/bootstrap/secret-exposure.test.ts"],
        requires: ["tests/integration/http/server.test.ts", "tests/integration/bootstrap/secret-exposure.test.ts"],
      },
      ...regressionChecks("D06.1-regression"),
    ],
  },
  {
    id: "D06.2",
    ready: true,
    title: "Log rotation, limits, bounded queue and the degraded state of the log file",
    criteria: ["D06.2-AC1", "D06.2-AC2", "D06.2-regression"],
    checks: [
      {
        // Runs first: the tests use the built sink, logger and server.
        id: "workspace-build",
        criteria: ["D06.2-AC1", "D06.2-AC2"],
        description: "pnpm -r build produces the rotating sink, the limit mapping and the log options of the catalog",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/logging/rotating-file-sink.ts", "packages/contracts/src/settings/catalog.ts"],
      },
      {
        id: "rotating-sink-file-system",
        criteria: ["D06.2-AC1", "D06.2-AC2"],
        description: "Rotation by size and count, retention by the clock, whole lines, 16 KiB/1 MiB limits, read-only folder, recovery, DB write while degraded",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/logging/rotating-file-sink.test.ts"],
        requires: ["tests/integration/logging/rotating-file-sink.test.ts", "tests/support/test-ports.ts"],
      },
      {
        id: "server-degraded-logs",
        criteria: ["D06.2-AC2"],
        description: "Built server with an unwritable log folder: serves, request lines on stdout, one notice; rotation options with defaults",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/logging/log-degraded.test.ts"],
        requires: ["tests/integration/logging/log-degraded.test.ts"],
      },
      {
        id: "container-log-space-native",
        criteria: ["D06.2-AC2"],
        description: "In the image: a log folder out of space (ENOSPC) → degraded, whole lines only, stdout complete, recovery after space is freed",
        command: ["node", "tests/system/container-log-space.ts"],
        requires: ["tests/system/container-log-space.ts", "tests/system/in-container/log-space.mjs", "docker/Dockerfile"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "logging-regression",
        criteria: ["D06.2-regression"],
        description: "D06.1 logger, request IDs and secret scans, the settings resolver and the F08 bootstrap cases still hold",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit", "tests/integration/logging/request-log.test.ts", "tests/integration/bootstrap"],
        requires: ["tests/integration/logging/request-log.test.ts", "tests/unit/settings/resolve-settings.test.ts"],
      },
      ...regressionChecks("D06.2-regression"),
    ],
  },
  {
    id: "D06.3",
    ready: true,
    title: "One ordered shutdown with a deadline: readiness, requests, logger, database, lease",
    criteria: ["D06.3-AC1", "D06.3-AC2", "D06.3-regression"],
    checks: [
      {
        // Runs first: the process tests start the built server.
        id: "workspace-build",
        criteria: ["D06.3-AC1", "D06.3-AC2"],
        description: "pnpm -r build produces the shutdown sequence, readiness and the drain",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/bootstrap/shutdown.ts", "apps/server/src/bootstrap/readiness.ts"],
      },
      {
        id: "shutdown-sequence-unit",
        criteria: ["D06.3-AC1", "D06.3-AC2"],
        description: "Step order and reports, deadline without a success event, failing step, ignored second signal (fake clock)",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/lifecycle"],
        requires: ["tests/unit/lifecycle/shutdown.test.ts"],
      },
      {
        id: "shutdown-process",
        criteria: ["D06.3-AC1", "D06.3-AC2"],
        description: "Real SIGTERM/SIGINT: readiness 503, request in progress finished, lease last, 15 s deadline with exit 1, intact database after it",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/lifecycle"],
        requires: ["tests/integration/lifecycle/shutdown.test.ts"],
        timeoutMs: 5 * 60 * 1000,
      },
      {
        id: "lifecycle-regression",
        criteria: ["D06.3-regression"],
        description: "D02.1 HTTP behaviour including SIGTERM, the D04.1 lease and gate cases and the D06 logging tests still hold",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/http", "tests/integration/maintenance/writer-lease.test.ts", "tests/integration/maintenance/maintenance-gate.test.ts", "tests/integration/logging"],
        requires: ["tests/integration/http/server.test.ts", "tests/integration/maintenance/writer-lease.test.ts"],
        timeoutMs: 5 * 60 * 1000,
      },
      ...regressionChecks("D06.3-regression"),
    ],
  },
  {
    // The parent passes only through its work orders, D06.2 including the container check.
    id: "D06",
    ready: true,
    title: "Technical logger, rotation and the ordered shutdown",
    steps: ["D06.1", "D06.2", "D06.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D07.1",
    ready: true,
    title: "Compose local mode: the app service, loopback publication and the mounts of §15.1",
    criteria: ["D07.1-AC1", "D07.1-AC2", "D07.1-regression"],
    checks: [
      {
        id: "compose-files-static",
        criteria: ["D07.1-AC1", "D07.1-AC2"],
        description: "Parsed compose files: one service, no image, loopback port, three mounts, no socket, non-root, env list, healthcheck via node, 20 s grace",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/compose"],
        requires: ["docker/compose.yml", "docker/compose.local.yml", "tests/unit/compose/compose-files.test.ts"],
      },
      {
        id: "compose-instance-preparer",
        criteria: ["D07.1-AC2"],
        description: "The test installation for Compose: files, .env keys, project name, release override last, fresh folder only, no key printed",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/compose"],
        requires: ["tests/integration/compose/compose-instance.test.ts", "tests/support/compose-instance.ts", "scripts/prepare-test-instance.ts"],
      },
      {
        id: "compose-local-native",
        criteria: ["D07.1-AC1", "D07.1-AC2"],
        description: "Real docker compose: healthy, non-root, 127.0.0.1:PORT→8080 only, three mounts, no socket, listed variables only, stop within 20 s",
        command: ["node", "tests/system/compose-local.ts"],
        requires: ["tests/system/compose-local.ts", "docker/Dockerfile", "docker/compose.yml"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D07.1-regression"),
    ],
  },
  {
    id: "D07.2",
    ready: true,
    title: "Persistence on real mounts: restarts, recreate, and no installation without its mounts",
    criteria: ["D07.2-AC1", "D07.2-AC2", "D07.2-regression"],
    checks: [
      {
        // Runs first: the system test reads the installation from the host with the built adapters.
        id: "workspace-build",
        criteria: ["D07.2-AC1", "D07.2-AC2"],
        description: "pnpm -r build produces the mount check of the preflight and the adapters the test reads with",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/filesystem/mounts.ts", "apps/server/src/adapters/filesystem/storage-preflight.ts"],
      },
      {
        id: "mount-table-and-preflight",
        criteria: ["D07.2-AC2"],
        description: "Mount table parsing and the preflight decision: missing data/maintenance mounts, unreadable table, subfolders, host mode",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/bootstrap/storage-mounts.test.ts"],
        requires: ["tests/unit/bootstrap/storage-mounts.test.ts"],
      },
      {
        id: "compose-persistence-native",
        criteria: ["D07.2-AC1", "D07.2-AC2"],
        description: "Real Compose: manifest, installation ID, gate, snapshot and log survive restart ×2 and down/up; no mount → STORAGE_NOT_MOUNTED and nothing created",
        command: ["node", "tests/system/compose-persistence.ts"],
        requires: ["tests/system/compose-persistence.ts", "tests/system/in-container/create-snapshot.mjs", "docker/compose.yml"],
        timeoutMs: 25 * 60 * 1000,
      },
      {
        id: "bootstrap-regression",
        criteria: ["D07.2-regression"],
        description: "The F08 bootstrap cases, the preflight on a real file system and the D07.1 files still hold",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/bootstrap", "tests/integration/bootstrap", "tests/unit/compose", "tests/integration/compose"],
        requires: ["tests/integration/bootstrap/storage-preflight.test.ts", "tests/unit/compose/compose-files.test.ts"],
      },
      ...regressionChecks("D07.2-regression"),
    ],
  },
  {
    id: "D07.3",
    ready: true,
    title: "Two installations side by side: separate identity, storage, logs and port; shared storage or port refused",
    criteria: ["D07.3-AC1", "D07.3-AC2", "D07.3-regression"],
    checks: [
      {
        // Runs first: the system test reads both installations from the host with the built adapters.
        id: "workspace-build",
        criteria: ["D07.3-AC1", "D07.3-AC2"],
        description: "pnpm -r build produces the adapters the test reads the installations with",
        command: ["pnpm", "-r", "build"],
        requires: ["tests/support/installation-state.ts"],
      },
      {
        id: "compose-isolation-native",
        criteria: ["D07.3-AC1", "D07.3-AC2"],
        description: "Real Compose A/B: own IDs, projects, keys, ports, mounts, paths and logs; restart/recreate of A leaves B untouched; third app → INSTANCE_BUSY; taken port starts nothing",
        command: ["node", "tests/system/compose-isolation.ts"],
        requires: ["tests/system/compose-isolation.ts", "tests/support/installation-state.ts", "docker/compose.yml", "docker/compose.local.yml"],
        timeoutMs: 25 * 60 * 1000,
      },
      {
        id: "compose-regression",
        criteria: ["D07.3-regression"],
        description: "The D07.1 compose files, the test installation preparer and the mount preflight still hold",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/compose", "tests/integration/compose", "tests/unit/bootstrap/storage-mounts.test.ts"],
        requires: ["tests/unit/compose/compose-files.test.ts", "tests/integration/compose/compose-instance.test.ts"],
      },
      ...regressionChecks("D07.3-regression"),
    ],
  },
  {
    id: "D08.1",
    ready: true,
    title: "CI and the task map for D01–D08: fixtures:verify, isolated test runs, blocking controls",
    criteria: ["D08.1-AC1", "D08.1-AC2", "D08.1-regression"],
    checks: [
      {
        // Runs first: the suites and the migration tests below run against the built packages.
        id: "workspace-build",
        criteria: ["D08.1-AC1", "D08.1-AC2"],
        description: "pnpm -r build produces the packages the suites and the container scripts import",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/plan.ts"],
      },
      {
        id: "fixtures-verify",
        criteria: ["D08.1-AC2"],
        description: "F01–F03, F08, F09: strict JSON, export shape, UUIDs, references, counts and order, declared cases, no secrets; 16 corruptions rejected",
        command: ["pnpm", "fixtures:verify", "--", "--self-test"],
        requires: [
          "scripts/fixtures-verify.ts",
          "tests/fixtures/books/books-v1.export.json",
          "tests/fixtures/books/books-v1.expected.json",
          "tests/fixtures/cases/record-validation.cases.json",
          "tests/fixtures/cases/bootstrap-v1.cases.json",
          "tests/fixtures/cases/auth-v1.cases.json",
        ],
      },
      {
        id: "blocking-controls",
        criteria: ["D08.1-AC2"],
        description: "In a test copy: a released migration edited without its checksum and a corrupted fixture make the CI checks exit nonzero",
        command: ["node", "tests/workspace/blocking-controls.ts"],
        requires: ["tests/workspace/blocking-controls.ts", "tests/integration/sqlite/migrations.test.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
      {
        id: "faulty-graph",
        criteria: ["D08.1-AC2"],
        description: "In a test copy, a forbidden graph and a wildcard export make the checks exit nonzero",
        command: ["node", "tests/workspace/faulty-graph.ts"],
        requires: ["tests/workspace/faulty-graph.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
      {
        id: "docker-missing",
        criteria: ["D08.1-AC2"],
        description: "Without a docker CLI every container test exits 78 before any assertion and the runner reports blocked with exit 1",
        command: ["node", "tests/verification/docker-missing.ts"],
        requires: ["tests/verification/docker-missing.ts", "tests/support/docker.ts"],
      },
      {
        id: "parallel-suites",
        criteria: ["D08.1-AC1"],
        description: "Unit + integration suites twice at once: both pass, nothing skipped or todo, no temp folder left",
        command: ["node", "tests/verification/parallel-suites.ts"],
        requires: ["tests/verification/parallel-suites.ts", "tests/support/scratch.ts", "tests/support/vitest-setup.ts", "vitest.config.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        id: "runner-self-test",
        criteria: ["D08.1-AC1"],
        description: "The runner on an isolated task map: report fields, passed/failed/blocked, unknown ID, parent gating",
        command: ["node", "tests/verification/runner.ts"],
        requires: ["tests/verification/runner.ts", "scripts/verify-task.ts"],
      },
      {
        id: "ci-workflow",
        criteria: ["D08.1-AC1"],
        description: "CI is valid YAML, installs frozen, pins actions, uploads reports and runs every ready task of the map",
        command: ["node", "tests/verification/ci-workflow.ts"],
        requires: ["tests/verification/ci-workflow.ts", ".github/workflows/ci.yml"],
      },
      ...regressionChecks("D08.1-regression"),
    ],
  },
  {
    id: "D08.2",
    ready: true,
    title: "Theme tokens, PL/EN texts with key checks and the status screen, in a real browser",
    criteria: ["D08.2-AC1", "D08.2-AC2", "D08.2-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D08.2-AC1", "D08.2-AC2"],
        description: "pnpm -r build: the SPA with both languages and the typed translation keys",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/app/pages/status-page.tsx", "packages/ui/src/tokens/dark-theme.json"],
      },
      {
        id: "theme-and-locales-unit",
        criteria: ["D08.2-AC1", "D08.2-AC2"],
        description: "Token contrast (WCAG) and CSS variables; check:locales on synthetic folders; the ready health body",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/ui", "tests/unit/locales"],
        requires: ["tests/unit/ui/theme-tokens.test.ts", "tests/unit/locales/check-locales.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D08.2-AC2"],
        description: "pl and en have the same keys, plural forms and variables",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/common.json", "apps/web/src/locales/en/common.json"],
      },
      {
        id: "locale-controls",
        criteria: ["D08.2-AC2"],
        description: "In a test copy: a key removed from en or pl and a literal text in JSX make check:locales, the build or lint exit nonzero",
        command: ["node", "tests/workspace/locale-controls.ts"],
        requires: ["tests/workspace/locale-controls.ts", "tests/support/repository-copy.ts"],
        timeoutMs: COPY_TIMEOUT_MS,
      },
      {
        id: "status-screen-e2e",
        criteria: ["D08.2-AC1", "D08.2-AC2"],
        description: "Playwright on the built app: PL/EN ready and unavailable (server stopped, 503), recovery, theme, axe, no form, no host path or key",
        command: ["node", "tests/verification/e2e.ts", "status-screen"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/status-screen.spec.ts", "tests/e2e/fixtures.ts", "playwright.config.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D08.2-regression"),
    ],
  },
  {
    id: "D08.3",
    ready: true,
    title: "G0: the image through Compose in a browser, refusals and degraded start; verified versions",
    criteria: ["D08.3-AC1", "D08.3-AC2", "D08.3-regression"],
    checks: [
      {
        // Runs first: the image test edits the installation's database with the built adapter.
        id: "workspace-build",
        criteria: ["D08.3-AC1", "D08.3-AC2"],
        description: "pnpm -r build: the adapters the G0 image test reads and edits the installation with",
        command: ["pnpm", "-r", "build"],
        requires: ["tests/system/g0-image.ts"],
      },
      {
        id: "g0-image-native",
        criteria: ["D08.3-AC1", "D08.3-AC2"],
        description: "Image of this commit via Compose: status screen PL/EN in Chromium, health/SPA/404, requestId in the log file, image and container IDs; bad env and tampered migration never ready, read-only logs degraded",
        command: ["node", "tests/system/g0-image.ts"],
        requires: ["tests/system/g0-image.ts", "docker/Dockerfile", "docker/compose.yml"],
        timeoutMs: 25 * 60 * 1000,
      },
      {
        id: "g0-matrix-static",
        criteria: ["D08.3-AC1", "D08.3-AC2"],
        description: "Every G0 item and failure-matrix case names a ready report, an existing check and a line written in its test",
        command: ["node", "tests/verification/g0-matrix-static.ts"],
        requires: ["tests/verification/g0-matrix-static.ts", "tests/verification/g0-matrix.ts"],
      },
      {
        id: "g0-gate-controls",
        criteria: ["D08.3-AC1", "D08.3-AC2"],
        description: "The G0 gate on synthetic reports: complete set passes; failed line or check fails, renamed test fails, missing or stale report is blocked",
        command: ["node", "tests/verification/g0-gate-controls.ts"],
        requires: ["tests/verification/g0-gate-controls.ts", "tests/verification/g0-gate.ts"],
      },
      {
        id: "readme-versions",
        criteria: ["D08.3-AC1"],
        description: "README's verified runtime equals the pinned Node, pnpm, base image and catalog versions",
        command: ["node", "tests/verification/readme-versions.ts"],
        requires: ["tests/verification/readme-versions.ts", "README.md"],
      },
      ...regressionChecks("D08.3-regression"),
    ],
  },
  {
    // The parent passes only through its work orders.
    id: "D08",
    ready: true,
    title: "CI, fixtures, theme and texts, and gate G0 of KM0",
    steps: ["D08.1", "D08.2", "D08.3"],
    criteria: [],
    checks: [],
  },
  {
    // KM0 gate (DEV §8.4): joins the KM0 reports made for this exact code and the D02 reports of
    // both architectures; does not run the tests again.
    id: "G0",
    ready: true,
    title: "Gate G0: the foundation of KM0 on reports of the same code",
    steps: ["D02"],
    criteria: ["G0-reports", "G0-matrix"],
    checks: [
      {
        id: "g0-gate",
        criteria: ["G0-reports", "G0-matrix"],
        description: "Reports D01–D08.3 for this code passed; every G0 item and failure-matrix case proved by its passed test or assertion",
        command: ["node", "tests/verification/g0-gate.ts"],
        requires: ["tests/verification/g0-gate.ts", "tests/verification/g0-matrix.ts"],
      },
    ],
  },
  {
    id: "D09.1",
    ready: true,
    title: "Auth adapter PoC: pinned Better Auth, shared password hasher, identity tables and their readiness check",
    criteria: ["D09.1-AC1", "D09.1-AC2", "D09.1-AC3", "D09.1-regression"],
    checks: [
      {
        // Runs first: the tests use the built adapter, migrations and server.
        id: "workspace-build",
        criteria: ["D09.1-AC1", "D09.1-AC2", "D09.1-AC3"],
        description: "pnpm -r build: the auth adapter, the identity migration and the server bootstrap",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/auth/auth-options.ts", "packages/sqlite/src/migrations/0002-identity.ts"],
      },
      {
        id: "password-hasher",
        criteria: ["D09.1-AC1"],
        description: "argon2id PHC with the declared cost; spaces, Unicode, emoji and shell characters kept; NFKC/NFD forms differ; bounded concurrency; measured cost",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/password-hasher.test.ts"],
        requires: ["tests/integration/auth/password-hasher.test.ts", "apps/server/src/adapters/auth/password-hasher.ts", "packages/contracts/src/http/identity.ts"],
      },
      {
        id: "auth-adapter-poc",
        criteria: ["D09.1-AC1", "D09.1-AC2"],
        description: "better-auth 1.7.13 on a migrated file DB: schema, sign-in with the shared hasher, session read-back; autocommit, after-hook and read-time writes detected",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/adapter-poc.test.ts"],
        requires: ["tests/integration/auth/adapter-poc.test.ts", "apps/server/src/adapters/auth/auth-schema.ts"],
      },
      {
        id: "auth-schema-readiness",
        criteria: ["D09.1-AC3"],
        description: "Real starts: a missing column, index or table or another type → exit 1 AUTH_SCHEMA_INCOMPATIBLE, no repair, file unchanged",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/auth-schema.test.ts"],
        requires: ["tests/integration/auth/auth-schema.test.ts", "apps/server/src/main.ts", "packages/sqlite/src/schema/table-shape.ts"],
      },
      ...regressionChecks("D09.1-regression"),
    ],
  },
  {
    id: "D09.2",
    ready: true,
    title: "create-owner CLI: one owner, credential and audit entry in one transaction under the writer lease",
    criteria: ["D09.2-AC1", "D09.2-AC2", "D09.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built CLI against the built migrations and adapters.
        id: "workspace-build",
        criteria: ["D09.2-AC1", "D09.2-AC2"],
        description: "pnpm -r build: the identity use case, the sqlite adapters, migration 3 and the CLI",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/cli/create-owner.ts", "packages/sqlite/src/migrations/0003-owner-audit.ts"],
      },
      {
        id: "create-owner-cli",
        criteria: ["D09.2-AC1", "D09.2-AC2"],
        description:
          "Real CLI processes on real installations: stdin only; parallel runs give one owner, credential and owner.created entry; failing audit/credential/singleton rolls back; second owner, same-e-mail foreign user, running app and missing database refused; F09 parallel-owner-creation and owner-audit-failure-rolls-back",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/create-owner.test.ts"],
        requires: ["tests/integration/auth/create-owner.test.ts", "apps/server/src/bootstrap/command-session.ts", "packages/core/src/modules/identity/public.ts"],
      },
      ...regressionChecks("D09.2-regression"),
    ],
  },
  {
    id: "D09.3",
    ready: true,
    title: "Explicit sign-in, sign-out and status: session cookie, Origin, persistent lockout, closed auth routes",
    criteria: ["D09.3-AC1", "D09.3-AC2", "D09.3-regression"],
    checks: [
      {
        // Runs first: the tests use the built use case, adapters and server.
        id: "workspace-build",
        criteria: ["D09.3-AC1", "D09.3-AC2"],
        description: "pnpm -r build: the sign-in use case, the session and lockout adapters, migration 4 and the HTTP routes",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/identity.routes.ts", "packages/sqlite/src/migrations/0004-auth-lockout.ts"],
      },
      {
        id: "sign-in-lockout",
        criteria: ["D09.3-AC1", "D09.3-AC2"],
        description: "Use case on a real database with a controlled clock: one session, same outcome for wrong password and foreign e-mail, 5 failures lock 15 min, exact boundary, restart, bucket scope and pruning, audit failure rolls the attempt back",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/sign-in-lockout.test.ts"],
        requires: ["tests/integration/auth/sign-in-lockout.test.ts", "packages/core/src/modules/identity/application/sign-in.ts", "packages/sqlite/src/adapters/identity/sign-in-ports.ts"],
      },
      {
        id: "sign-in-http",
        criteria: ["D09.3-AC1", "D09.3-AC2"],
        description: "Real server and CLI-created owner: cookie attributes, status, sign-out, identical 401 DTO, 429 with Retry-After and restart, rate limit, validation; F09 login-audit-failure-issues-no-session 503; no library route mounted; missing/foreign Origin refused before credentials",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/sign-in-http.test.ts"],
        requires: ["tests/integration/auth/sign-in-http.test.ts", "apps/server/src/adapters/auth/session-cookie.ts", "apps/server/src/http/middleware/same-origin.ts"],
      },
      ...regressionChecks("D09.3-regression"),
    ],
  },
  {
    id: "D09.4",
    ready: true,
    title: "reset-password CLI with session revocation and the cookie isolation of two installations",
    criteria: ["D09.4-AC1", "D09.4-AC2", "D09.4-regression"],
    checks: [
      {
        // Runs first: the tests run the built CLI, server and adapters.
        id: "workspace-build",
        criteria: ["D09.4-AC1", "D09.4-AC2"],
        description: "pnpm -r build: the reset use case, the credential and session adapters and the reset-password CLI",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/cli/reset-password.ts", "packages/core/src/modules/identity/application/reset-password.ts"],
      },
      {
        id: "reset-password-cli",
        criteria: ["D09.4-AC1"],
        description:
          "Real CLI and server: credential, epoch, sessions and audit change together; old cookies stop authenticating, old password refused, new works; running app, failing audit, invalid input, missing owner change nothing; F09 reset-password-revokes-session",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/reset-password.test.ts"],
        requires: ["tests/integration/auth/reset-password.test.ts", "apps/server/src/bootstrap/command-session.ts"],
      },
      {
        id: "cookie-isolation",
        criteria: ["D09.4-AC2"],
        description: "Two installations and one browser profile on localhost: independent logins, no cross authorization, sign-out of A keeps B, restart keeps keys and sessions, no password in logs",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/cookie-isolation.test.ts"],
        requires: ["tests/integration/auth/cookie-isolation.test.ts", "apps/server/src/adapters/auth/session-cookie.ts"],
      },
      ...regressionChecks("D09.4-regression"),
    ],
  },
  {
    // The parent passes only through its work orders: the owner, the session and the cookies.
    id: "D09",
    ready: true,
    title: "Auth adapter PoC, owner and reset CLI, explicit sign-in and cookies per installation",
    steps: ["D09.1", "D09.2", "D09.3", "D09.4"],
    criteria: [],
    checks: [],
  },
  {
    id: "D10.1",
    ready: true,
    title: "Prototype of the one second-factor mechanism: state, secret box, TOTP step, session promotion, no public write of assurance",
    criteria: ["D10.1-AC1", "D10.1-AC2", "D10.1-regression"],
    checks: [
      {
        // Runs first: the prototype uses the built adapters, migrations and server modules.
        id: "workspace-build",
        criteria: ["D10.1-AC1", "D10.1-AC2"],
        description: "pnpm -r build: migration 5, the MFA store, the secret box, the TOTP verifier and the capability check",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/auth/secret-box.ts", "packages/sqlite/src/migrations/0005-mfa-state.ts"],
      },
      {
        id: "mfa-prototype",
        criteria: ["D10.1-AC1", "D10.1-AC2"],
        description:
          "Real database file: password session → enrollment challenge → confirmation → rotated session, read after a restart; secret only as an envelope bound to owner and generation; compare-and-set activation; the library's update-user cannot set assurance; revocation, rotation and expiry read at once; migration 5 backfill and constraints; capability check blocks a mismatching integration",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-poc.test.ts"],
        requires: ["tests/integration/auth/mfa-poc.test.ts", "apps/server/src/adapters/auth/mfa-capabilities.ts", "packages/sqlite/src/adapters/identity/mfa-store.ts"],
      },
      ...regressionChecks("D10.1-regression"),
    ],
  },
  {
    id: "D10.2",
    ready: true,
    title: "The one access policy of core/identity, its reader port and adapter, contract codes and nextAction",
    criteria: ["D10.2-AC1", "D10.2-AC2", "D10.2-regression"],
    checks: [
      {
        // Runs first: the integration test uses the built use cases, adapters and server.
        id: "workspace-build",
        criteria: ["D10.2-AC1", "D10.2-AC2"],
        description: "pnpm -r build: the access policy, the reader adapter, migration 6 and the status route",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/identity/domain/access-policy.ts", "packages/sqlite/src/adapters/identity/access-reader.ts"],
      },
      {
        id: "access-policy-f09",
        criteria: ["D10.2-AC1", "D10.2-AC2"],
        description: "All 31 F09 policyCases exactly; order of the checks, independence of policy, enrollment, acknowledgment and data choice; 300000/300001 ms and future time; trusted and recovery never a fresh TOTP",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/identity/access-policy.test.ts"],
        requires: ["tests/unit/identity/access-policy.test.ts", "tests/fixtures/cases/auth-v1.cases.json"],
      },
      {
        id: "access-reader",
        criteria: ["D10.2-AC1", "D10.2-AC2"],
        description: "Real database and server: the snapshot of each situation read from the database and decided by the policy, injected clock at the step-up boundary, status follows the live database, client claims change nothing",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/access-reader.test.ts"],
        requires: ["tests/integration/auth/access-reader.test.ts", "packages/sqlite/src/migrations/0006-setup-data-choice.ts"],
      },
      ...regressionChecks("D10.2-regression"),
    ],
  },
  {
    id: "D10.3",
    ready: true,
    title: "TOTP vectors, replay ledger as compare-and-set, rollback with the audit, reads that write nothing, migration samples",
    criteria: ["D10.3-AC1", "D10.3-AC2", "D10.3-regression"],
    checks: [
      {
        // Runs first: the integration tests use the built adapters, migrations and server modules.
        id: "workspace-build",
        criteria: ["D10.3-AC1", "D10.3-AC2"],
        description: "pnpm -r build: the replay ledger, the read unit and the identity ports",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/transactions/unit-of-work.ts", "packages/sqlite/src/adapters/identity/mfa-store.ts"],
      },
      {
        id: "totp-vectors",
        criteria: ["D10.3-AC1"],
        description: "RFC 4226 counters 0 to 9 and the RFC 6238 SHA-1 vectors (8 digits by the library, 6 digits and the matching step by the product), window of one step either side, step boundary",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/identity/totp-vectors.test.ts"],
        requires: ["tests/unit/identity/totp-vectors.test.ts", "apps/server/src/adapters/auth/totp.ts"],
      },
      {
        id: "mfa-atomicity",
        criteria: ["D10.3-AC1", "D10.3-AC2"],
        description:
          "Real database: two requests with one step give one promotion, the ledger moves forward only, key/generation/nonce of the secret; a failing audit rolls back the consumed step and the promotion or enrollment, a vanished session rolls it back, reads write nothing while the database refuses writes, migration from versions 3 to 5 keeps owner, sessions and audit",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-atomicity.test.ts"],
        requires: ["tests/integration/auth/mfa-atomicity.test.ts", "tests/support/mfa-prototype.ts", "tests/support/identity-rig.ts"],
      },
      {
        id: "read-unit",
        criteria: ["D10.3-AC2"],
        description: "The read unit refuses every write, takes no write lock, keeps its snapshot, restores query_only and rejects async callbacks, kept handles and nesting",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/sqlite/unit-of-work.test.ts"],
        requires: ["tests/integration/sqlite/unit-of-work.test.ts"],
      },
      ...regressionChecks("D10.3-regression"),
    ],
  },
  {
    // The parent passes only through its work orders: the mechanism, the policy and the safety of the second factor.
    id: "D10",
    ready: true,
    title: "One second-factor mechanism, its access policy and the atomic adapters",
    steps: ["D10.1", "D10.2", "D10.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D11.1",
    ready: true,
    title: "Enrollment of the second factor: begin, confirm, recovery codes, acknowledgment and reissue over real routes",
    criteria: ["D11.1-AC1", "D11.1-AC2", "D11.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and adapters.
        id: "workspace-build",
        criteria: ["D11.1-AC1", "D11.1-AC2"],
        description: "pnpm -r build: the enrollment use cases, the recovery code store, migration 7 and the four routes",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/identity/application/enroll-totp.ts", "apps/server/src/http/routes/mfa-enrollment.routes.ts"],
      },
      {
        id: "recovery-codes",
        criteria: ["D11.1-AC2"],
        description: "Ten codes of ten characters, alphabet without look-alikes, accepted spellings, keyed hashes, malformed input has no hash",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/identity/recovery-codes.test.ts"],
        requires: ["tests/unit/identity/recovery-codes.test.ts", "apps/server/src/adapters/auth/recovery-codes.ts"],
      },
      {
        id: "mfa-enrollment-http",
        criteria: ["D11.1-AC1", "D11.1-AC2"],
        description:
          "Real server and CLI-created owner: confirm opens no data before the acknowledgment, session promoted and old cookie dead; lost view → new batch by the next TOTP with the secret unchanged; foreign/expired challenge, late acknowledgment, old batch, begin on an enrolled owner, parallel confirm, failing audit (503), no plain codes in database or logs",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-enrollment-http.test.ts"],
        requires: ["tests/integration/auth/mfa-enrollment-http.test.ts", "packages/sqlite/src/adapters/identity/recovery-store.ts"],
      },
      ...regressionChecks("D11.1-regression"),
    ],
  },
  {
    id: "D11.2",
    ready: true,
    title: "Second factor at login: TOTP, recovery code, trusted device, step-up; rotation and the durable replay ledger",
    criteria: ["D11.2-AC1", "D11.2-AC2", "D11.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and adapters.
        id: "workspace-build",
        criteria: ["D11.2-AC1", "D11.2-AC2"],
        description: "pnpm -r build: the proof use cases, the trusted device store, migration 8 and the verify and step-up routes",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/identity/application/verify-mfa.ts", "apps/server/src/http/routes/mfa-verification.routes.ts"],
      },
      {
        id: "mfa-verify-http",
        criteria: ["D11.2-AC1", "D11.2-AC2"],
        description:
          "Real server and CLI-created owner: TOTP and recovery code at login with rotation, F09 parallel-totp-use and parallel-recovery-use, a recovery code lowers the rest by one and gives no TOTP time or trust, trusted device by hash with fixed expiry and revocation, step-up with a fresh TOTP, used step and code refused also after a restart, failing audit spends no factor and publishes nothing, password reset revokes devices, no plain codes or tokens in database or logs",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-verify-http.test.ts"],
        requires: ["tests/integration/auth/mfa-verify-http.test.ts", "tests/support/auth-http.ts", "packages/sqlite/src/adapters/identity/trusted-device-store.ts"],
      },
      ...regressionChecks("D11.2-regression"),
    ],
  },
  {
    id: "D11.3",
    ready: true,
    title: "Persistent lockout of the second factor: account and address buckets, committed refusals, restart, burst",
    criteria: ["D11.3-AC1", "D11.3-AC2", "D11.3-regression"],
    checks: [
      {
        // Runs first: the tests use the built use cases, adapters and server.
        id: "workspace-build",
        criteria: ["D11.3-AC1", "D11.3-AC2"],
        description: "pnpm -r build: the shared lockout buckets, the counted refusals of every factor operation and the 429 mapping",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/identity/application/factor-attempts.ts", "apps/server/src/http/mfa-operation.ts"],
      },
      {
        id: "mfa-lockout",
        criteria: ["D11.3-AC1", "D11.3-AC2"],
        description:
          "Real database, controlled clock: 4 refusals then a lock of 900 s, blocked requests write nothing, exact lockedUntil boundary, 15-minute window, restart, every factor operation in one bucket, committed refusals and audit outage, password and factor buckets apart, success clears only the account bucket, burst of 20 counts five",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-lockout.test.ts"],
        requires: ["tests/integration/auth/mfa-lockout.test.ts", "packages/core/src/modules/identity/application/lockout-buckets.ts"],
      },
      {
        id: "mfa-lockout-http",
        criteria: ["D11.3-AC1", "D11.3-AC2"],
        description: "Real server: 401 401 401 401 429 with Retry-After under a spoofed X-Forwarded-For, the lock holds for every route, session and a restart, enrollment confirmation locks alike, burst, audit outage 503, no session means no count",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/mfa-lockout-http.test.ts"],
        requires: ["tests/integration/auth/mfa-lockout-http.test.ts", "apps/server/src/adapters/auth/attempt-keys.ts"],
      },
      {
        id: "password-lockout",
        criteria: ["D11.3-AC2"],
        description: "The password's lockout of D09.3 still holds on the shared buckets",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/sign-in-lockout.test.ts", "tests/integration/auth/sign-in-http.test.ts"],
        requires: ["tests/integration/auth/sign-in-lockout.test.ts", "tests/integration/auth/sign-in-http.test.ts"],
      },
      ...regressionChecks("D11.3-regression"),
    ],
  },
  {
    id: "D11.4",
    ready: true,
    title: "First setup backend: stage, choice of the starting data, preferences, and the reset-mfa command",
    criteria: ["D11.4-AC1", "D11.4-AC2", "D11.4-regression"],
    checks: [
      {
        // Runs first: the tests run the built server, the CLIs and the adapters.
        id: "workspace-build",
        criteria: ["D11.4-AC1", "D11.4-AC2"],
        description: "pnpm -r build: the setup use cases, the settings port and adapter, migration 9, the setup routes and the reset-mfa command",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/settings/application/setup.ts", "apps/server/src/cli/reset-mfa.ts"],
      },
      {
        id: "setup-http",
        criteria: ["D11.4-AC1", "D11.4-AC2"],
        description:
          "Real server and CLI-created owner: F09 lost-recovery-view-requires-new-batch on the real routes; stages, atomic idempotent choice, preferences saved over a restart; refusals before the acknowledgment, before the factor and before the choice of data; imported never replaced; failing audit changes nothing; ended session cannot write; no import route",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/setup-http.test.ts"],
        requires: ["tests/integration/auth/setup-http.test.ts", "apps/server/src/http/routes/setup.routes.ts"],
      },
      {
        id: "reset-mfa",
        criteria: ["D11.4-AC2"],
        description: "reset-mfa removes the factor, sessions and trust and requires a new enrollment, keeping password, data choice and preferences; running app, failing audit and arguments change nothing; regression: reset-password revokes trust and forces no enrollment",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/reset-mfa.test.ts"],
        requires: ["tests/integration/auth/reset-mfa.test.ts", "packages/core/src/modules/identity/application/reset-mfa.ts"],
      },
      ...regressionChecks("D11.4-regression"),
    ],
  },
  {
    // The parent passes only through its work orders: enrolling, proving, locking and the first setup.
    id: "D11",
    ready: true,
    title: "Second factor backend, lockouts and the first setup",
    steps: ["D11.1", "D11.2", "D11.3", "D11.4"],
    criteria: [],
    checks: [],
  },
  // The parent passes only through its work orders: the sign-in, the enrollment and the first setup in a browser.
  {
    id: "D12",
    ready: true,
    title: "Sign-in, second factor and minimal setup in the browser",
    steps: ["D12.1", "D12.2", "D12.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D12.1",
    ready: true,
    title: "Sign-in and second-factor screens on the built app: typed client, guards by nextAction, safe errors",
    criteria: ["D12.1-AC1", "D12.1-AC2", "D12.1-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D12.1-AC1", "D12.1-AC2"],
        description: "pnpm -r build: the SPA with the sign-in, second-factor and setup screens, typed keys of four namespaces",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/auth/pages/login-page.tsx", "apps/web/src/lib/api-client/request.ts"],
      },
      {
        id: "client-unit",
        criteria: ["D12.1-AC1", "D12.1-AC2"],
        description: "The typed client (success, API error with Retry-After, no connection, an answer off the contract, abort), the failure texts selected by code only, nextAction to route",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/api-client.test.ts", "tests/unit/web/error-message.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D12.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all four namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/auth.json", "apps/web/src/locales/en/auth.json"],
      },
      {
        id: "sign-in-e2e",
        criteria: ["D12.1-AC1", "D12.1-AC2"],
        description:
          "Playwright on the built app and server: PL/EN sign-in, 401/429/lost connection keep the form, the password sent untrimmed and nowhere afterwards, a late answer ignored, the second factor by TOTP and recovery code, trusted device cookie not readable by the page, sign-out; guards by nextAction for every state, forged cookies, status outage, contract mismatch, errors by code only; axe",
        command: ["node", "tests/verification/e2e.ts", "sign-in", "gate"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/sign-in.spec.ts", "tests/e2e/gate.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D12.1-regression"),
    ],
  },
  {
    id: "D12.2",
    ready: true,
    title: "Enrollment of the second factor in the browser: QR code, confirmation, recovery codes shown once, safe resume",
    criteria: ["D12.2-AC1", "D12.2-AC2", "D12.2-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D12.2-AC1", "D12.2-AC2"],
        description: "pnpm -r build: the SPA with the enrollment and recovery steps and the QR renderer",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/setup/components/enrollment-step.tsx", "apps/web/src/features/setup/components/recovery-step.tsx"],
      },
      {
        id: "enrollment-unit",
        criteria: ["D12.2-AC1", "D12.2-AC2"],
        description: "The QR path paints exactly the modules of the code; failure texts cover the batch error; the CI evidence carries no Playwright trace",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/qr-path.test.ts", "tests/unit/web/error-message.test.ts", "tests/unit/web/playwright-trace-policy.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D12.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all four namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/setup.json", "apps/web/src/locales/en/setup.json"],
      },
      {
        id: "enrollment-e2e",
        criteria: ["D12.2-AC1", "D12.2-AC2"],
        description:
          "Playwright on the built app and server: QR code and key (the same key after a reload), a wrong code keeps the step, a lost connection and a lock keep it; ten recovery codes shown once, no passing without the acknowledgment, gone from page, storage and server log after it; after a reload a new TOTP gives a new set (a spent step refused), the old set dead and the secret unchanged; a batch replaced in another tab gives the right error and keeps the step; PL; axe",
        command: ["node", "tests/verification/e2e.ts", "enrollment", "gate"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/enrollment.spec.ts", "tests/e2e/gate.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D12.2-regression"),
    ],
  },
  {
    id: "D12.3",
    ready: true,
    title: "Minimal setup in the browser: starting data, preferences, the empty private screen, sign-out across tabs",
    criteria: ["D12.3-AC1", "D12.3-AC2", "D12.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D12.3-AC1", "D12.3-AC2"],
        description: "pnpm -r build: the SPA with the data and preferences steps and the sign-out watcher",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/setup/components/data-step.tsx", "apps/web/src/features/setup/components/preferences-step.tsx"],
      },
      {
        id: "setup-unit",
        criteria: ["D12.3-AC2"],
        description: "The sign-out announcement reaches a listener and nothing else does",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/session-channel.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D12.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all four namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/setup.json", "apps/web/src/locales/en/setup.json"],
      },
      {
        id: "setup-e2e",
        criteria: ["D12.3-AC1", "D12.3-AC2"],
        description:
          "Playwright on a fresh installation (F09 minimal-setup-resumes-after-restart): enrollment, recovery codes, empty data, preferences, empty /main in the saved language, no import or guide offered; three real restarts resume the right stage without a second enrollment and keep the choice and the preferences; unsaved preferences keep /main closed; a refused zone keeps the form; a lost choice is asked again; sign-out ends the other tab at once (and by the next request without a broadcast), the old cookie opens nothing; PL; axe",
        command: ["node", "tests/verification/e2e.ts", "setup", "enrollment", "gate", "sign-in"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/setup.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D12.3-regression"),
    ],
  },
  {
    id: "D13.1",
    ready: true,
    title: "Inventory of the real routes, Origin, privileged fields and undocumented auth helpers on raw HTTP",
    criteria: ["D13.1-AC1", "D13.1-AC2", "D13.1-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server.
        id: "workspace-build",
        criteria: ["D13.1-AC1", "D13.1-AC2"],
        description: "pnpm -r build produces the server the raw HTTP tests start",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/setup.routes.ts", "tests/support/route-inventory.ts"],
      },
      {
        id: "route-inventory",
        criteria: ["D13.1-AC1", "D13.1-AC2"],
        description:
          "Registered routes equal the inventory; every state (none, password only, awaiting the acknowledgment, data unchosen, empty chosen, complete, a new password session) meets the contract on the same GET/PUT preferences with a positive control; foreign, missing and null Origin, privileged fields, foreign owner/session identifiers and undocumented auth helpers change nothing; audit and answers carry no authentication material",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/route-inventory.test.ts"],
        requires: ["tests/integration/auth/route-inventory.test.ts", "tests/support/route-inventory.ts", "tests/support/auth-http.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D13.1-regression"),
    ],
  },
  {
    id: "D13.2",
    ready: true,
    title: "Request authority at the commit: revocation between middleware and unit of work, atomic failure of the audit",
    criteria: ["D13.2-AC1", "D13.2-AC2", "D13.2-regression"],
    checks: [
      {
        // Runs first: the harness composes the built server application.
        id: "workspace-build",
        criteria: ["D13.2-AC1", "D13.2-AC2"],
        description: "pnpm -r build produces the application the harness composes",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/bootstrap/create-app.ts", "tests/support/app-harness.ts"],
      },
      {
        id: "request-authority",
        criteria: ["D13.2-AC1", "D13.2-AC2"],
        description:
          "The real application in the test process, stopped between the middleware and the unit of work: a session ended or an access epoch moved in the gap refuses the write (preferences, data choice, acknowledgment, promotion, enrollment) and changes nothing, another session's end does not; a failing audit rolls back enrollment, reissue, acknowledgment, data choice, preferences and promotion with 503 and no cookie, and the same request works after; audit and technical log hold no password, code, secret, token or request body",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/request-authority.test.ts"],
        requires: ["tests/integration/auth/request-authority.test.ts", "tests/support/app-harness.ts", "tests/support/auth-http.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D13.2-regression"),
    ],
  },
  {
    id: "D13.3",
    ready: true,
    title: "Handover of the auth and setup work: the reports of D09–D13 joined, item by item",
    criteria: ["D13.3-AC1", "D13.3-AC2", "D13.3-regression"],
    checks: [
      {
        id: "handover-controls",
        criteria: ["D13.3-AC2"],
        description:
          "The handover on synthetic reports: a complete set passes; a failed or renamed flow test, a missing replay or Origin test, a failed check, a flow of the fixture without evidence, a flow no longer in the fixture and a wrong number of policy cases fail; a missing report or one of other code is blocked",
        command: ["node", "tests/verification/auth-handover-controls.ts"],
        requires: ["tests/verification/auth-handover-controls.ts", "tests/verification/auth-handover.ts", "tests/verification/auth-handover-matrix.ts"],
      },
      {
        id: "handover",
        criteria: ["D13.3-AC1", "D13.3-AC2"],
        description:
          "Joins the reports of D09, D10, D11, D12, D13.1 and D13.2 for exactly this code and decides every F09 flow (read from the fixture), the 31 policy cases and the mandatory items (rotation, replay, Origin, acknowledgment, no way around the auth, atomic audit, no secrets, the browser flow) from the logs; lists the adapter versions, the hashes and what was not run (SSE/export, import, Designer, security panel, other browsers, the container image). It runs no test: run the steps first",
        command: ["node", "tests/verification/auth-handover.ts"],
        requires: ["tests/verification/auth-handover.ts", "tests/verification/auth-handover-matrix.ts", "tests/verification/report-join.ts", "tests/fixtures/cases/auth-v1.cases.json"],
      },
      ...regressionChecks("D13.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the routes, the commit-time authority and the handover.
  {
    id: "D13",
    ready: true,
    title: "Review of the routes, policies and audit of the auth work, and its handover",
    steps: ["D13.1", "D13.2", "D13.3"],
    criteria: [],
    checks: [],
  },
  {
    // The parent passes only through its work orders, each with its real Compose run.
    id: "D07",
    ready: true,
    title: "Compose local mode: persistence and isolation of installations",
    steps: ["D07.1", "D07.2", "D07.3"],
    criteria: [],
    checks: [],
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
