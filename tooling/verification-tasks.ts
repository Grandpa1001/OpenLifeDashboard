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
  D01: 3, D02: 3, D03: 4, D04: 3, D05: 3, D06: 3, D07: 3, D08: 3, D09: 4, D10: 3, D11: 4, D12: 3, D13: 3, D14: 3, D15: 3, D16: 3, D17: 4, D18: 3, D19: 3, D20: 3, D22: 3, D23: 4, D24: 3, D25: 3, D26: 2, D27: 2, D28: 2, D29: 2, D30: 2, D31: 3, D32: 2, D33: 3, D34: 3, D35: 3, D36: 3, D37: 3, D38: 3, D39: 3, D40: 2, D41: 3, D42: 3,
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
    id: "D14.1",
    ready: true,
    title: "Rules of the registry catalog: symbols and their suggestion, column types, options, defaults, limits",
    criteria: ["D14.1-AC1", "D14.1-AC2", "D14.1-regression"],
    checks: [
      {
        // Runs first: the unit tests import the built core.
        id: "workspace-build",
        criteria: ["D14.1-AC1", "D14.1-AC2"],
        description: "pnpm -r build produces core with the registries module",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/registries/public.ts", "packages/core/package.json"],
      },
      {
        id: "registry-rules",
        criteria: ["D14.1-AC1", "D14.1-AC2"],
        description:
          "Załącznik C examples give the exact suggestion (collisions _2/_3, reserved id, 40 characters); hostile symbols (SQL, quotes, Unicode, upper case, newline) and reserved words are refused with their own codes; types, options, defaults and the 200/60/10 000 limits (also other limits given as a dependency) are enforced; the registry of F01 is a valid definition; the rules read nothing from outside",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/registries"],
        requires: ["tests/unit/registries/registry-rules.test.ts", "tests/fixtures/books/books-v1.export.json"],
      },
      ...regressionChecks("D14.1-regression"),
    ],
  },
  {
    id: "D14.2",
    ready: true,
    title: "Catalog of registries and their tables on real SQLite: one transaction, safe identifiers",
    criteria: ["D14.2-AC1", "D14.2-AC2", "D14.2-regression"],
    checks: [
      {
        // Runs first: the integration tests use the built core and sqlite packages.
        id: "workspace-build",
        criteria: ["D14.2-AC1", "D14.2-AC2"],
        description: "pnpm -r build produces core and sqlite with the registries port, the migration and the adapter",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/0010-registries.ts", "packages/sqlite/src/adapters/registries/registry-store.ts"],
      },
      {
        id: "registry-store",
        criteria: ["D14.2-AC1", "D14.2-AC2"],
        description:
          "Książki of F01 become catalog rows and a STRICT table reg_ksiazki with the right columns, types and the indexes of the date columns, which takes the first record of F01 and refuses what its types refuse, and survives a restart; a database of the version before upgrades with its data; a failing CREATE TABLE, CREATE INDEX or audit leaves no row, table or index; a taken symbol (also of a deleted registry), the limit, hostile symbols and reserved column names never reach the DDL; the catalog's own CHECKs; three creations of one symbol give one registry",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/registries/registry-store.test.ts", "tests/integration/sqlite/migrations.test.ts", "tests/fixtures/books/books-v1.export.json"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D14.2-regression"),
    ],
  },
  {
    id: "D14.3",
    ready: true,
    title: "Creating and listing registries over HTTP: use case, route, contracts, F01 through the real API",
    criteria: ["D14.3-AC1", "D14.3-AC2", "D14.3-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and compose the built application.
        id: "workspace-build",
        criteria: ["D14.3-AC1", "D14.3-AC2"],
        description: "pnpm -r build produces the server with the registries route and the UUIDv7 generator",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/registries.routes.ts", "apps/server/src/adapters/ids/uuid-v7.ts", "packages/contracts/src/http/registries.ts"],
      },
      {
        id: "registry-http",
        criteria: ["D14.3-AC1", "D14.3-AC2"],
        description:
          "Raw HTTP on the built server and on the application composed in the test process: Książki of F01 created (201) with server identifiers (UUIDv7), owner and timestamps, listed, the same after a restart; every state before the gate, a foreign/missing/null Origin, every field a client may not send, a bad definition with all its issues, SQL-attacking symbols, a taken symbol (also a deleted registry's), 61 columns, an oversized body, five parallel creations, the limit of 200, an ended session and a failing audit are refused with their own code and leave no row and no table; the audit holds the symbol and the number of columns only",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/registry-http.test.ts", "tests/unit/registries/uuid-v7.test.ts", "tests/integration/auth/route-inventory.test.ts"],
        requires: ["tests/integration/registries/registry-http.test.ts", "tests/unit/registries/uuid-v7.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/support/app-harness.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D14.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the rules, the catalog and the route.
  {
    id: "D14",
    ready: true,
    title: "Registry rules, catalog and table, and creating a registry over HTTP",
    steps: ["D14.1", "D14.2", "D14.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D15.1",
    ready: true,
    title: "Rules of one record: canonical values, required, defaults, unknown and system fields, limits, canonical request",
    criteria: ["D15.1-AC1", "D15.1-AC2", "D15.1-regression"],
    checks: [
      {
        // Runs first: the unit tests import the built core.
        id: "workspace-build",
        criteria: ["D15.1-AC1", "D15.1-AC2"],
        description: "pnpm -r build produces core with the record rules and the ports of the records",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/registries/domain/record-rules.ts", "packages/core/src/modules/registries/ports.ts"],
      },
      {
        id: "record-rules",
        criteria: ["D15.1-AC1", "D15.1-AC2"],
        description:
          "The eight cases of record-validation.cases.json on the schema of F01 and every record of F01; defaults, explicit null; every type with good and bad values; required white space; text limit in code points and record limit in UTF-8 bytes on their edge; all problems at once with their paths; __proto__ and non-objects; the canonical text of a request; what a list may be sorted by; the rules read nothing from outside",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/registries"],
        requires: ["tests/unit/registries/record-rules.test.ts", "tests/fixtures/cases/record-validation.cases.json", "tests/fixtures/books/books-v1.export.json"],
      },
      ...regressionChecks("D15.1-regression"),
    ],
  },
  {
    id: "D15.2",
    ready: true,
    title: "Records and idempotency entries on real SQLite: write with the revision, pages with the count, 24 h entries",
    criteria: ["D15.2-AC1", "D15.2-AC2", "D15.2-regression"],
    checks: [
      {
        // Runs first: the integration tests use the built core and sqlite packages.
        id: "workspace-build",
        criteria: ["D15.2-AC1", "D15.2-AC2"],
        description: "pnpm -r build produces sqlite with the migration of idempotency entries and the adapters of records",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/0011-idempotency.ts", "packages/sqlite/src/adapters/registries/record-store.ts", "packages/sqlite/src/adapters/registries/idempotency-store.ts"],
      },
      {
        id: "record-store",
        criteria: ["D15.2-AC1", "D15.2-AC2"],
        description:
          "The 25 records of F01 written with their identifiers and times and read back equal, data_revision 25, pages 10/10/5 in the order of books-v1.expected.json and the same after a restart; empty values last in both directions with the identifier breaking ties; another owner's registry shows nothing; a read unit is one snapshot; a failing insert, a stale or deleted registry and a failing entry leave no record, entry or revision; the entry is bound to owner, operation and key, expires and is cleaned; the table's own CHECKs; sort columns, directions, pages, table names and value keys outside the catalog never reach SQL; hostile text is a value only; the migration plan",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-store.test.ts", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/registries/record-store.test.ts", "tests/fixtures/books/books-v1.expected.json", "tests/fixtures/books/books-v1.export.json"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D15.2-regression"),
    ],
  },
  {
    id: "D15.3",
    ready: true,
    title: "Adding and listing records over HTTP: use cases, routes, contracts, idempotency, F01 through the real API",
    criteria: ["D15.3-AC1", "D15.3-AC2", "D15.3-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and compose the built application.
        id: "workspace-build",
        criteria: ["D15.3-AC1", "D15.3-AC2"],
        description: "pnpm -r build produces the server with the records route and the contracts of the records",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/records.routes.ts", "packages/contracts/src/http/records.ts", "packages/core/src/modules/registries/application/records.ts"],
      },
      {
        id: "record-http",
        criteria: ["D15.3-AC1", "D15.3-AC2"],
        description:
          "Raw HTTP on the built server and on the application composed in the test process: the 25 records of F01 added under their own keys list as 10/10/5 with the count 25 in the order of the expected file and the same after a restart; one key and one body twice is one record and the same answer (also with the keys in another order and in five parallel requests); a missing or malformed key, a key with another body, a stale schema revision (0, 2; a retry made before the change still answers), a missing, null or blank required title, a system or foreign field, a value in a non-canonical form, a text and a record over their limits, an unknown or deleted registry, every state before the gate, a foreign Origin, an ended session and a failing write or entry are refused with their own code and leave no record, entry or revision; an entry lives 24 hours; the sort, page, size and direction of a list are the request's and never reach SQL; records are not audited and no value reaches the audit or the log",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-http.test.ts", "tests/integration/auth/route-inventory.test.ts"],
        requires: ["tests/integration/registries/record-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/support/app-harness.ts", "tests/fixtures/books/books-v1.expected.json"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D15.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the rules, the stores and the routes of the records.
  {
    id: "D15",
    ready: true,
    title: "Records of a registry: rules, SQLite stores and adding and listing over HTTP",
    steps: ["D15.1", "D15.2", "D15.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D16.1",
    ready: true,
    title: "The list of registries in the browser: route behind the gate, cards, loading, empty and error states",
    criteria: ["D16.1-AC1", "D16.1-AC2", "D16.1-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D16.1-AC1", "D16.1-AC2"],
        description: "pnpm -r build: the SPA with the registries route and its API layer",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/registers-page.tsx", "apps/web/src/features/registers/api/registries.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D16.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all five namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "registers-e2e",
        criteria: ["D16.1-AC1", "D16.1-AC2"],
        description:
          "Playwright on a fresh installation: from the private screen to an empty list, a card with the name, the symbol and the number of columns (singular and plural), a name with markup shown as text that runs nothing; without a session and with a password session the page leads to the sign-in and the second factor; a failing connection and a server error show the alert with the reference code and 'try again' works; an answer off the contract is not believed; a session that ended while the page was open leads to the sign-in; axe",
        command: ["node", "tests/verification/e2e.ts", "registers"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/registers.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D16.1-regression"),
    ],
  },
  {
    id: "D16.2",
    ready: true,
    title: "The form of a new registry in the browser: suggested symbol, live checks, the refusals of the server at their fields",
    criteria: ["D16.2-AC1", "D16.2-AC2", "D16.2-regression"],
    checks: [
      {
        // Runs first: the unit test imports the built core and the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D16.2-AC1", "D16.2-AC2"],
        description: "pnpm -r build: the SPA with the form of a new registry and the issues of a refusal in the client",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/components/new-registry-form.tsx", "apps/web/src/features/registers/lib/registry-draft.ts"],
      },
      {
        id: "symbol-parity",
        criteria: ["D16.2-AC1"],
        description: "The symbol the form offers equals the symbol core offers on one table of names and taken sets, always passes the pattern and the length; the client keeps the paths and codes of a refusal and nothing else of its details",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/suggest-symbol.test.ts", "tests/unit/web/api-client.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D16.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all five namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "new-registry-e2e",
        criteria: ["D16.2-AC1", "D16.2-AC2"],
        description:
          "Playwright on a fresh installation: Książki of F01 with its nine columns made from the form without SQL (symbols follow the names, the types, decimals and the required flag reach the server as typed and no default is sent, the table exists), the symbol stops following the name once typed and a taken one gets a number; a wrong symbol is told while typed and nothing is sent, a missing name, symbol and column are told after an attempt; a taken symbol and a reserved column symbol come back from the server at their fields with everything typed kept; a repeated column symbol is told at once; a double click makes one registry; the keyboard and the focus; a failing connection keeps the form; axe",
        command: ["node", "tests/verification/e2e.ts", "new-registry", "registers"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D16.2-regression"),
    ],
  },
  {
    id: "D16.3",
    ready: true,
    title: "The records of a registry in the browser: the table with server paging and the window that adds a record",
    criteria: ["D16.3-AC1", "D16.3-AC2", "D16.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D16.3-AC1", "D16.3-AC2"],
        description: "pnpm -r build: the SPA with the registry page, the table of records and the window that adds one",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/registry-page.tsx", "apps/web/src/features/registers/components/record-dialog.tsx", "apps/web/src/features/registers/components/records-table.tsx"],
      },
      {
        id: "record-input",
        criteria: ["D16.3-AC1"],
        description: "An amount typed as 10,37 is 1037 and survives the round trip, a number and a boolean are parsed or refused, the wall of a zone and its UTC instant (winter, summer, the repeated and the skipped hour of a clock change, impossible dates), values are read in the owner's language and zone",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/record-input.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D16.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all five namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "records-e2e",
        criteria: ["D16.3-AC1", "D16.3-AC2"],
        description:
          "Playwright on a fresh installation: Książki and its first record from the browser alone (a field for every column, the required one marked, the defaults of the catalog in place, the window closes after the answer of the server, values read by their types, the amount in grosze and the date-time in UTC on the server), 25 records as pages of 10, 10 and 5 with the count and the newest first, a new record on the first page; markup in a value is text; a record without a title leaves the window open with the message at the field and nothing stored (white space too), a value of no type is told without a request and a refusal of the server at its field, a response lost after the commit is repeated as the same record and a changed value gets a new key, a changed schema is told and nothing typed is lost, an ended session leads to the sign-in, a failing server keeps the window, Escape and Cancel return the focus, an unknown registry; the parent smoke from the form to the record; axe",
        command: ["node", "tests/verification/e2e.ts", "records"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/records.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D16.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the list, the form and the records in a real browser.
  {
    id: "D16",
    ready: true,
    title: "Minimal UI of registries: the list, the form of a new registry, the records and the window that adds one",
    steps: ["D16.1", "D16.2", "D16.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D17.1",
    ready: true,
    title: "Manifest of a widget type and the snapshot of a screen: contracts, the register table definition, the catalog of this build",
    criteria: ["D17.1-AC1", "D17.1-AC2", "D17.1-regression"],
    checks: [
      {
        // Runs first: the unit tests import the built contracts and widget definitions.
        id: "workspace-build",
        criteria: ["D17.1-AC1", "D17.1-AC2"],
        description: "pnpm -r build produces contracts with the screen schemas and the widget definitions with the register table",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/contracts/src/http/screens.ts", "packages/widgets/src/definition.ts", "packages/widgets/src/register-table/manifest.ts"],
      },
      {
        id: "screens-contract",
        criteria: ["D17.1-AC1"],
        description:
          "The screen of F01 passes the snapshot schema; a state, an owner, an id, a revision, a large layout or any other field the server alone decides is refused on the screen, the widget, the layout, the binding and its target; identifiers are UUID version 7, targets one of five kinds, ordinals and rectangles whole numbers in range; the accents equal the tokens of the web app; 32 KiB of configuration (counted in UTF-8) passes and one byte more does not, 50 widgets and 64 bindings pass and one more does not",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/dashboard/screens-contract.test.ts"],
        requires: ["tests/unit/dashboard/screens-contract.test.ts", "tests/fixtures/books/books-v1.export.json"],
      },
      {
        id: "widget-definitions",
        criteria: ["D17.1-AC2"],
        description:
          "The catalog of this build knows the register table and nothing else; its slots, capability and sizes; the configuration of F01 passes with the defaults of the plan, the page size is 1 to 100, a copy of the source or the columns is refused, an unknown version goes back to the owner (NEEDS_REFRESH) and the input is not changed; the shape of the bindings (unknown slot, cardinality, accepted kinds, ordinals) and the required slots; the built definitions import only each other, the contracts and zod",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/dashboard/widget-definitions.test.ts"],
        requires: ["tests/unit/dashboard/widget-definitions.test.ts"],
      },
      ...regressionChecks("D17.1-regression"),
    ],
  },
  {
    id: "D17.2",
    ready: true,
    title: "Rules of the design of a screen: targets in the catalog of the owner, one registry, paths, layouts, states of widgets",
    criteria: ["D17.2-AC1", "D17.2-AC2", "D17.2-regression"],
    checks: [
      {
        // Runs first: the unit tests import the built core, contracts and the catalog adapter of the server.
        id: "workspace-build",
        criteria: ["D17.2-AC1", "D17.2-AC2"],
        description: "pnpm -r build produces core with the dashboard module and the server with the catalog of widget types",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/dashboard/domain/design-rules.ts", "packages/core/src/modules/dashboard/ports.ts", "apps/server/src/adapters/widget-catalog.ts"],
      },
      {
        id: "design-rules",
        criteria: ["D17.2-AC1", "D17.2-AC2"],
        description:
          "On the real catalog of widget types and a catalog of registries the test controls: the register table of F01 is ok with the defaults of its configuration (and the screen goes through the transport schema and the rules alike), no bindings or no columns are a draft, a column or registry deleted since is needs_rebinding and the screen is still accepted, a version of the configuration this build does not write is needs_refresh and wins, the state of a stored widget is worked out again; refused with the path and the code: a column of another registry, a target of another owner or of none, a path that disagrees with the identity, two registries in one widget, an unknown slot, a second binding in a slot of one, a kind the slot does not take, a repeated or skipped ordinal, an unknown type, a wrong configuration, sizes over the limits, a layout off the grid or too small, a widget id invalid, twice or taken from another screen, a bad name, theme or accent, 51 widgets; all defects at once without a value in them; a hostile snapshot without an exception; registries looked up once",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/dashboard/design-rules.test.ts"],
        requires: ["tests/unit/dashboard/design-rules.test.ts", "tests/fixtures/books/books-v1.export.json"],
      },
      ...regressionChecks("D17.2-regression"),
    ],
  },
  {
    id: "D17.3",
    ready: true,
    title: "The screen, its widgets and bindings on real SQLite: one aggregate, replaced atomically, identifiers never taken over",
    criteria: ["D17.3-AC1", "D17.3-AC2", "D17.3-regression"],
    checks: [
      {
        // Runs first: the integration tests use the built core, sqlite and server packages.
        id: "workspace-build",
        criteria: ["D17.3-AC1", "D17.3-AC2"],
        description: "pnpm -r build produces sqlite with the migration of the dashboard and the adapters of the store and the catalog reader",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/0012-dashboard.ts", "packages/sqlite/src/adapters/dashboard/dashboard-store.ts", "packages/sqlite/src/adapters/dashboard/catalog-reader.ts"],
      },
      {
        id: "dashboard-store",
        criteria: ["D17.3-AC1", "D17.3-AC2"],
        description:
          "The screen of F01 written and read back equal (configuration, layouts, five bindings in order), also after a restart; a replacement removes the widgets not in the design with their bindings and keeps the others in their rows, two widgets swap places in one write, the order of the bindings is kept; the catalog reader gives a registry with its deleted columns and only to its owner, and the screen of a widget; the state of a stored widget follows the catalog without a write; a failure in the middle of a replacement leaves the screen exactly as it was; a widget identifier of another screen is refused by the rules and by the store alone, a screen of another owner is neither found nor replaced; the CHECKs, keys and cascades of the tables; the index by registry; a database of the version before upgrades with its data; SQL and markup in a title stay values",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dashboard", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/dashboard/dashboard-store.test.ts", "tests/integration/sqlite/migrations.test.ts", "tests/fixtures/books/books-v1.export.json"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D17.3-regression"),
    ],
  },
  {
    id: "D17.4",
    ready: true,
    title: "The screen over HTTP: creating it, saving its design, the types of widgets and the data of a widget from its saved bindings",
    criteria: ["D17.4-AC1", "D17.4-AC2", "D17.4-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and compose the built application.
        id: "workspace-build",
        criteria: ["D17.4-AC1", "D17.4-AC2"],
        description: "pnpm -r build produces the server with the screen routes, the dashboard use cases and the contracts of the screen",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/screens.routes.ts", "packages/core/src/modules/dashboard/application/screens.ts", "packages/contracts/src/http/screens.ts"],
      },
      {
        id: "dashboard-http",
        criteria: ["D17.4-AC1", "D17.4-AC2"],
        description:
          "Raw HTTP on the built server and on the application composed in the test process: the first screen, the register table of F01 saved and read back canonical (defaults of the configuration, states worked out), its data as the 25 records in pages of 10, 10 and 5 with only the bound columns, the same after a restart, the manifest of the type, a table sorted by a column of its registry; every state before the gate on the six routes, a foreign Origin, one screen per owner, a bad name, an unknown screen; a design refused with every issue at its path and the screen as it was (unknown type, registry of nobody, column of another registry, two registries, path that disagrees, configuration, layout, repeated and taken widget id); a state, an owner or an id sent by the client and a body over the limit refused by the contract; a widget that is not ok (draft, deleted column or registry, configuration of the future) reads nothing and no query is made (the table is taken away and the answer is still 200); the client names only the widget and the page; a removed widget is gone; an ended session, a failing write and a failing audit leave the screen as it was; the audit holds the number of widgets only",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dashboard/dashboard-http.test.ts", "tests/integration/auth/route-inventory.test.ts"],
        requires: ["tests/integration/dashboard/dashboard-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/support/signed-in-harness.ts", "tests/fixtures/books/books-v1.expected.json"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D17.4-regression"),
    ],
  },
  // The parent passes only through its work orders: the contract and the definition, the rules, the store and the routes.
  {
    id: "D17",
    ready: true,
    title: "Widget manifest, bindings and the saving of a screen with the register table",
    steps: ["D17.1", "D17.2", "D17.3", "D17.4"],
    criteria: [],
    checks: [],
  },
  {
    id: "D18.1",
    ready: true,
    title: "The private screen: widgets on the grid of the layout the window calls for, the register table view, the window that adds a record",
    criteria: ["D18.1-AC1", "D18.1-AC2", "D18.1-regression"],
    checks: [
      {
        // Runs first: the unit tests read the built views and the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D18.1-AC1", "D18.1-AC2"],
        description: "pnpm -r build: the widget views package, the SPA with the screen, the grid and the composition of the add-record window",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/widgets/src/register-table/View.tsx", "apps/web/src/features/dashboard/pages/main-page.tsx", "apps/web/src/lib/layout/grid.ts"],
      },
      {
        id: "layout-and-views",
        criteria: ["D18.1-AC1", "D18.1-AC2"],
        description:
          "The layout a width calls for (below 768 phone, 768 to 1279 tablet, 1280 and more desktop, odd widths without a crash), the grid of 1, 8 and 12 columns with rows of 32 px and a gap of 16 px, the cell a rectangle gives, the reading order per layout; the built register table view contains no fetch, query client, storage, router or import of the application and imports only React",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/layout.test.ts", "tests/unit/web/widget-views.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D18.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in every namespace",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/widgets.json", "apps/web/src/locales/en/widgets.json"],
      },
      {
        id: "dashboard-e2e",
        criteria: ["D18.1-AC1", "D18.1-AC2"],
        description:
          "Playwright on a fresh installation: the screen of F01 with 25 records as pages of 10, 10 and 5 with the bound columns only, the window with the whole structure of the registry, the added record on the first page after the answer and after a reload; no button when adding is off, an empty table says so; the phone, the tablet and the desktop each place two widgets by their own layout (one column under each other, two side by side of 4 columns, two of 6 columns of 368 px height); markup in a title and a value is text; no screen and an empty screen invite to the Designer; a draft, a broken binding and a configuration to confirm say so with the link; a widget that fails to draw does not take the other widget with it and 'try again' draws it anew; a failing read has 'try again', an ended session leads to the sign-in; a screen the server cannot give has 'try again'; axe",
        // "dashboard" alone matches the path of the repository (OpenLifeDashboard) and would run every spec.
        command: ["node", "tests/verification/e2e.ts", "dashboard.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/dashboard.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D18.1-regression"),
    ],
  },
  {
    id: "D18.2",
    ready: true,
    title: "The Designer: a widget added, bound, arranged per layout with the mouse and saved",
    criteria: ["D18.2-AC1", "D18.2-AC2", "D18.2-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D18.2-AC1", "D18.2-AC2"],
        description: "pnpm -r build: the SPA with the Designer and the pinned grid library",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/pages/designer-page.tsx", "apps/web/src/features/dashboard/components/design-canvas.tsx", "apps/web/src/features/dashboard/lib/layout-edit.ts"],
      },
      {
        id: "designer-units",
        criteria: ["D18.2-AC1"],
        description:
          "The first free place in the three layouts (empty, beside, below, a gap, a column left by a tall widget, the phone), a size narrowed to the columns, a change of one layout that leaves the other two the very same rectangles, the items of the grid library written back into one layout and no change when it reports what is there, the state of the Designer (unsaved, save with edits meanwhile, canonical comparison), the bindings of the register table in both directions with the paths the server checks, a UUID version 7 for a new widget",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web"],
        requires: ["tests/unit/web/layout-edit.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D18.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in every namespace, the designer one included",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "designer-e2e",
        criteria: ["D18.2-AC1", "D18.2-AC2"],
        description:
          "Playwright on a fresh installation: the first screen created in the Designer, a register table added, bound to a registry and two columns and saved, shown by the screen; a second widget in the first free place of each layout; a real mouse drag and a resize that change the desktop layout only and survive a reload; a refused save (422) that shows the error and keeps every change; a lost connection that keeps them and a repeated save that works; leaving with unsaved changes that asks (stay keeps, leave drops, nothing was saved) and the browser's own confirmation on a closing page; the widget types that cannot be read with 'try again'; axe",
        command: ["node", "tests/verification/e2e.ts", "designer.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D18.2-regression"),
    ],
  },
  {
    id: "D18.3",
    ready: true,
    title: "The vertical path of D18: registry, Designer, three layouts, restart, record from the widget",
    criteria: ["D18.3-AC1", "D18.3-AC2", "D18.3-regression"],
    checks: [
      {
        // Runs first: the browser test uses the built server and SPA.
        id: "workspace-build",
        criteria: ["D18.3-AC1"],
        description: "pnpm -r build: the SPA and the server the restart is made on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/pages/designer-page.tsx", "apps/web/src/features/dashboard/pages/main-page.tsx"],
      },
      {
        id: "vertical-e2e",
        criteria: ["D18.3-AC1"],
        description:
          "Playwright on a fresh installation, no SQL and no test API: a registry from its form, a register table bound to it in the Designer, a different arrangement in the phone, tablet and desktop layouts made with the mouse, a save, a restart of the server on the same data, and /main in the three widths with the widget in the place each layout gave it; a record added from the widget is on the first page and after a reload; axe",
        command: ["node", "tests/verification/e2e.ts", "vertical"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/vertical.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        // Analiza/ is not in this repository, so the written result of the proof (Architektura, "Wynik PoC siatki") is reviewed by hand; what CI can run is the behaviour it describes.
        id: "grid-poc-behaviour",
        criteria: ["D18.3-AC2"],
        description:
          "The behaviour the grid proof records, run in a real browser: a widget dropped on another takes its place and the other is pushed below it with no overlap saved, a drag and a resize change one layout only, and each layout keeps its own place",
        command: ["node", "tests/verification/e2e.ts", "designer.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D18.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the screen, the Designer and the vertical path.
  {
    id: "D18",
    ready: true,
    title: "Minimal Designer and screen: a widget placed, saved and kept over a restart in three layouts",
    steps: ["D18.1", "D18.2", "D18.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D20.1",
    ready: true,
    title: "The vertical path of the owner on a file SQLite: installer-state owner to 25 records, pages and two restarts",
    criteria: ["D20.1-AC1", "D20.1-AC2", "D20.1-regression"],
    checks: [
      {
        // Runs first: the browser test uses the built server and SPA.
        id: "workspace-build",
        criteria: ["D20.1-AC1"],
        description: "pnpm -r build: the SPA and the server the path runs on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/pages/main-page.tsx", "apps/server/src/main.ts"],
      },
      {
        id: "g1-path-e2e",
        criteria: ["D20.1-AC1", "D20.1-AC2"],
        description:
          "Playwright on a fresh installation, no SQL and no test API: the owner as the installer leaves it signs in, enrols the authenticator from the key on the page, acknowledges the recovery codes, starts empty, makes Książki from its form, adds 25 records under idempotency keys, binds a register table in the Designer and reads pages of 10, 10 and 5; the same key adds once, the same key with another body and a record without its title store nothing, nothing private answers before the enrollment is finished; two restarts of the server leave the records and the screen identical; axe",
        command: ["node", "tests/verification/e2e.ts", "g1-path"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/g1-path.spec.ts", "tests/e2e/owner-session.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D20.1-regression"),
    ],
  },
  {
    id: "D20.2",
    ready: true,
    title: "Attempts to go around the gate on every data route, and the inventory of the routes that are planned",
    criteria: ["D20.2-AC1", "D20.2-AC2", "D20.2-regression"],
    checks: [
      {
        // Runs first: the test starts the built server and its CLI.
        id: "workspace-build",
        criteria: ["D20.2-AC1", "D20.2-AC2"],
        description: "pnpm -r build: the server and the create-owner command the routes are tried on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts", "apps/server/src/cli/create-owner.ts"],
      },
      {
        id: "data-routes-access",
        criteria: ["D20.2-AC1", "D20.2-AC2"],
        description:
          "The built server over a file SQLite, raw HTTP: every route the inventory marks as data access, tried with no session, a cookie that names none, a password only, enrolled with the codes not acknowledged, acknowledged with the data not chosen, a new password session of the finished owner, an ended session and the session of another installation, with and without data: 401 or 403 with a stable code, no cookie set, nothing stored, never 404; the same routes answer 200 or 201 to the owner past the gate, and a route without that positive control fails; foreign owner, session, assurance and role in headers, cookies, query and body decide nothing; export and the live stream are planned, not registered, and reported as not_run with the task that owns them",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/access/data-routes.test.ts"],
        requires: ["tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts", "tests/support/auth-http.ts"],
      },
      ...regressionChecks("D20.2-regression"),
    ],
  },
  {
    id: "D20.3",
    ready: true,
    title: "Gate G1: the reports of the vertical path joined, item by item",
    criteria: ["D20.3-AC1", "D20.3-AC2", "D20.3-regression"],
    checks: [
      {
        id: "g1-gate-controls",
        criteria: ["D20.3-AC2"],
        description:
          "The G1 gate on synthetic reports: a complete set passes; a failed or renamed test line and a failed check fail; a missing report and a report of other code are blocked; the result always lists every item",
        command: ["node", "tests/verification/g1-gate-controls.ts"],
        requires: ["tests/verification/g1-gate-controls.ts", "tests/verification/g1-gate.ts", "tests/verification/g1-matrix.ts", "tests/verification/gate-controls.ts", "tests/verification/gate-run.ts"],
      },
      {
        id: "g1-gate",
        criteria: ["D20.3-AC1"],
        description:
          "Joins the reports of D12, D15.3, D16.3, D18.1, D18.3, D19.3, D20.1 and D20.2 for exactly this code and decides every item of G1 from the passed test that proves it: installation, login with the second factor, own registry, widget, pages 10/10/5, the same key once, no store without the second factor or the title, restarts, no way around the gate; names what is not run. A missing report is blocked",
        command: ["node", "tests/verification/g1-gate.ts"],
        requires: ["tests/verification/g1-gate.ts", "tests/verification/g1-matrix.ts", "tests/verification/gate-run.ts", "tests/verification/report-join.ts", "tests/support/route-inventory.ts"],
      },
      ...regressionChecks("D20.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the path in a browser, the attempts to go around the gate and the gate.
  {
    id: "D20",
    ready: true,
    title: "The vertical path of the owner and gate G1",
    steps: ["D20.1", "D20.2", "D20.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D22.1",
    ready: true,
    title: "Every column type in the web app: what is typed becomes the canonical value core accepts, and amounts are exact on the whole safe range",
    criteria: ["D22.1-AC1", "D22.1-AC2", "D22.1-regression"],
    checks: [
      {
        // Runs first: the conformance test reads the rule of core from its build.
        id: "workspace-build",
        criteria: ["D22.1-AC1", "D22.1-AC2"],
        description: "pnpm -r build: core/registries with the rule of a value, the web app with its conversion and format",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/registries/domain/column-rules.ts", "apps/web/src/features/registers/lib/record-input.ts", "apps/web/src/lib/format/cell-format.ts"],
      },
      {
        id: "column-values-web",
        criteria: ["D22.1-AC1", "D22.1-AC2"],
        description:
          "A table of typed inputs for the eight types: every value the form accepts passes isValidCellValue of core (number with 0, 2 and 6 places); 1037 ↔ 10,37 and ±9 007 199 254 740 991 grosze survive the round trip and the format without a lost grosz; more places than the column, an exponent, three places of an amount, one grosz beyond the safe range, a date off the calendar, 24:00 and a date-time that is no wall time are refused before anything is sent",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/record-input.test.ts"],
        requires: ["tests/unit/web/record-input.test.ts"],
      },
      ...regressionChecks("D22.1-regression"),
    ],
  },
  {
    id: "D22.2",
    ready: true,
    title: "The form of a new registry as rows (makieta 07): one row per column, no default, the rows to fix counted at the bottom, the state colours as tokens",
    criteria: ["D22.2-AC1", "D22.2-AC2", "D22.2-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D22.2-AC1", "D22.2-AC2"],
        description: "pnpm -r build: the SPA with the form of a new registry as rows and the tokens of the states",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/components/new-registry-form.tsx", "apps/web/src/features/registers/lib/registry-draft.ts", "packages/ui/src/tokens/dark-theme.json"],
      },
      {
        id: "state-tokens",
        criteria: ["D22.2-AC1"],
        description: "The colours of an error, a warning and a success (makieta 18) reach text contrast on cards, raised surfaces, the background and their own surface",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/ui"],
        requires: ["tests/unit/ui/theme-tokens.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D22.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "new-registry-rows-e2e",
        criteria: ["D22.2-AC1", "D22.2-AC2"],
        description:
          "Playwright on a fresh installation: Książki of F01 (nine columns, eight types) from rows of the form without SQL, a row has a name, a symbol, a type with the places of a number and the flag and no default, the server holds the types, places and flags and no default, the request carries no defaultValue; a wrong or repeated symbol and a missing name are told at the field of the row, the bottom counts the rows to fix and the form cannot be sent until they are fixed, a refusal of the server is told at its field with everything typed kept; axe; the list of registries on the wide page",
        command: ["node", "tests/verification/e2e.ts", "new-registry", "registers"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/fixtures.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D22.2-regression"),
    ],
  },
  {
    id: "D22.3",
    ready: true,
    title: "Every column type through the window of a record and the table (makieta 08): F01 typed in is stored as the fixture holds it, F03 over HTTP",
    criteria: ["D22.3-AC1", "D22.3-AC2", "D22.3-regression"],
    checks: [
      {
        // Runs first: the browser and HTTP tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D22.3-AC1", "D22.3-AC2"],
        description: "pnpm -r build: the SPA with the page of a registry and the window of a record",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/registry-page.tsx", "apps/web/src/features/registers/components/record-dialog.tsx", "apps/web/src/features/registers/components/records-table.tsx"],
      },
      {
        id: "f03-http",
        criteria: ["D22.3-AC2"],
        description: "The eight cases of F03 on Książki of F01 over real HTTP on the built server: each gets the status and the code of the fixture, a refusal stores nothing, markup is stored as text",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-types-http.test.ts"],
        requires: ["tests/integration/registries/record-types-http.test.ts", "tests/fixtures/cases/record-validation.cases.json", "tests/fixtures/books/books-v1.export.json"],
      },
      {
        id: "check-locales",
        criteria: ["D22.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "record-types-e2e",
        criteria: ["D22.3-AC1", "D22.3-AC2"],
        description:
          "Playwright on a fresh installation: the 25 records of F01 with all nine columns typed into the window one by one are stored value for value as the fixture holds them (amounts in grosze, date-times as the instant of the wall of Warsaw) and list as the pages of the expected file, the table reads them back by type (1037 as 10.37, the date-time in the owner's zone), the columns at a glance; an unfinished date and date-time, an amount with three places and one beyond the safe range are told at their fields with no request, the largest amount is stored exactly; the records of D16.3 with the new marker of a required field; axe",
        command: ["node", "tests/verification/e2e.ts", "record-types", "records"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/record-types.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/fixtures.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D22.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the values in the web app, the form of a registry and the window of a record.
  {
    id: "D22",
    ready: true,
    title: "Every column type: canonical values, the form of a registry as rows and the window of a record",
    steps: ["D22.1", "D22.2", "D22.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D23.1",
    ready: true,
    title: "Changing, deleting and reading one record over HTTP on the revision the form was built on (compare and set)",
    criteria: ["D23.1-AC1", "D23.1-AC2", "D23.1-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and read the rules of core from its build.
        id: "workspace-build",
        criteria: ["D23.1-AC1", "D23.1-AC2"],
        description: "pnpm -r build produces the server with the routes of one record, the rule of a change in core and the compare and set of the record store",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/records.routes.ts", "packages/contracts/src/http/records.ts", "packages/core/src/modules/registries/application/records.ts", "packages/sqlite/src/adapters/registries/record-store.ts"],
      },
      {
        id: "record-change-rules",
        criteria: ["D23.1-AC1", "D23.1-AC2"],
        description:
          "The rule of a change on the schema of F01: the columns it leaves out keep their stored values, the joined record is checked whole (a required title set to null or blanks, a value of a wrong type, the size), an empty change, a system and an unknown field are refused and named, and a stored text longer than a lowered limit is kept while a new one over it is refused",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/registries/record-rules.test.ts"],
        requires: ["tests/unit/registries/record-rules.test.ts"],
      },
      {
        id: "record-store-revision",
        criteria: ["D23.1-AC1", "D23.1-AC2"],
        description:
          "A real SQLite file: a record of F01 changed on revision 1 has revision 2 and every value written, the same revision 1 again changes nothing; a delete on a stale revision keeps the record and on the stored one removes it once; each write raises data_revision by one; a failure later in the unit takes a change and a delete back with their revision; another owner, a column outside the catalog, a revision that is not the next and a registry changed since it was read never reach a write",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-store.test.ts"],
        requires: ["tests/integration/registries/record-store.test.ts"],
      },
      {
        id: "record-edit-http",
        criteria: ["D23.1-AC1", "D23.1-AC2"],
        description:
          "Raw HTTP on the built server with Książki of F01: two changes of revision 1 give 200 with revision 2 and 409 RECORD_CONFLICT without a write or a value in the details, the column the first changed stays after the second is made on revision 2, a delete is 204 and data_revision rises by one per write, the same after a restart; a stale schema (checked before the revision), system and unknown fields, an empty change, a required title set to null, a missing or zero revision, an owner in the body and a foreign Origin are refused and write nothing; an unknown record, one of another installation and an unknown registry are 404 for a read, a change and a delete; a delete on a stale revision keeps the record, a repeated delete and a late change are 404; a change repeated after a lost answer is a conflict, and an add repeated with its key is still one record (D15); the route inventory and every state before the gate on the new routes (D13.1, D20.2)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-edit-http.test.ts", "tests/integration/registries/record-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/unit/web/error-message.test.ts"],
        requires: ["tests/integration/registries/record-edit-http.test.ts", "tests/integration/registries/record-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D23.1-regression"),
    ],
  },
  {
    id: "D23.2",
    ready: true,
    title: "Searching the records of a registry over HTTP: a fragment of the textual columns, letter case aside, wildcards as text",
    criteria: ["D23.2-AC1", "D23.2-AC2", "D23.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and use the built store.
        id: "workspace-build",
        criteria: ["D23.2-AC1", "D23.2-AC2"],
        description: "pnpm -r build produces the rule of a search in core, the text fold on every SQLite connection and the search parameter of the list route",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/registries/domain/record-rules.ts", "packages/sqlite/src/connection/open-database.ts", "packages/sqlite/src/adapters/registries/record-store.ts", "packages/contracts/src/http/records.ts"],
      },
      {
        id: "record-search-rules-store",
        criteria: ["D23.2-AC1", "D23.2-AC2"],
        description:
          "The rule of a search (trimmed, white space is no filter, more than 100 code points refused, only text and choice searched) and a real SQLite file with F01: a fragment of any textual column matches in every letter case with the count of the matches, sorted by title and in pages; Ł, Ó, Ź, Ż fold both ways; %, _ and the backslash are text and an SQL fragment is a value; a registry without textual columns matches nothing; a search the rule would not give never reaches SQL; a page of 100 with a search over 50 000 records is measured (p95, printed with the machine) against the budget of §16",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/registries/record-rules.test.ts", "tests/integration/registries/record-store.test.ts"],
        requires: ["tests/unit/registries/record-rules.test.ts", "tests/integration/registries/record-store.test.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        id: "record-search-http",
        criteria: ["D23.2-AC1", "D23.2-AC2"],
        description:
          "Raw HTTP on the built server with the 25 records of F01 added through the API: a fragment of a title, an author or a status returns exactly its records and their count in any letter case, sorted by title and in pages, with the revisions of the registry unchanged; % and _ are text, 101 code points is 422 SEARCH_TOO_LONG while 100 padded with spaces is taken, a search given twice is 422, white space lists all 25; the list without a search and the data of a widget are as before (D15.3, D17.4)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/record-search-http.test.ts", "tests/integration/registries/record-http.test.ts", "tests/integration/dashboard/dashboard-http.test.ts"],
        requires: ["tests/integration/registries/record-search-http.test.ts", "tests/integration/registries/record-http.test.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D23.2-regression"),
    ],
  },
  {
    id: "D23.3",
    ready: true,
    title: "Changing and deleting a record in the browser (makieta 08, 21): the actions of a row, the shared window, a conflict compared and resolved, a delete asked first",
    criteria: ["D23.3-AC1", "D23.3-AC2", "D23.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D23.3-AC1", "D23.3-AC2"],
        description: "pnpm -r build: the SPA with the actions of a row, the window of a record in both modes and the question before a delete",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/registry-page.tsx", "apps/web/src/features/registers/components/record-dialog.tsx", "apps/web/src/features/registers/components/delete-record-dialog.tsx", "apps/web/src/features/registers/lib/record-edit.ts"],
      },
      {
        id: "record-edit-web",
        criteria: ["D23.3-AC1", "D23.3-AC2"],
        description:
          "Pure functions of the form: every stored value shown in its field reads back as the same value, so an untouched form sends nothing; a change sends only the fields that differ from its base; a conflict lists only the fields that differ from the server, with an unfinished entry as typed; loading the newer record keeps the fields the owner changed and takes the others, so the other session's change is not sent back; the name of a record in a label",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/record-edit.test.ts", "tests/unit/web/record-input.test.ts", "tests/unit/web/error-message.test.ts"],
        requires: ["tests/unit/web/record-edit.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D23.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "record-edit-e2e",
        criteria: ["D23.3-AC1", "D23.3-AC2"],
        description:
          "Playwright on a fresh installation with Książki: a record changed in the window opens on its stored values, shows its new value and is stored with revision 2, the focus back on its button; two tabs change one record: the second tells the time of the change in the owner's zone, compares only the differing fields, keeps what was typed, keeps saving disabled and sends nothing more until the newer version is loaded, then saves the owner's fields and keeps the other tab's; a delete asks first naming the record, Escape keeps it with the focus back, confirmed the row and the count go and the focus is on Add; a record deleted in the other tab is taken as deleted without an error; a change whose answer was lost after the server saved it is saved once and shows no conflict; the widget on /main has no actions; the add of D16.3 and D22.3 as before; axe",
        command: ["node", "tests/verification/e2e.ts", "record-edit", "records", "record-types"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/record-edit.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/record-types.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D23.3-regression"),
    ],
  },
  {
    id: "D23.4",
    ready: true,
    title: "Searching, sorting and paging the records in the browser (makieta 08): the view in the address, a range pager, a search sent after a pause",
    criteria: ["D23.4-AC1", "D23.4-AC2", "D23.4-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA, the unit test reads the limit of core from its build.
        id: "workspace-build",
        criteria: ["D23.4-AC1", "D23.4-AC2"],
        description: "pnpm -r build: the SPA with the search, the sort and the pager of the page of a registry and the view in its address",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/registry-page.tsx", "apps/web/src/features/registers/lib/records-view.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "records-view-web",
        criteria: ["D23.4-AC1", "D23.4-AC2"],
        description:
          "The view in the address: missing or foreign values fall back to the defaults, the address holds only what differs and reads back the same, a search keeps at most the 100 code points of core, a new search or sort is page 1; the options of Sort (newest, then each column both ways) and the range of the pager",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/records-view.test.ts"],
        requires: ["tests/unit/web/records-view.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D23.4-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "record-search-e2e",
        criteria: ["D23.4-AC1", "D23.4-AC2"],
        description:
          "Playwright on a fresh installation with the 25 records of F01: a fragment in any letter case shows exactly its records with 1–N of N and lands in the address, Sort by title ascending is the order of the fixture page after page, a reload keeps the search, the sort and the page and back returns to the page before; no match says so in one sentence with Clear the search, a new search starts from page 1, the box takes 100 characters; a slower answer to an older search does not replace the newer one; while the next page loads the range stays with the rows on screen and the table is busy; on a phone the page does not scroll sideways and the table scrolls in its region; the widget has no search and no sort; the records, types and edits of D16.3, D22.3 and D23.3 with the new pager; axe",
        command: ["node", "tests/verification/e2e.ts", "record-search", "records", "record-types", "record-edit"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/record-search.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/record-types.spec.ts", "tests/e2e/record-edit.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D23.4-regression"),
    ],
  },
  // The parent passes only through its work orders: change, delete and search over HTTP and in the browser.
  {
    id: "D23",
    ready: true,
    title: "Changing, deleting, searching and sorting the records of a registry: compare and set over HTTP, the conflict of two tabs and the view in the address",
    steps: ["D23.1", "D23.2", "D23.3", "D23.4"],
    criteria: [],
    checks: [],
  },
  {
    id: "D24.1",
    ready: true,
    title: "The dictionaries in core and SQLite: rules, stores, use cases with compare and set, unpinning through the catalog, labels for the registries",
    criteria: ["D24.1-AC1", "D24.1-AC2", "D24.1-regression"],
    checks: [
      {
        // Runs first: the tests read core and the adapters from their build.
        id: "workspace-build",
        criteria: ["D24.1-AC1", "D24.1-AC2"],
        description: "pnpm -r build: the module core/dictionaries, migration 13, the dictionary adapter and the column links of the registries adapter",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/dictionaries/public.ts", "packages/sqlite/src/migrations/0013-dictionaries.ts", "packages/sqlite/src/adapters/dictionaries/dictionary-store.ts", "packages/sqlite/src/adapters/registries/column-links.ts"],
      },
      {
        id: "dictionary-rules",
        criteria: ["D24.1-AC1", "D24.1-AC2"],
        description:
          "The rules on the dictionary of F01: its four values in order with the archived one hidden; trimmed names and labels; a save is the whole list and the audit sees the symbols that came and went; a bad, long or taken symbol, an empty, long or controlled name, a repeated or bad value symbol, an empty label, a hidden that is no boolean, a value that is no object, the limits of 200 and 500 on their edge, each with its path; a choice column may name only a dictionary of the owner",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/dictionaries/dictionary-rules.test.ts", "tests/unit/registries/registry-rules.test.ts"],
        requires: ["tests/unit/dictionaries/dictionary-rules.test.ts", "tests/unit/registries/registry-rules.test.ts"],
      },
      {
        id: "dictionaries-sqlite",
        criteria: ["D24.1-AC1", "D24.1-AC2"],
        description:
          "A real SQLite file with the production adapters and use cases: the dictionary of F01 created, read in its order and saved whole with revision + 1, kept values keep their identifiers, the same after a restart, audited; the lookup gives Archiwalne for the hidden value and nothing for spoza_slownika or for another owner; the list has the column of Książki that uses it; deleting it unpins the column, raises the schema revision and leaves the 25 records and their status counts as they were, and frees the symbol; a stale revision, a taken symbol, the limit, a bad content and another token change nothing; another owner's dictionary is not reached; a failing audit takes back a creation and a deletion with its unpinning; migration 13 in the plan",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dictionaries/dictionaries.test.ts", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/dictionaries/dictionaries.test.ts", "tests/integration/sqlite/migrations.test.ts", "tests/support/books-fixture.ts"],
      },
      {
        id: "registries-regression",
        criteria: ["D24.1-AC2"],
        description: "The registries, records and screens of F01 over SQLite and HTTP as before, with Status sent as a plain choice column where the test is not about dictionaries (D14–D23)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries", "tests/integration/dashboard"],
        requires: ["tests/integration/registries/registry-http.test.ts", "tests/integration/dashboard/dashboard-http.test.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D24.1-regression"),
    ],
  },
  {
    id: "D24.2",
    ready: true,
    title: "Dictionaries and their labels over HTTP: the routes of a dictionary, the labels of a page of records and of the data of a widget, S7",
    criteria: ["D24.2-AC1", "D24.2-AC2", "D24.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server.
        id: "workspace-build",
        criteria: ["D24.2-AC1", "D24.2-AC2"],
        description: "pnpm -r build produces the server with the routes of the dictionaries and the labels of a page, and the contracts of the dictionaries",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/dictionaries.routes.ts", "packages/contracts/src/http/dictionaries.ts", "packages/core/src/modules/registries/application/page-labels.ts"],
      },
      {
        id: "dictionary-http",
        criteria: ["D24.2-AC1", "D24.2-AC2"],
        description:
          "Raw HTTP on the built server with F01 made through the API: the page of 25 records and the data of a register table carry the labels Planowane, W trakcie, Ukończone and the hidden Archiwalne five times each and none for the five spoza_slownika, a page only its own; the list has four values and the column of Książki; deleting the dictionary unpins the column with schema revision + 1, takes every label away and leaves the records byte for byte (S7); two saves of revision 1 are 200 and 409 DICTIONARY_CHANGED without a write, the rules refuse with their paths, a taken symbol and a stale delete are 409, a column naming an unknown dictionary is 422 DICTIONARY_UNKNOWN, a record with a symbol outside the dictionary is stored, a foreign Origin, an unknown dictionary and the cookie of another installation are refused; the inventory and every state before the gate on the five routes (D13.1, D20.2); the texts of the new codes",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dictionaries/dictionary-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/unit/web/error-message.test.ts"],
        requires: ["tests/integration/dictionaries/dictionary-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        id: "records-and-widgets-regression",
        criteria: ["D24.2-AC1"],
        description: "The records and the data of a widget over HTTP as before, now with their labels (D15.3, D17.4, D23.1, D23.2)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries", "tests/integration/dashboard/dashboard-http.test.ts"],
        requires: ["tests/integration/registries/record-http.test.ts", "tests/integration/dashboard/dashboard-http.test.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D24.2-regression"),
    ],
  },
  {
    id: "D24.3",
    ready: true,
    title: "Dictionaries in the browser (makieta 22): the list and the editor, the dictionary of a column in the kreator, the choice in the window of a record, the labels in the table and the widget, S7",
    criteria: ["D24.3-AC1", "D24.3-AC2", "D24.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D24.3-AC1", "D24.3-AC2"],
        description: "pnpm -r build: the SPA with /dictionaries, the dictionary of a column in the kreator, the choice list of a record and the labels of a page",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/dictionaries-page.tsx", "apps/web/src/features/registers/components/dictionary-editor.tsx", "apps/web/src/lib/format/value-label.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "dictionary-draft-web",
        criteria: ["D24.3-AC1", "D24.3-AC2"],
        description:
          "The editor and the labels as pure functions: a move keeps the other values in order, a new value gets a free symbol from its label and a stored one keeps its own, the request is the whole list in order on the revision of the editor, the field of a record offers the visible values in order and keeps a hidden or unknown current one, a label is read only as an own key of the page",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/dictionary-draft.test.ts"],
        requires: ["tests/unit/web/dictionary-draft.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D24.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "dictionaries-e2e",
        criteria: ["D24.3-AC1", "D24.3-AC2"],
        description:
          "Playwright on a fresh installation without SQL: the dictionary of F01 made on /dictionaries from Registries, Książki with its Status through it from the kreator, a record chosen from a list without the hidden value, Planowane and the hidden Archiwalne in the table and the widget; the dictionary deleted names the column it unpins, both show the raw symbol and the records are the same (S7); the order changed with the arrows and by dragging is saved and offered in that order; removing a value asks and tells what the records will show; a save from a second tab is a conflict that keeps what was typed until the owner saves it or loads the stored version; editing a record with a hidden or unknown value keeps it; on a phone the page does not scroll sideways; keyboard; axe; the kreator, the list of registries, the records, their edits and the widget of D16 to D23 as before",
        command: ["node", "tests/verification/e2e.ts", "dictionaries", "new-registry", "registers", "records", "record-edit", "dashboard.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/dictionaries.spec.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/registers.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/record-edit.spec.ts", "tests/e2e/dashboard.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D24.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the module, its HTTP and its screens.
  {
    id: "D24",
    ready: true,
    title: "Dictionaries: values in order, hidden values, labels on a page, usages and unpinning, without a foreign key from the records (S7)",
    steps: ["D24.1", "D24.2", "D24.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D25.1",
    ready: true,
    title: "ConfigTable in core and SQLite: the rules of an entry, its store, use cases with compare and set, the old and the new value in the audit, Field.Config and Field.System",
    criteria: ["D25.1-AC1", "D25.1-AC2", "D25.1-regression"],
    checks: [
      {
        // Runs first: the tests read core and the adapters from their build.
        id: "workspace-build",
        criteria: ["D25.1-AC1", "D25.1-AC2"],
        description: "pnpm -r build: the module core/configuration, migration 14, the configuration adapter and the catalog of the dashboard adapter that resolves an entry and counts its bindings",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/configuration/public.ts", "packages/sqlite/src/migrations/0014-config-entries.ts", "packages/sqlite/src/adapters/configuration/config-store.ts", "packages/sqlite/src/adapters/dashboard/catalog-reader.ts"],
      },
      {
        id: "config-rules",
        criteria: ["D25.1-AC1", "D25.1-AC2"],
        description:
          "The rules on the entry of F01: norma_czytania = \"20\" is text kept as sent, never trimmed, an empty value and description allowed, 10 000 and 500 code points on their edge; a value that is no text, too long or malformed, a description that is no text, too long or with control characters, a bad, long or taken symbol and the limit of 500 refused with their paths; Field.System gives the owner's today and yesterday across midnight and both changes of the clock, now in UTC, the zone, the language and the version; a binding to an entry needs Field.Config.<symbol> of an entry of the owner, the register table of this build takes none, and a stored widget whose entry is gone is to be bound again; the rules of a design as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/configuration/config-rules.test.ts", "tests/unit/dashboard/design-rules.test.ts"],
        requires: ["tests/unit/configuration/config-rules.test.ts", "tests/unit/dashboard/design-rules.test.ts"],
      },
      {
        id: "config-sqlite",
        criteria: ["D25.1-AC1", "D25.1-AC2"],
        description:
          "A real SQLite file with the production adapters and use cases: the entry of F01 created and stored as the text 20, read through the reader of Field.Config, saved whole with revision + 1, the same after a restart, and every change in the audit of the database with the old and the new value; the list counts the bindings of each entry; a delete frees the symbol, leaves the bindings and audits the last value; a stale revision writes and audits nothing, a taken symbol and the limit are conflicts, a bad content is refused with its paths and without its value, another token and another owner's entry change nothing; a failing audit takes back a creation, a save and a delete; migration 14 in the plan",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/configuration/config-entries.test.ts", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/configuration/config-entries.test.ts", "tests/integration/sqlite/migrations.test.ts"],
      },
      {
        id: "dashboard-regression",
        criteria: ["D25.1-AC2"],
        description: "The screens, widgets and bindings over SQLite and HTTP as before, with the catalog that now knows the entries (D17, D18)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dashboard"],
        requires: ["tests/integration/dashboard/dashboard-http.test.ts", "tests/integration/dashboard/dashboard-store.test.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D25.1-regression"),
    ],
  },
  {
    id: "D25.2",
    ready: true,
    title: "ConfigTable over HTTP: the routes of an entry, the old and the new value only in the audit of the database, never in the technical log",
    criteria: ["D25.2-AC1", "D25.2-AC2", "D25.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server.
        id: "workspace-build",
        criteria: ["D25.2-AC1", "D25.2-AC2"],
        description: "pnpm -r build produces the server with the routes of ConfigTable and the contracts of an entry",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/config.routes.ts", "packages/contracts/src/http/config.ts"],
      },
      {
        id: "config-http",
        criteria: ["D25.2-AC1", "D25.2-AC2"],
        description:
          "Raw HTTP on the built server: the entry of F01 created, listed as the text 20 with no bindings, read, saved and deleted, uncached; the audit of the database holds the old and the new value of every change, while the technical log, the output of the server and every refusal hold no value; two saves of revision 1 are 200 and 409 CONFIG_CHANGED without a write, a number for a value is 422 VALUE_NOT_TEXT, the rules refuse with their paths, a taken symbol is 409 CONFIG_SYMBOL_TAKEN, a stale delete 409, an unknown entry 404, a field of the owner is refused; a foreign Origin and the session of another installation change and read nothing; the inventory and every state before the gate on the five routes (D13.1, D20.2); the texts of the new codes",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/configuration", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/unit/web/error-message.test.ts"],
        requires: ["tests/integration/configuration/config-http.test.ts", "tests/integration/configuration/config-entries.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        id: "check-locales",
        criteria: ["D25.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces, the texts of the new codes among them",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/errors.json", "apps/web/src/locales/en/errors.json"],
      },
      ...regressionChecks("D25.2-regression"),
    ],
  },
  {
    id: "D25.3",
    ready: true,
    title: "ConfigTable in the browser (makieta 23): the list of entries with their path, value and bindings, the window of an entry, the conflict of two tabs and the delete with its bindings",
    criteria: ["D25.3-AC1", "D25.3-AC2", "D25.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA, the unit test reads the limits of core from its build.
        id: "workspace-build",
        criteria: ["D25.3-AC1", "D25.3-AC2"],
        description: "pnpm -r build: the SPA with /config, the window of an entry and the entry from the registers",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/registers/pages/config-page.tsx", "apps/web/src/features/registers/components/config-entry-dialog.tsx", "apps/web/src/features/registers/lib/config-draft.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "config-draft-web",
        criteria: ["D25.3-AC1", "D25.3-AC2"],
        description:
          "The draft of an entry as pure functions: the limits of the web app equal the rules of core, the live checks give the same paths and codes as core on the same drafts, the value and the description are sent as typed and only the name trimmed, an untouched form is no change",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/config-draft.test.ts"],
        requires: ["tests/unit/web/config-draft.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D25.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "config-e2e",
        criteria: ["D25.3-AC1", "D25.3-AC2"],
        description:
          "Playwright on a fresh installation without SQL: the entry of F01 added from /registers, shown as Field.Config.norma_czytania with its value and 0 bindings, stored as text, changed with the symbol fixed and deleted, every change in the audit of the database with both values; a page that says no widget of this version reads the entries; a bad, taken symbol and an overlong value told at the field with no request; a save from a second tab is a conflict that keeps what was typed until the owner saves it or loads the stored version; the delete warns of the bindings; the Designer offers the register table nothing of ConfigTable; on a phone no sideways scroll; keyboard; axe; the registers, dictionaries and kreator as before",
        command: ["node", "tests/verification/e2e.ts", "config.spec", "registers", "dictionaries", "new-registry", "designer.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/config.spec.ts", "tests/e2e/registers.spec.ts", "tests/e2e/dictionaries.spec.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D25.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the module, its HTTP and its screen.
  {
    id: "D25",
    ready: true,
    title: "ConfigTable: entries of text, Field.Config and Field.System, the old and the new value only in the audit of the database",
    steps: ["D25.1", "D25.2", "D25.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D26.1",
    ready: true,
    title: "A change of the structure before it is made, in core: the rules of each kind of change, exact conversions between types, the report of a conversion, the blocks of a required column and the state of a plan",
    criteria: ["D26.1-AC1", "D26.1-AC2", "D26.1-regression"],
    checks: [
      {
        // Runs first: the tests read core from its build.
        id: "workspace-build",
        criteria: ["D26.1-AC1", "D26.1-AC2"],
        description: "pnpm -r build: the rules of a change of structure, the conversions and the days of the owner's zone in core/registries",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/core/src/modules/registries/domain/structure-change.ts", "packages/core/src/modules/registries/domain/convert.ts", "packages/core/src/modules/registries/domain/zoned-day.ts"],
      },
      {
        id: "structure-change-rules",
        criteria: ["D26.1-AC1", "D26.1-AC2"],
        description:
          "On Książki of F01: S9 \"12\" and \"abc\" as numbers are 12 and a failure in the report; every supported pair on a table of cases, exact or not at all (decimal places, grosze up to the safe integer, 2026-02-31, a date-time without a zone, the owner's midnight and day across both changes of the clock), the pairs without meaning refused; the report counts once and keeps the twenty most frequent failures first; each kind of change normalized and bound by a canonical text; an unknown kind or column, the last column, a taken or reserved symbol, a bad new column, the column limit, an unsupported pair, no change at all and a replacement of the wrong type refused with their paths; a required column that would lose values or keep empty cells blocked; a plan of another revision stale and after ten minutes expired; the columns of a new registry, the rules of records and Field.System as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/registries", "tests/unit/configuration"],
        requires: ["tests/unit/registries/structure-change.test.ts", "tests/unit/registries/registry-rules.test.ts", "tests/unit/configuration/config-rules.test.ts"],
      },
      ...regressionChecks("D26.1-regression"),
    ],
  },
  {
    id: "D26.2",
    ready: true,
    title: "The preview of a change of the structure over SQLite and HTTP: the report of the records, the widgets and the conversion, and a signed plan bound to the change, the owner and both revisions",
    criteria: ["D26.2-AC1", "D26.2-AC2", "D26.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and read core, the adapters and the signer from their builds.
        id: "workspace-build",
        criteria: ["D26.2-AC1", "D26.2-AC2"],
        description: "pnpm -r build: the use cases of the preview and the plan, the scan of a column, the dependent widgets, the signer of a plan and the route of the preview",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/core/src/modules/registries/application/structure-preview.ts",
          "packages/sqlite/src/adapters/registries/record-store.ts",
          "packages/sqlite/src/adapters/dashboard/catalog-reader.ts",
          "apps/server/src/adapters/structure-plan-signer.ts",
          "apps/server/src/http/routes/structure.routes.ts",
          "packages/contracts/src/http/registries.ts",
        ],
      },
      {
        id: "structure-preview-http",
        criteria: ["D26.2-AC1", "D26.2-AC2"],
        description:
          "Raw HTTP on the built server with Książki of F01 and its table widget: removing autor reports 25 records, the 22 with an author and the widget by its slot columns; strony to text converts 25; deleting the registry touches every record and every slot; a new required column without a default is blocked; S9 converts 12 and fails abc with its sample, required without a replacement is REQUIRED_VALUES_LOST without a plan, a replacement of the wrong type and a column of another registry are refused at their fields; nothing is written or audited; on the composition of the app the plan of the same change is current, a new record and a new schema revision make it PLAN_STALE, another change, another owner, a rewritten claim and a foreign token PLAN_INVALID, ten minutes later PLAN_EXPIRED; a foreign Origin and no session refused; a type change of 50 000 records measured; the inventory and every state before the gate on the new route (D13.1, D20.2); the records, the dashboard and the unit of work as before; the texts of the new codes",
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "tests/integration/registries",
          "tests/integration/dashboard",
          "tests/integration/sqlite/unit-of-work.test.ts",
          "tests/integration/auth/route-inventory.test.ts",
          "tests/integration/access/data-routes.test.ts",
          "tests/unit/web/error-message.test.ts",
        ],
        requires: ["tests/integration/registries/structure-preview-http.test.ts", "tests/integration/registries/record-store.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts", "tests/support/app-harness.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "check-locales",
        criteria: ["D26.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces, the texts of PLAN_INVALID, PLAN_EXPIRED and PLAN_STALE among them",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/errors.json", "apps/web/src/locales/en/errors.json"],
      },
      ...regressionChecks("D26.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the rules in core and the preview over SQLite and HTTP.
  {
    id: "D26",
    ready: true,
    title: "The preview of a change of the structure: the records and widgets it touches, the report of a conversion and a short-lived plan bound to the registry as it is",
    steps: ["D26.1", "D26.2"],
    criteria: [],
    checks: [],
  },
  {
    id: "D27.1",
    ready: true,
    title: "The PoC of the rebuild of a registry's table for a change of a column's type: eight stages in one unit of the writer, the plan checked again, a failure after each stage taken back",
    criteria: ["D27.1-AC1", "D27.1-AC2", "D27.1-regression"],
    checks: [
      {
        // Runs first: the tests read core, the adapters and the signer from their builds.
        id: "workspace-build",
        criteria: ["D27.1-AC1", "D27.1-AC2"],
        description: "pnpm -r build: the plan and the use case of a type change in core, the rebuild of a table and the change of a column in the SQLite adapters",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/core/src/modules/registries/domain/type-change.ts",
          "packages/core/src/modules/registries/application/type-change.ts",
          "packages/sqlite/src/adapters/registries/table-rebuild.ts",
          "packages/sqlite/src/adapters/registries/registry-store.ts",
          "packages/sqlite/src/adapters/registries/cell-encoding.ts",
        ],
      },
      {
        id: "table-rebuild",
        criteria: ["D27.1-AC1", "D27.1-AC2"],
        description:
          "On a real database file: Książki of F01 strony number to text keeps the 25 rows with their identifiers, owner, times and revisions, stores the text of each number, has the DDL and the indexes a new registry of the definition gets, schema revision 2, an audit without values, the bindings untouched and no table left of the rebuild; S9 text to number keeps 12, empties abc and counts it, and a required column takes the replacement; a failure after each of the eight stages, half-way through the copy and in a conversion leaves the schema, the catalog, the rows, the bindings and the audit exactly as they were, and the same plan then succeeds; a count of failures other than the report's is taken back; another change, another owner, an expired plan and a plan made stale by a record change nothing; 50 000 records of ten columns rebuilt five times with the time and the growth of the WAL measured; the records, the preview and the conversions as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries", "tests/unit/registries"],
        requires: ["tests/integration/registries/table-rebuild.test.ts", "tests/integration/registries/record-store.test.ts", "tests/integration/registries/structure-preview-http.test.ts", "tests/unit/registries/structure-change.test.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D27.1-regression"),
    ],
  },
  {
    id: "D27.2",
    ready: true,
    title: "The rebuild as an operation of the maintenance gate under the writer lease, and the reconciliation of a rebuild a crash left active",
    criteria: ["D27.2-AC1", "D27.2-AC2", "D27.2-regression"],
    checks: [
      {
        // Runs first: the tests start the built server and the CLI and read the gate and the executor from their builds.
        id: "workspace-build",
        criteria: ["D27.2-AC1", "D27.2-AC2"],
        description: "pnpm -r build: the rebuild variant of the gate, the executor of the operation, the reader of an interrupted rebuild and the reconciliation in the bootstrap",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/contracts/src/workers/maintenance-state.ts",
          "apps/server/src/workers/rebuild-operation.ts",
          "apps/server/src/bootstrap/database.ts",
          "packages/sqlite/src/adapters/registries/rebuild-outcome.ts",
        ],
      },
      {
        id: "rebuild-operation",
        criteria: ["D27.2-AC1", "D27.2-AC2"],
        description:
          "On a real installation with pomiary made through the API of the built server: the operation records rebuild in the gate while its unit runs and closes it one generation later, with 12 kept and abc empty; reset-password while the writer is held is INSTANCE_BUSY and the database is unchanged; a stale plan and a unit that fails close the operation with the catalog, the rows and the schema unchanged, and an unknown registry begins no operation; a start with a rebuild left active closes it at the revision it started from and one above and is ready; another revision, an unknown registry and a table of a rebuild left behind refuse the start with MAINTENANCE_RECOVERY_REQUIRED and change neither the gate nor the database; the bootstrap, the upgrade, the recovery and the gate as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance"],
        requires: ["tests/integration/maintenance/rebuild-operation.test.ts", "tests/integration/maintenance/database-bootstrap.test.ts", "tests/integration/maintenance/database-recovery.test.ts", "tests/integration/maintenance/maintenance-gate.test.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D27.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the rebuild in one unit and the operation of the gate around it.
  {
    id: "D27",
    ready: true,
    title: "The PoC of an atomic rebuild of a registry's table: eight stages in one unit of the writer, a failure after each taken back, one exclusivity with the gate and the CLI",
    steps: ["D27.1", "D27.2"],
    criteria: [],
    checks: [],
  },
  {
    id: "D28.1",
    ready: true,
    title: "Adding, renaming and removing a column and making it required, on a plan in one unit of the writer; the symbol of a removed column free again",
    criteria: ["D28.1-AC1", "D28.1-AC2", "D28.1-regression"],
    checks: [
      {
        // Runs first: the tests read core, the adapters, the migrations and the signer from their builds.
        id: "workspace-build",
        criteria: ["D28.1-AC1", "D28.1-AC2"],
        description: "pnpm -r build: migration 15, the use case of a column change, the DDL of a column and the column changes of the catalog",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/sqlite/src/migrations/0015-column-symbols.ts",
          "packages/core/src/modules/registries/application/column-change.ts",
          "packages/core/src/modules/registries/application/planned-change.ts",
          "packages/sqlite/src/adapters/registries/table-columns.ts",
          "packages/sqlite/src/adapters/registries/registry-store.ts",
        ],
      },
      {
        id: "column-change",
        criteria: ["D28.1-AC1", "D28.1-AC2"],
        description:
          "On a real database file with Książki of F01: a required ocena with the default 5 fills the 25 records, an optional date column gets its index and fills nothing; the indexed data_ukonczenia and autor leave the table with the index and stay removed in the catalog, and autor added again is a new column while the binding names the removed one; a new name touches the catalog only; autor made required fills its four empty cells, white space among them; every change raises the schema revision, audits without values and keeps the revisions and times of the records; a failure after each stage of each change leaves the schema, the catalog, the rows, the bindings and the audit as they were; a stale, foreign or expired plan writes nothing and a miscount is taken back; migration 15 keeps the catalog of version 14 and refuses two active columns of one symbol; the preview, the rebuild, the records, the migrations, the dashboard and the dictionaries as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries", "tests/unit/registries", "tests/integration/sqlite/migrations.test.ts", "tests/integration/dashboard", "tests/integration/dictionaries"],
        requires: ["tests/integration/registries/column-change.test.ts", "tests/integration/registries/table-rebuild.test.ts", "tests/integration/registries/structure-preview-http.test.ts", "tests/integration/sqlite/migrations.test.ts", "tests/unit/registries/structure-change.test.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D28.1-regression"),
    ],
  },
  {
    id: "D28.2",
    ready: true,
    title: "Carrying out a change of a column over HTTP on its plan, in an operation of the maintenance gate, with the session read again at the commit; S8",
    criteria: ["D28.2-AC1", "D28.2-AC2", "D28.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and compose the app from its build.
        id: "workspace-build",
        criteria: ["D28.2-AC1", "D28.2-AC2"],
        description: "pnpm -r build: the route that carries a change out, its contract, the operation of the gate around any change of the structure and the session read again in the writer's unit",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/structure.routes.ts", "apps/server/src/workers/rebuild-operation.ts", "packages/contracts/src/http/registries.ts", "packages/core/src/modules/registries/application/column-change.ts"],
      },
      {
        id: "structure-change-http",
        criteria: ["D28.2-AC1", "D28.2-AC2"],
        description:
          "Raw HTTP on the built server with Książki of F01 and its table widget: autor removed on the plan of its preview answers revision 2, uncached, the widget needs a binding and is ok once bound again (S8); a required ocena with the default 5 fills 25 records and autor added again is a new column; each change is one operation of the gate, closed after it, and audited; a plan made stale by a record is 409 PLAN_STALE with nothing written and the operation closed; a change of type and a deletion are 422; a foreign Origin and no session are refused; on the composition of the app a session that ends between the read of the route and the writer's unit writes nothing and the operation closes; the inventory and every state before the gate on the new route (D13.1, D20.2); the preview, the rebuild, the column changes, the records, the request authority and the gate as before",
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "tests/integration/registries",
          "tests/integration/auth/route-inventory.test.ts",
          "tests/integration/auth/request-authority.test.ts",
          "tests/integration/access/data-routes.test.ts",
          "tests/integration/maintenance/rebuild-operation.test.ts",
        ],
        requires: ["tests/integration/registries/structure-change-http.test.ts", "tests/support/books-http.ts", "tests/support/app-harness.ts", "tests/support/route-inventory.ts", "tests/integration/access/data-routes.test.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D28.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the column changes in core and SQLite and their route.
  {
    id: "D28",
    ready: true,
    title: "Adding, renaming and removing a column and making it required, on a plan, under the gate, with S8",
    steps: ["D28.1", "D28.2"],
    criteria: [],
    checks: [],
  },
  {
    id: "D29.1",
    ready: true,
    title: "The copy pre_type_change as the first phase of the operation of a change of type: no copy, no change, and its reconciliation",
    criteria: ["D29.1-AC1", "D29.1-AC2", "D29.1-regression"],
    checks: [
      {
        // Runs first: the tests hold the writer of a built installation and start the built server.
        id: "workspace-build",
        criteria: ["D29.1-AC1", "D29.1-AC2"],
        description: "pnpm -r build: the phases snapshot and rebuilding of the gate, the reason pre_type_change of a copy, the operation of a change of the structure with its copy and the reconciliation of the phase snapshot",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/workers/rebuild-operation.ts", "apps/server/src/bootstrap/database.ts", "packages/contracts/src/workers/maintenance-state.ts", "packages/core/src/modules/maintenance/ports.ts"],
      },
      {
        id: "type-change-snapshot",
        criteria: ["D29.1-AC1", "D29.1-AC2"],
        description:
          "On a real installation (lease, gate file, database, folder of copies) with pomiary made through the API: S9 text to number shows the phase snapshot and then rebuilding with the copy's ID; the published package verifies, has the reason pre_type_change and the operation's ID and holds 12 and abc as text at revision 1, while the registry has 12 and an empty cell; a copy that fails or lacks room starts no unit, publishes nothing and changes nothing; an active operation is MAINTENANCE; a record written after the copy makes the plan stale and stays; a start with the phase snapshot left active closes it at the revision it started from and discards the staging, one above refuses the start; the rebuild of D27.2, the snapshots of D05, the upgrade and the changes of a column over HTTP as before",
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "tests/integration/maintenance",
          "tests/integration/registries/structure-change-http.test.ts",
          "tests/integration/registries/table-rebuild.test.ts",
        ],
        requires: ["tests/integration/maintenance/type-change-snapshot.test.ts", "tests/integration/maintenance/rebuild-operation.test.ts", "tests/support/rebuild-writer.ts", "tests/support/app-harness.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D29.1-regression"),
    ],
  },
  {
    id: "D29.2",
    ready: true,
    title: "Carrying out a change of type over HTTP after its copy pre_type_change, with the session read again at the commit; S9",
    criteria: ["D29.2-AC1", "D29.2-AC2", "D29.2-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and compose the app from its build.
        id: "workspace-build",
        criteria: ["D29.2-AC1", "D29.2-AC2"],
        description: "pnpm -r build: changeType in the request of the route, the answer with failed and snapshotId, carryOutTypeChange, the codes MAINTENANCE, SNAPSHOT_LOW_SPACE and SNAPSHOT_FAILED and their texts",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/structure.routes.ts", "packages/contracts/src/http/registries.ts", "packages/contracts/src/http/errors.ts", "packages/core/src/modules/registries/application/type-change.ts", "apps/web/src/locales/pl/errors.json", "apps/web/src/locales/en/errors.json"],
      },
      {
        id: "type-change-http",
        criteria: ["D29.2-AC1", "D29.2-AC2"],
        description:
          "Raw HTTP on the built server: S9 previews 12 and abc and carries the change out with failed 1 as reported and the ID of a published copy pre_type_change, leaving 12 and an empty cell; a required column is blocked without a replacement and takes 0 with one; F01 strony number to text converts 25 records; a folder of copies that cannot stage is 503 SNAPSHOT_FAILED with nothing changed; a stale plan is 409; a foreign Origin and no session are refused; on the composition of the app an active operation is 503 MAINTENANCE and a session ended after the copy writes nothing; the inventory and every state before the gate on the route (D13.1, D20.2); the copy of D29.1, the rebuild, the column changes, the preview and the failure texts as before",
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "tests/integration/registries",
          "tests/integration/maintenance/type-change-snapshot.test.ts",
          "tests/integration/maintenance/rebuild-operation.test.ts",
          "tests/integration/auth/route-inventory.test.ts",
          "tests/integration/auth/request-authority.test.ts",
          "tests/integration/access/data-routes.test.ts",
          "tests/unit/web/error-message.test.ts",
        ],
        requires: ["tests/integration/registries/type-change-http.test.ts", "tests/integration/registries/structure-change-http.test.ts", "tests/support/rebuild-writer.ts", "tests/support/app-harness.ts", "tests/support/route-inventory.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      {
        id: "check-locales",
        criteria: ["D29.2-AC2"],
        description: "pnpm check:locales: the three new failure texts have the same keys in pl and en",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/errors.json", "apps/web/src/locales/en/errors.json"],
      },
      ...regressionChecks("D29.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the copy as a phase of the operation and the route.
  {
    id: "D29",
    ready: true,
    title: "A change of type with its copy pre_type_change, the plan checked again under the operation, the required column; S9",
    steps: ["D29.1", "D29.2"],
    criteria: [],
    checks: [],
  },
  {
    id: "D30.1",
    ready: true,
    title: "Deleting a registry over HTTP after its copy pre_delete, with the session read again at the commit; the tombstone and its reconciliation; S10",
    criteria: ["D30.1-AC1", "D30.1-AC2", "D30.1-regression"],
    checks: [
      {
        // Runs first: the integration tests start the built server and hold the writer of a built installation.
        id: "workspace-build",
        criteria: ["D30.1-AC1", "D30.1-AC2"],
        description: "pnpm -r build: deleteRegistry in the request of the route and a null column in its answer, the use case of a deletion, the drop of a table and the mark of the catalog, the reason pre_delete and the reconciliation of a committed deletion",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/core/src/modules/registries/application/delete-registry.ts",
          "packages/sqlite/src/adapters/registries/registry-tables.ts",
          "packages/sqlite/src/adapters/registries/registry-store.ts",
          "packages/sqlite/src/adapters/registries/rebuild-outcome.ts",
          "apps/server/src/http/routes/structure.routes.ts",
          "packages/contracts/src/http/registries.ts",
        ],
      },
      {
        id: "registry-deletion",
        criteria: ["D30.1-AC1", "D30.1-AC2"],
        description:
          "Raw HTTP on the built server with Książki of F01 and its table widget: the preview counts 25 records and the widget, the deletion answers revision 2, no column, 25 and a published copy pre_delete that still holds the 25 records; the table and its indexes are gone, the catalog marks the registry deleted and keeps its columns, the list, the records and the preview have it no more, the symbol stays taken, the widget needs a binding (S10), the audit has no values and the gate is closed; a folder of copies that cannot stage is 503 with nothing changed, a stale plan is 409, a foreign Origin and no session are refused, a session ended after the copy deletes nothing; on a real installation a failure after the drop or after the catalog takes all back, and a start after a committed deletion closes the operation while a registry deleted at the revision it started from refuses the start; the changes of a column and of type, the copies, the rebuild, the inventory and the request authority as before",
        command: [
          "pnpm",
          "exec",
          "vitest",
          "run",
          "tests/integration/registries",
          "tests/integration/maintenance",
          "tests/integration/auth/route-inventory.test.ts",
          "tests/integration/auth/request-authority.test.ts",
          "tests/integration/access/data-routes.test.ts",
          "tests/integration/dashboard",
          "tests/integration/dictionaries",
        ],
        requires: ["tests/integration/registries/registry-deletion-http.test.ts", "tests/integration/maintenance/registry-deletion-operation.test.ts", "tests/support/rebuild-writer.ts", "tests/support/app-harness.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D30.1-regression"),
    ],
  },
  {
    id: "D30.2",
    ready: true,
    title: "Restoring one deleted registry from its copy pre_delete with the command restore-registry, under the same identifiers",
    criteria: ["D30.2-AC1", "D30.2-AC2", "D30.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built command and the built server.
        id: "workspace-build",
        criteria: ["D30.2-AC1", "D30.2-AC2"],
        description: "pnpm -r build: the command restore-registry and its input, the use case of a restore, the read of a registry from a copy, the restore of a table and of the catalog",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/server/src/cli/restore-registry.ts",
          "packages/core/src/modules/registries/application/restore-registry.ts",
          "packages/sqlite/src/adapters/registries/registry-copy.ts",
          "packages/sqlite/src/adapters/registries/registry-tables.ts",
          "packages/contracts/src/backups/database-snapshot.ts",
          "README.md",
        ],
      },
      {
        id: "restore-registry",
        criteria: ["D30.2-AC1", "D30.2-AC2"],
        description:
          "On a real installation after S10 through the API: restore-registry brings Książki back with the same identifiers of the registry, its columns and its 25 records, their times and revisions, the table and indexes as created, revision 3, other registries, screens and sign-in data untouched, an audit without values; started again the server lists it, serves its records and the table widget is ok; a running server is INSTANCE_BUSY; a bad or unknown name, a damaged package, a consistent package of another installation or of another reason are refused; a registry not deleted or restored already, a symbol the copy lacks and a failure after the table or the catalog change nothing; the deletion, the copies, the commands and the gate as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/maintenance", "tests/integration/registries/registry-deletion-http.test.ts", "tests/integration/auth/create-owner.test.ts", "tests/integration/auth/reset-password.test.ts", "tests/integration/auth/reset-mfa.test.ts"],
        requires: ["tests/integration/maintenance/restore-registry.test.ts", "tests/support/rebuild-writer.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D30.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the deletion over HTTP and the restore from its copy.
  {
    id: "D30",
    ready: true,
    title: "Deleting a registry with its copy pre_delete, its tombstone and reserved symbol, and restoring it from the copy; S10",
    steps: ["D30.1", "D30.2"],
    criteria: [],
    checks: [],
  },
  {
    id: "D31.1",
    ready: true,
    title: "Manage columns in the browser (makieta 19): one change of a column at a time, its effects and \"I am aware\" before it is saved, and the deletion of the registry after the same warning (S8, S10)",
    criteria: ["D31.1-AC1", "D31.1-AC2", "D31.1-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA, the unit tests read core from its build.
        id: "workspace-build",
        criteria: ["D31.1-AC1", "D31.1-AC2"],
        description: "pnpm -r build: the SPA with /registers/:symbol/columns, the draft of the structure, the window of effects, and the position of a column added after a removed one in core",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/web/src/features/registers/pages/structure-page.tsx",
          "apps/web/src/features/registers/components/structure-effects-dialog.tsx",
          "apps/web/src/features/registers/lib/structure-draft.ts",
          "apps/web/src/features/registers/api/structure.ts",
          "apps/web/src/app/router/router.tsx",
          "packages/core/src/modules/registries/application/column-change.ts",
        ],
      },
      {
        id: "structure-draft-web",
        criteria: ["D31.1-AC1", "D31.1-AC2"],
        description:
          "The draft as pure functions: an untouched draft is no change, one edit makes every other control wait, its request is one core accepts, the value for empty cells and the default are converted as the window of a record converts them, a bad name, symbol, default and value are told at their field, and the issues of a refusal land at the field of the change",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/structure-draft.test.ts", "tests/unit/web/record-input.test.ts"],
        requires: ["tests/unit/web/structure-draft.test.ts", "tests/unit/web/record-input.test.ts"],
      },
      {
        id: "column-position",
        criteria: ["D31.1-AC1"],
        description: "A column added after two removed ones comes after the last active column and shares no position with another (found by the browser test of S8); the column changes of D28.1 as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/column-change.test.ts"],
        requires: ["tests/integration/registries/column-change.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D31.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "structure-e2e",
        criteria: ["D31.1-AC1", "D31.1-AC2"],
        description:
          "Playwright on a fresh installation with F01 and its register table: removing Autor shows 25 records, 22 affected and the widget with its slot before it is saved and the widget then needs its binding updated (S8); a rename, a required new column with its default and a column made required with a value for its empty cells are saved; deleting Książki after the warning and its copy leads to the list without it (S10); a second change waits, saving waits for I am aware, a bad symbol and default are told without a request, a reserved symbol comes back to its field, a required column without a value is blocked, a record added after the preview makes the plan stale and a new preview saves it; Escape and the focus, a phone without sideways scroll, axe; the kreator and the records as before",
        command: ["node", "tests/verification/e2e.ts", "structure.spec", "new-registry", "records.spec", "record-types"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/structure.spec.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/record-types.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D31.1-regression"),
    ],
  },
  {
    id: "D31.2",
    ready: true,
    title: "A change of a column's type in the browser (makieta 20): the report of the conversion, the copy pre_type_change and the three ways out of a required column (S9)",
    criteria: ["D31.2-AC1", "D31.2-AC2", "D31.2-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA, the unit tests read core from its build.
        id: "workspace-build",
        criteria: ["D31.2-AC1", "D31.2-AC2"],
        description: "pnpm -r build: the type of a column in the rows of Manage columns, the report of the conversion and its ways out in the window of effects",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/web/src/features/registers/components/conversion-report.tsx",
          "apps/web/src/features/registers/components/structure-effects-dialog.tsx",
          "apps/web/src/features/registers/components/new-registry-form.tsx",
          "apps/web/src/features/registers/lib/structure-draft.ts",
          "apps/web/src/features/registers/pages/structure-page.tsx",
        ],
      },
      {
        id: "type-change-draft-web",
        criteria: ["D31.2-AC1", "D31.2-AC2"],
        description:
          "The draft as pure functions: a change of type with its options is one edit core accepts and back to the stored type no change; a replacement of the new type is typed as in a record and a bad or empty one refused, making the column optional drops the replacement; the issues of the type land at the type",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/structure-draft.test.ts"],
        requires: ["tests/unit/web/structure-draft.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D31.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "structure-type-e2e",
        criteria: ["D31.2-AC1", "D31.2-AC2"],
        description:
          "Playwright on a fresh installation: S9 on an optional column, 12 and abc text to number, reports 1 converted and abc that cannot be converted, is saved after its copy pre_type_change and the records hold 12 and nothing; F01 strony number to text; a required column is blocked with nothing to save, correct the data opens the records searched for abc, a bad replacement is told at its field without a request, a good one and making the column optional are new previews that save; an unsupported pair is told at the type; a copy that cannot be made leaves the window with SNAPSHOT_FAILED and changes nothing; axe; Manage columns of D31.1, the kreator and the dictionaries as before",
        command: ["node", "tests/verification/e2e.ts", "structure-type", "structure.spec", "new-registry", "dictionaries"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/structure-type.spec.ts", "tests/e2e/structure.spec.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/dictionaries.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D31.2-regression"),
    ],
  },
  {
    id: "D31.3",
    ready: true,
    title: "A dictionary made from the row of a choice column, and the repair of a broken binding in the panel of the Designer (S8, S10)",
    criteria: ["D31.3-AC1", "D31.3-AC2", "D31.3-regression"],
    checks: [
      {
        // Runs first: the browser tests use the built server and SPA.
        id: "workspace-build",
        criteria: ["D31.3-AC1", "D31.3-AC2"],
        description: "pnpm -r build: the new dictionary in a window of Manage columns, and the missing paths in the panel of bindings",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/web/src/features/registers/components/new-dictionary-dialog.tsx",
          "apps/web/src/features/registers/pages/structure-page.tsx",
          "apps/web/src/features/dashboard/components/bindings-panel.tsx",
          "apps/web/src/features/dashboard/lib/register-table-bindings.ts",
        ],
      },
      {
        id: "missing-bindings-web",
        criteria: ["D31.3-AC1"],
        description: "The broken bindings as pure functions: a removed column named once whatever slots bind it, a deleted registry named by its path, nothing for a whole or an unbound widget, and a choice made again writes bindings without the missing one; the bindings of D18.2 as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/designer-state.test.ts"],
        requires: ["tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D31.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "structure-repair-e2e",
        criteria: ["D31.3-AC1", "D31.3-AC2"],
        description:
          "Playwright on a fresh installation: a dictionary made from the row of a new choice column is chosen at once, saved with the column and listed in /dictionaries, one made for Status is a change of its options; Escape, a bad and a taken symbol at the field keep the row; after S8 the panel shows missing Field.Register.ksiazki.autor, the columns chosen again save and the widget on /main is ok; after S10 the panel shows the missing registry and another one chosen brings the widget back; axe; the Designer, the screen and the dictionaries as before",
        command: ["node", "tests/verification/e2e.ts", "structure-repair", "designer.spec", "dashboard.spec", "dictionaries"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/structure-repair.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/dashboard.spec.ts", "tests/e2e/dictionaries.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D31.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the window of columns, the change of type, the dictionary and the repair.
  {
    id: "D31",
    ready: true,
    title: "The full screens of the structure and dictionaries: the effects before a change, the report of a conversion, a dictionary from the window of a column and the repair of bindings",
    steps: ["D31.1", "D31.2", "D31.3"],
    criteria: [],
    checks: [],
  },
  {
    id: "D32.1",
    ready: true,
    title: "The system preview over HTTP: six tables and their columns from a fixed list, the owner's rows in pages, read only, nothing of identity, settings or user tables",
    criteria: ["D32.1-AC1", "D32.1-AC2", "D32.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and read core from its build.
        id: "workspace-build",
        criteria: ["D32.1-AC1", "D32.1-AC2"],
        description: "pnpm -r build: the list of the preview and its use cases in core, the sources of the owning modules in SQLite, the routes and the composition of the server",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/core/src/modules/registries/domain/system-tables.ts",
          "packages/core/src/modules/registries/application/system-tables.ts",
          "packages/sqlite/src/adapters/system-table-source.ts",
          "packages/sqlite/src/adapters/registries/system-tables.ts",
          "packages/sqlite/src/adapters/dashboard/system-tables.ts",
          "packages/sqlite/src/adapters/audit/system-tables.ts",
          "packages/contracts/src/http/system-tables.ts",
          "apps/server/src/http/routes/system-tables.routes.ts",
          "apps/server/src/adapters/system-tables.ts",
        ],
      },
      {
        id: "system-tables-http",
        criteria: ["D32.1-AC1", "D32.1-AC2"],
        description:
          "On F01 with its table widget over real HTTP: the six tables with the columns of core and the owner's counts, the catalog without the owner or the physical table, the bindings with the paths of the widget, the audit newest first without address and browser, pages of 25 and 1 to 100, another owner's registry and screen not shown; identity, sessions, settings, idempotency, ConfigTable, a user table, SQL and inherited names 404; no answer holds a password hash, a session token, the secret of the second factor, a recovery code hash or a secret of the installation; a bad page 422; no other method writes; no session 401 and a password session 403",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/system-tables-http.test.ts"],
        requires: ["tests/integration/registries/system-tables-http.test.ts"],
      },
      {
        id: "route-inventory",
        criteria: ["D32.1-AC2"],
        description: "The two routes are in the inventory with the access data, every state before the gate is refused on them, the owner past it is answered and forged identifiers decide nothing (D13.1, D20.2)",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts"],
        requires: ["tests/support/route-inventory.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts"],
      },
      ...regressionChecks("D32.1-regression"),
    ],
  },
  {
    id: "D32.2",
    ready: true,
    title: "The cards of the registries with their records and widgets, and the section System with the tables of the preview in pages, read only, in the browser",
    criteria: ["D32.2-AC1", "D32.2-AC2", "D32.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D32.2-AC1", "D32.2-AC2"],
        description: "pnpm -r build: the summaries of the registries in core, SQLite and the server, the cards and the section System, the page of a table of the preview",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/core/src/modules/registries/application/registry-summaries.ts",
          "packages/sqlite/src/adapters/dashboard/catalog-reader.ts",
          "apps/server/src/http/routes/registries.routes.ts",
          "apps/web/src/features/registers/pages/registers-page.tsx",
          "apps/web/src/features/registers/pages/system-table-page.tsx",
          "apps/web/src/app/router/router.tsx",
        ],
      },
      {
        id: "registry-summaries-http",
        criteria: ["D32.2-AC1"],
        description: "Over real HTTP: Książki of F01 counts 25 records and 1 widget, a registry without them 0 and 0, a deleted registry is gone; the route in the inventory and the tables of the access tests",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/registries/registry-summaries-http.test.ts", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts"],
        requires: ["tests/integration/registries/registry-summaries-http.test.ts", "tests/support/route-inventory.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D32.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/registers.json", "apps/web/src/locales/en/registers.json"],
      },
      {
        id: "system-tables-e2e",
        criteria: ["D32.2-AC1", "D32.2-AC2"],
        description:
          "Playwright on a fresh installation with F01 and its widget: the card counts 25 records and 1 widget, System lists the six tables, the audit opens newest first in pages of 25 kept in the address and after a reload, the catalog shows Książki, no field and no button but the pages; an unknown table is said so with no request; a 320 px phone without sideways scroll; the region of the table takes the focus; axe; the list of registries, the kreator and the records as before",
        command: ["node", "tests/verification/e2e.ts", "system-tables", "registers.spec", "new-registry", "records.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/system-tables.spec.ts", "tests/e2e/registers.spec.ts", "tests/e2e/new-registry.spec.ts", "tests/e2e/records.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D32.2-regression"),
    ],
  },
  // The parent passes only through its work orders: the API of the preview and its screens.
  {
    id: "D32",
    ready: true,
    title: "The system preview: a fixed list of tables and columns, read only, in pages, and the cards of the registries with their records and widgets",
    steps: ["D32.1", "D32.2"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.30: the screen of the owner under `/`, Pulpity with Właściwości and the bar of the part of the application.
    id: "D33.1",
    ready: true,
    title: "The screen of the owner under / without a bar and with the one icon, /main leading there, Pulpity with Właściwości, the bar of the part of the application and the large-screen font",
    criteria: ["D33.1-AC1", "D33.1-AC2", "D33.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D33.1-AC1", "D33.1-AC2"],
        description: "pnpm -r build: the routes of / and /main, the screen, Pulpity, Właściwości, the bar and the font token",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/web/src/app/router/router.tsx",
          "apps/web/src/app/layout/app-bar.tsx",
          "apps/web/src/features/dashboard/pages/main-page.tsx",
          "apps/web/src/features/dashboard/pages/screens-page.tsx",
          "apps/web/src/features/dashboard/components/screen-properties-dialog.tsx",
          "packages/ui/src/tokens/dark-theme.json",
        ],
      },
      {
        id: "home-routes-web",
        criteria: ["D33.1-AC1", "D33.1-AC2"],
        description: "Unit: ready leads to /, every next action has its route; the name of Właściwości is refused empty and above 80 characters as the contract refuses it",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/error-message.test.ts", "tests/unit/web/screen-name.test.ts"],
        requires: ["tests/unit/web/error-message.test.ts", "tests/unit/web/screen-name.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D33.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/common.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "screens-e2e",
        criteria: ["D33.1-AC1", "D33.1-AC2"],
        description:
          "Playwright on a fresh installation with Książki and its widget: the sign-in leads to /, /main to / without an entry in the history, the icon is the one link of the screen and opens Pulpity; the row names the screen and its last change, Podgląd and Edycja open / and the Designer, Właściwości rename it on the list and in the Designer; 1920 px is the desktop in a 20 px font; a session on its way goes to its step; an empty and an 81-character name refused without a request, a refused save keeps the window; the bar on Pulpity and Rejestry, not on /; 390 px without sideways scroll, the keyboard, 44 px on the tablet; axe; the gate, the sign-in, the start screen, the setup, the screen and the Designer under the new address",
        command: ["node", "tests/verification/e2e.ts", "screens.spec", "gate.spec", "sign-in.spec", "status-screen", "setup.spec", "dashboard.spec", "designer.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/screens.spec.ts", "tests/e2e/gate.spec.ts", "tests/e2e/sign-in.spec.ts", "tests/e2e/status-screen.spec.ts", "tests/e2e/setup.spec.ts", "tests/e2e/dashboard.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D33.1-regression"),
    ],
  },
  {
    // DEV §9.30: one rule of collisions and the minimum for the mouse, the touch and the keyboard, the phone and the load of the Designer.
    id: "D33.2",
    ready: true,
    title: "The grid of the Designer: collisions that push down and the minimum of the manifest for the mouse, the touch and Alt + arrow, Escape, the layout switch by the arrows, the phone layout on a phone, the load and its failure",
    criteria: ["D33.2-AC1", "D33.2-AC2", "D33.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D33.2-AC1", "D33.2-AC2"],
        description: "pnpm -r build: the rules of the grid, the canvas, the editor and the page of the Designer",
        command: ["pnpm", "-r", "build"],
        requires: [
          "apps/web/src/features/dashboard/lib/layout-edit.ts",
          "apps/web/src/features/dashboard/lib/designer-state.ts",
          "apps/web/src/features/dashboard/components/design-canvas.tsx",
          "apps/web/src/features/dashboard/components/designer-editor.tsx",
          "apps/web/src/features/dashboard/pages/designer-page.tsx",
        ],
      },
      {
        id: "grid-rules-web",
        criteria: ["D33.2-AC1", "D33.2-AC2"],
        description: "Unit: a collision pushes the neighbour down in the desktop, the tablet and the phone, a chain in turn and no gap closed, never two overlapping; the minimum and the columns hold; Alt + arrow and Alt + Shift + arrow by one unit; one layout at a time; the reducer of the Designer",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/layout-collisions.test.ts", "tests/unit/web/layout-edit.test.ts", "tests/unit/web/designer-state.test.ts"],
        requires: ["tests/unit/web/layout-collisions.test.ts", "tests/unit/web/layout-edit.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D33.2-AC2"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "designer-grid-e2e",
        criteria: ["D33.2-AC1", "D33.2-AC2"],
        description:
          "Playwright with Książki and two register tables: the mouse on the desktop, a touch on the tablet and Alt + arrow push the neighbour down in that layout only, Alt + Shift + arrow stops at the minimum 3 × 4, a new widget has a place in all three layouts; past the columns nothing moves, Escape during a drag takes the widget back, the switch of the layout by the arrows keeps the selection, the handles are 44 px; a 390 px phone arranges the phone layout only without sideways scroll; a failed load shows the code, the reference, Try again and the way back; axe; the Designer, the restarts of the layouts and the vertical path as before",
        command: ["node", "tests/verification/e2e.ts", "designer-grid", "designer.spec", "vertical.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-grid.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/vertical.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D33.2-regression"),
    ],
  },
  {
    // DEV §9.30: S12 at the real widths of a phone, a tablet, a laptop and a large display, with touch.
    id: "D33.3",
    ready: true,
    title: "S12 in a browser at 390, 1024, 1440 and 1920 px with touch: a widget added on the desktop is on the phone and the tablet, a resize on the phone and a touch on the tablet keep the other layouts over a reload and a restart, the large display in 20 px",
    criteria: ["D33.3-AC1", "D33.3-AC2", "D33.3-regression"],
    checks: [
      {
        // Runs first: the test runs the built server and SPA.
        id: "workspace-build",
        criteria: ["D33.3-AC1", "D33.3-AC2"],
        description: "pnpm -r build: the Designer, the screen and Pulpity the scenario runs on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/components/designer-editor.tsx", "apps/web/src/features/dashboard/pages/main-page.tsx", "apps/web/src/features/dashboard/pages/screens-page.tsx"],
      },
      {
        id: "s12-e2e",
        criteria: ["D33.3-AC1", "D33.3-AC2"],
        description:
          "Playwright with touch: a widget added on the desktop layout of an empty screen at 1440 px is on the phone and the tablet; at 390 px the Designer arranges the phone only and a touch makes it taller without moving the desktop or the tablet; at 1024 px a touch resizes and moves it in the tablet layout; after a reload and a restart of the server the three layouts are the same on the server and on the screen at 390, 1024 and 1440 px; 1920 px is the desktop in a 20 px font and Pulpity keep 16 px; axe on the Designer, the screen and Pulpity",
        command: ["node", "tests/verification/e2e.ts", "layouts-s12"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/layouts-s12.spec.ts", "tests/e2e/owner-session.ts", "tests/support/auth-http.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D33.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the screen under /, the grid of the Designer and S12.
  {
    id: "D33",
    ready: true,
    title: "Three independent layouts with collisions and the minimum for the mouse, the touch and the keyboard, the screen under / and Pulpity",
    steps: ["D33.1", "D33.2", "D33.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.31: the context bar of the Designer in place of the palette and the side panel.
    id: "D34.1",
    ready: true,
    title: "The context bar of the Designer: the window Add widget, a new widget with Powiązania only, all the columns and a page of 10, the size by number, the title, the page size and Adding by the schema of the server, Duplicate and Delete",
    criteria: ["D34.1-AC1", "D34.1-AC2", "D34.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D34.1-AC1", "D34.1-AC2"],
        description: "pnpm -r build: the schema of the register table for the browser, the context bar, the window Add widget and the editor",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/widgets/src/views.ts",
          "apps/web/src/features/dashboard/components/context-bar.tsx",
          "apps/web/src/features/dashboard/components/add-widget-dialog.tsx",
          "apps/web/src/features/dashboard/components/bindings-panel.tsx",
          "apps/web/src/features/dashboard/components/designer-editor.tsx",
        ],
      },
      {
        id: "bar-rules-web",
        criteria: ["D34.1-AC1", "D34.1-AC2"],
        description: "Unit: Delete takes the widget and its selection, a copy keeps its size at the first free place of each layout, a chosen registry gives all its columns in its order, the bar accepts what the schema of the server accepts; the reducer and the grid as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/designer-bar.test.ts", "tests/unit/web/designer-state.test.ts", "tests/unit/web/layout-collisions.test.ts"],
        requires: ["tests/unit/web/designer-bar.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D34.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/widgets.json"],
      },
      {
        id: "designer-bar-e2e",
        criteria: ["D34.1-AC1", "D34.1-AC2"],
        description:
          "Playwright with Książki: the window Add widget lists the register table of the catalog with its description; the new widget is selected with the focus on Registry and only Powiązania usable; Książki gives its 9 columns and a page of 10, saved and on the screen; 6 × 5 changes the desktop only, 1 × 1 gives the minimum 3 × 4; the title, a page of 25 and Adding off are saved and shown; Duplicate makes a selected copy with a new id, the same bindings and (copy), Delete removes it; a page size of 0 and 101 is told at the field; another registry asks and Cancel keeps it; the order of Tab, Escape back to the tile, a selection that does not move the grid; axe; the Designer, the grid, S12, the repair of bindings, ConfigTable and the vertical paths as before",
        command: ["node", "tests/verification/e2e.ts", "designer-bar", "designer.spec", "designer-grid", "layouts-s12", "structure-repair", "config.spec", "vertical.spec", "g1-path"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-bar.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D34.1-regression"),
    ],
  },
  {
    // DEV §9.31: the columns of the register table in their order, All, the last kept, a broken binding removed, the refusals of the API.
    id: "D34.2",
    ready: true,
    title: "The columns of the register table: their order by Alt + arrow and the handle, All, the last kept, the sort, a broken binding removed in the bar, and the refusals of the API",
    criteria: ["D34.2-AC1", "D34.2-AC2", "D34.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D34.2-AC1", "D34.2-AC2"],
        description: "pnpm -r build: the bindings of the register table and the group Powiązania of the bar",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/lib/register-table-bindings.ts", "apps/web/src/features/dashboard/components/bindings-panel.tsx"],
      },
      {
        id: "column-order-web",
        criteria: ["D34.2-AC1", "D34.2-AC2"],
        description: "Unit: the bindings follow the order of the choice, the list puts the chosen columns first, Alt + arrow and a drop move one, All chooses every column then leaves one, Remove the binding keeps the rest; the bindings of D18.2 in the order of the choice",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/column-order.test.ts", "tests/unit/web/designer-state.test.ts"],
        requires: ["tests/unit/web/column-order.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "widget-bindings-http",
        criteria: ["D34.2-AC1", "D34.2-AC2"],
        description: "Over real HTTP on Książki of F01: columns saved as Status, Autor, Tytuł sorted by Tytuł come back and read in that order; an unknown slot, a kind the slot does not take, a registry of nobody and an unknown type are 422 at their paths with the screen as it was",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dashboard/widget-bindings-http.test.ts"],
        requires: ["tests/integration/dashboard/widget-bindings-http.test.ts", "tests/support/books-http.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D34.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "designer-columns-e2e",
        criteria: ["D34.2-AC1", "D34.2-AC2"],
        description:
          "Playwright with Książki and a table of Tytuł and Autor: Alt + ↓ and a drag of the handle order the columns, the save gives the ordinals and the screen the columns in that order; All chooses 11 of 11 then leaves 1; the sort by Tytuł ascending is the order on the screen; the last column cannot be let go; Escape closes the list on its field and keeps the widget selected; a removed Autor is shown by its path, the other groups stay usable, Remove the binding leaves Tytuł and the widget is ok; axe; the bar, the Designer and the repair of bindings as before",
        command: ["node", "tests/verification/e2e.ts", "designer-columns", "designer-bar", "designer.spec", "structure-repair"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-columns.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D34.2-regression"),
    ],
  },
  {
    // DEV §9.31: the bar as a sheet on a phone, the bar at three widths, a register table set up in the bar only.
    id: "D34.3",
    ready: true,
    title: "The context bar at 390, 1024 and 1440 px: a sheet from the bottom on a phone, above the grid on a tablet and a laptop, and a register table set up in the bar only on the screen",
    criteria: ["D34.3-AC1", "D34.3-AC2", "D34.3-regression"],
    checks: [
      {
        // Runs first: the test runs the built server and SPA.
        id: "workspace-build",
        criteria: ["D34.3-AC1", "D34.3-AC2"],
        description: "pnpm -r build: the context bar with its sheet and the editor",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/components/context-bar.tsx", "apps/web/src/features/dashboard/components/designer-editor.tsx", "apps/web/src/app/styles/global.css"],
      },
      {
        id: "check-locales",
        criteria: ["D34.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json"],
      },
      {
        id: "designer-bar-widths-e2e",
        criteria: ["D34.3-AC1", "D34.3-AC2"],
        description:
          "Playwright: at 390 px a selection opens the settings as a sheet at the bottom of the window with the groups, Done and Escape close it with the focus on the tile, no sideways scroll; at 1024 and 1440 px the bar ends above the grid; a register table set up only in the bar (Książki, Autor and Tytuł in that order, sorted by Tytuł ascending, a page of 2, Adding, the title) is that table on the screen with its pages and Add; axe; the bar and its columns as before",
        command: ["node", "tests/verification/e2e.ts", "designer-bar-widths", "designer-bar", "designer-columns"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-bar-widths.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D34.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the bar, its columns and the widths.
  {
    id: "D34",
    ready: true,
    title: "The context bar of the Designer with the options of the register table: bindings, columns in their order, size, appearance and behaviour, Duplicate and Delete, at the widths of a phone, a tablet and a laptop",
    steps: ["D34.1", "D34.2", "D34.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.32: the autosave of the Designer in place of the button Save.
    id: "D35.1",
    ready: true,
    title: "The autosave of the Designer: a second after the last change, one save in flight per tab with the newest design next, tries again after a growing wait, the four states of the saving, Finish that saves first",
    criteria: ["D35.1-AC1", "D35.1-AC2", "D35.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D35.1-AC1", "D35.1-AC2"],
        description: "pnpm -r build: the rules and the hook of the autosave and the editor without the button Save",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/lib/autosave.ts", "apps/web/src/features/dashboard/lib/use-autosave.ts", "apps/web/src/features/dashboard/components/designer-editor.tsx"],
      },
      {
        id: "autosave-rules-web",
        criteria: ["D35.1-AC1", "D35.1-AC2"],
        description: "Unit: a second of debounce; waits of 1, 2, 4, 8, 16 and 30 s with at most a fifth of jitter; no network offline, 5xx, 408 and 429 tried again, other 4xx refused, 401 and 403 to the guard; the reducer keeps edits made during a save",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/autosave.test.ts", "tests/unit/web/designer-state.test.ts"],
        requires: ["tests/unit/web/autosave.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D35.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json"],
      },
      {
        id: "designer-autosave-e2e",
        criteria: ["D35.1-AC1", "D35.1-AC2"],
        description:
          "Playwright with Książki and one table: a change shows Saving… then Saved and the time with no button, two changes within a second are one PUT with both, a change made while a PUT is held waits for it and goes with the next one and Saved never shows before the answer, Finish right after a change saves and leaves without asking; a 503 says it tries again and the next try saves, a 422 is told once and not tried in a loop; the D18.2 saves: a refusal told with its code and tried again by the owner, a lost connection saved when it is back, leaving without the network asks, closing the page with an unsaved design warns; axe; every test of the Designer that waits for its save",
        command: ["node", "tests/verification/e2e.ts", "designer-autosave", "designer.spec", "designer-bar", "designer-columns", "designer-grid", "layouts-s12", "vertical.spec", "g1-path", "structure-repair"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-autosave.spec.ts", "tests/e2e/designer.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D35.1-regression"),
    ],
  },
  {
    // DEV §9.32: undo and redo of the design and the bar of a deletion.
    id: "D35.2",
    ready: true,
    title: "Undo and redo of the Designer up to 100 steps by the buttons and Ctrl/⌘+Z, a typed field as one step, the bar Undo of a deletion for 10 s, the focus of a copy",
    criteria: ["D35.2-AC1", "D35.2-AC2", "D35.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D35.2-AC1", "D35.2-AC2"],
        description: "pnpm -r build: the history of the reducer, the buttons and keys of the editor and the bar of a deletion",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/lib/designer-state.ts", "apps/web/src/features/dashboard/components/designer-editor.tsx", "apps/web/src/features/dashboard/components/undo-bar.tsx"],
      },
      {
        id: "designer-history-web",
        criteria: ["D35.2-AC1", "D35.2-AC2"],
        description: "Unit: a change undone and redone, a deletion undone after the save is the same widget, a typed field is one step until it is left, a new step drops what was undone, the selection stays with its widget, 100 steps kept; the reducer of the Designer as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/designer-history.test.ts", "tests/unit/web/designer-state.test.ts", "tests/unit/web/designer-bar.test.ts"],
        requires: ["tests/unit/web/designer-history.test.ts", "tests/unit/web/designer-state.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D35.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json"],
      },
      {
        id: "designer-history-e2e",
        criteria: ["D35.2-AC1", "D35.2-AC2"],
        description:
          "Playwright with Książki and one table: inactive Undo and Redo at the start; a move by the keyboard and a title typed letter by letter are two steps undone by the buttons and redone by Ctrl/⌘+Shift+Z, each saved; a new widget undone by Ctrl/⌘+Z; a deletion saved, then undone by the bar that took the focus, is the same widget with its configuration and bindings on the server and after a restart, with the focus on its tile; Ctrl+Z in a field undoes its text only; Duplicate gives the focus to the copy; Escape closes the bar on the grid; the bar goes by itself after 10 s and the history still undoes the deletion; axe; the autosave and the Designer as before",
        command: ["node", "tests/verification/e2e.ts", "designer-history", "designer-autosave", "designer-bar", "designer.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-history.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D35.2-regression"),
    ],
  },
  {
    // DEV §9.32: a layout saved in another tab and a save whose answer was lost.
    id: "D35.3",
    ready: true,
    title: "Two tabs of one screen: a clean tab takes the layout saved elsewhere with a passing word, a tab with changes asks to load it or keep its own, and a save whose answer was lost is tried again without a second effect",
    criteria: ["D35.3-AC1", "D35.3-AC2", "D35.3-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D35.3-AC1", "D35.3-AC2"],
        description: "pnpm -r build: the rule of a change from elsewhere, the reducer and the editor that asks the server when the tab comes back",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/lib/designer-state.ts", "apps/web/src/features/dashboard/components/designer-editor.tsx"],
      },
      {
        id: "designer-elsewhere-web",
        criteria: ["D35.3-AC1", "D35.3-AC2"],
        description: "Unit: the server's design is another tab's only when it is neither the one last saved nor the one held here; taken, it is the new start with no history and nothing to save; the history as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/designer-history.test.ts"],
        requires: ["tests/unit/web/designer-history.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D35.3-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json"],
      },
      {
        id: "designer-tabs-e2e",
        criteria: ["D35.3-AC1", "D35.3-AC2"],
        description:
          "Playwright with two tabs of one owner: tab B, clean, takes the title tab A saved when it is in front again, with the passing word and nothing to save; with a change it cannot send it shows the bar, Load the newer layout gives A's title and nothing to save, Keep mine lets B's change save over A's; a save the server made whose answer was lost is sent once more, leaves one widget with the title, no alert, and is not a change from another device; axe; the autosave and the history as before",
        command: ["node", "tests/verification/e2e.ts", "designer-tabs", "designer-autosave", "designer-history"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-tabs.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D35.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the autosave, the history and two tabs.
  {
    id: "D35",
    ready: true,
    title: "The autosave of the Designer with its queue and retries, undo and redo with the bar of a deletion, and two tabs on one screen",
    steps: ["D35.1", "D35.2", "D35.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.33: the clock widget, its time and its ticker, on the screen.
    id: "D36.1",
    ready: true,
    title: "The clock widget: its manifest and configuration in the catalog, its time in its zone or the owner's by Intl, a ticker at the boundary of a second or a minute that resumes with the tab and leaves nothing, and the clocks of F01 on the screen",
    criteria: ["D36.1-AC1", "D36.1-AC2", "D36.1-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA and import the built definitions.
        id: "workspace-build",
        criteria: ["D36.1-AC1", "D36.1-AC2"],
        description: "pnpm -r build: the manifest, schema and view of the clock, its time and ticker in the web app, the screen, and the data of a widget that reads nothing",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/widgets/src/clock/manifest.ts",
          "packages/widgets/src/clock/config.schema.ts",
          "packages/widgets/src/clock/View.tsx",
          "apps/web/src/features/dashboard/lib/clock.ts",
          "apps/web/src/features/dashboard/lib/browser-ticker-host.ts",
          "apps/web/src/features/dashboard/components/clock-widget.tsx",
          "packages/core/src/modules/dashboard/application/screens.ts",
        ],
      },
      {
        id: "clock-rules",
        criteria: ["D36.1-AC1", "D36.1-AC2"],
        description: "Unit: the two moments of F02 in Warsaw and New York, 12 hours with AM/PM, the date in the owner's language, the owner's zone followed; the configuration of F01 with its defaults, an unknown zone and a caption over 40 refused; the ticker at the next second and minute, at once on resume, no timer and no listener after it stops; the catalog has the register table and the clock; the rules take the screen of F01 with its clocks",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/clock.test.ts", "tests/unit/dashboard/widget-definitions.test.ts", "tests/unit/dashboard/design-rules.test.ts"],
        requires: ["tests/unit/web/clock.test.ts", "tests/unit/dashboard/widget-definitions.test.ts", "tests/unit/dashboard/design-rules.test.ts"],
      },
      {
        id: "clock-http",
        criteria: ["D36.1-AC1", "D36.1-AC2"],
        description: "Over real HTTP: the screen of F01 with its table and two clocks saved and read back, the clocks ok without bindings and with empty data in their own state; an unknown zone, a caption over 40 and an unknown format are 422 at the configuration with the screen as it was; the catalog of types and the refusals of D17.4 with the clock",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/dashboard/clock-http.test.ts", "tests/integration/dashboard/dashboard-http.test.ts"],
        requires: ["tests/integration/dashboard/clock-http.test.ts", "tests/integration/dashboard/dashboard-http.test.ts", "tests/support/books-http.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D36.1-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/widgets.json"],
      },
      {
        id: "clock-e2e",
        criteria: ["D36.1-AC1", "D36.1-AC2"],
        description:
          "Playwright with the clock of the page at the first moment of F02: Dom shows 01:30 in the owner's Europe/Warsaw and Nowy Jork 20:30 with seconds in its zone, each with its date, caption and datetime; a minute later 01:31 and 20:31; axe; the screen and the bar of the Designer as before",
        command: ["node", "tests/verification/e2e.ts", "clock.spec", "dashboard.spec", "designer-bar"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/clock.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D36.1-regression"),
    ],
  },
  {
    // DEV §9.33: the clock in the window Add widget and in its bar.
    id: "D36.2",
    ready: true,
    title: "The clock in the Designer: in the window Add widget with its description and defaults, its bar in one row with the zone found among the IANA names and the owner's first, the format, the caption, the seconds and the date, and its copy",
    criteria: ["D36.2-AC1", "D36.2-AC2", "D36.2-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D36.2-AC1", "D36.2-AC2"],
        description: "pnpm -r build: the groups of the bar of a clock, the bar, the tiles and the editor",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/components/clock-groups.tsx", "apps/web/src/features/dashboard/components/context-bar.tsx", "apps/web/src/features/dashboard/components/design-canvas.tsx", "apps/web/src/features/dashboard/components/designer-editor.tsx"],
      },
      {
        id: "check-locales",
        criteria: ["D36.2-AC1"],
        description: "pl and en have the same keys, plural forms and variables in all namespaces",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json"],
      },
      {
        id: "designer-clock-e2e",
        criteria: ["D36.2-AC1", "D36.2-AC2"],
        description:
          "Playwright: the clock from the window Add widget with its description, its defaults and a place of 4 × 3 in the three layouts, a bar without bindings; Europe/London, 12 h, Londyn, seconds and no date saved and on the screen as such; its copy saved with (copy) in its caption; an unknown zone told at the field and out of the design, the owner's zone first of the list; undo takes the format back; Escape back on the tile; axe; the bar of the register table and the history as before",
        command: ["node", "tests/verification/e2e.ts", "designer-clock", "designer-bar", "designer-history"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-clock.spec.ts", "tests/e2e/designer-bar.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D36.2-regression"),
    ],
  },
  {
    // DEV §9.33: S13 and what a clock leaves behind.
    id: "D36.3",
    ready: true,
    title: "S13: the clocks at the two moments of F02, the zone of the owner moving only the clock of the owner, a tab that comes back, and clocks removed that leave no timer and no listener",
    criteria: ["D36.3-AC1", "D36.3-AC2", "D36.3-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D36.3-AC1", "D36.3-AC2"],
        description: "pnpm -r build: the clock, its ticker and the Designer the tests run in",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/lib/clock.ts", "apps/web/src/features/dashboard/components/clock-widget.tsx"],
      },
      {
        id: "clock-s13-e2e",
        criteria: ["D36.3-AC1", "D36.3-AC2"],
        description:
          "Playwright with the clock of the page at each moment of F02: Dom 01:30 and Nowy Jork 20:30, then 03:30 and 21:30; the zone of the owner changed to Tokyo moves Dom to 09:30 and leaves Nowy Jork; a tab that comes back (focus, visibility) shows the current time at once; both clocks deleted in the Designer leave two listeners fewer and no tick on a whole second; axe",
        command: ["node", "tests/verification/e2e.ts", "clock-s13.spec", "clock.spec", "designer-clock"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/clock-s13.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D36.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the clock, its bar and S13.
  {
    id: "D36",
    ready: true,
    title: "The clock widget: its configuration and time, its place in the Designer, and S13 with nothing left behind",
    steps: ["D36.1", "D36.2", "D36.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.34: the live stream on the server.
    id: "D37.1",
    ready: true,
    title: "The live stream on the server: GET /api/v1/stream behind the gate, ready, ping and published events, five per session, ended with the session or the server",
    criteria: ["D37.1-AC1", "D37.1-AC2", "D37.1-regression"],
    checks: [
      {
        // Runs first: the tests import the built contracts and server and run the built server.
        id: "workspace-build",
        criteria: ["D37.1-AC1", "D37.1-AC2"],
        description: "pnpm -r build: the contract of the stream, the gate of the stream in core, the hub, the route and the composition of the server",
        command: ["pnpm", "-r", "build"],
        requires: [
          "packages/contracts/src/http/stream.ts",
          "packages/core/src/modules/identity/application/live-stream-access.ts",
          "apps/server/src/adapters/events/live-hub.ts",
          "apps/server/src/adapters/events/limits.ts",
          "apps/server/src/http/routes/stream.routes.ts",
        ],
      },
      {
        id: "live-hub",
        criteria: ["D37.1-AC1", "D37.1-AC2"],
        description: "Unit: every event of the architecture written as the wire carries it and read back, a foreign name, bad JSON and a missing or extra field refused; the hub counts streams per session, refuses past the limit, frees a closed place, drops a stream that cannot be written to without stopping the rest, and ends a token or all",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/events/live-hub.test.ts"],
        requires: ["tests/unit/events/live-hub.test.ts"],
      },
      {
        id: "stream-http",
        criteria: ["D37.1-AC1", "D37.1-AC2"],
        description:
          "HTTP: the headers of the stream, ready first, a published event, ping on the interval; none, password only and data not chosen refused with their codes; the sixth stream 429 with Retry-After and a closed one frees its place; sign-out ends the streams; a vanished session ends its stream at the next ping; a client that does not read is ended; on the built server the stream ends with sign-out and a stopping server ends it and exits 0",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/stream/stream-http.test.ts"],
        requires: ["tests/integration/stream/stream-http.test.ts", "tests/support/app-harness.ts"],
      },
      {
        id: "stream-access",
        criteria: ["D37.1-AC1"],
        description: "The stream is a route of the data access in the inventory: refused in every state before the gate and answered 200 to the owner past it (D20.2); the other routes and the inventory as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/access/data-routes.test.ts", "tests/integration/http/server.test.ts", "tests/integration/auth/route-inventory.test.ts"],
        requires: ["tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts"],
      },
      {
        id: "lifecycle",
        criteria: ["D37.1-AC2"],
        description: "The stop of the server as before with the streams ended first: the five steps of the shutdown in order, a request in progress finished, the lease released last",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/lifecycle/shutdown.test.ts"],
        requires: ["tests/integration/lifecycle/shutdown.test.ts"],
      },
      ...regressionChecks("D37.1-regression"),
    ],
  },
  {
    // DEV §9.34: the live stream in the browser.
    id: "D37.2",
    ready: true,
    title: "The live stream in the browser: one stream per tab with its states, lost and found again, a tab that comes back connects at once, the end of the session closes it",
    criteria: ["D37.2-AC1", "D37.2-AC2", "D37.2-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D37.2-AC1", "D37.2-AC2"],
        description: "pnpm -r build: the contract with the ping interval, the manager of the stream and its bridge in the SPA",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/contracts/src/http/stream.ts", "apps/web/src/lib/live/live-stream.ts", "apps/web/src/app/router/live-stream-bridge.tsx"],
      },
      {
        id: "live-stream-unit",
        criteria: ["D37.2-AC1", "D37.2-AC2"],
        description:
          "Unit with a fake host and clock: connecting, live at ready and no refresh for a first connection; offline at once, the waits growing and starting again, the data read again once after the return; silence taken for a loss after two pings and the slack; a tab that comes back connects at once and one quiet longer than a ping connects again; the late word of a replaced connection ignored; a session the server no longer holds ends the stream for good; nothing left after stop and after forty cycles",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/live-stream.test.ts"],
        requires: ["tests/unit/web/live-stream.test.ts"],
      },
      {
        id: "live-stream-e2e",
        criteria: ["D37.2-AC1", "D37.2-AC2"],
        description:
          "Playwright on the built app: one stream after sign-in and through the moves between private screens; the server stops and returns (offline, live again, the list of screens read again, one stream open); focus, online and the visibility of the page connect at once after failed attempts; sign-out and a session ended elsewhere close the stream and it does not come back",
        command: ["node", "tests/verification/e2e.ts", "live-stream.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/live-stream.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D37.2-regression"),
    ],
  },
  {
    // DEV §9.34: the live stream behind Caddy. AC2 (the phone) is a manual protocol with the owner's result
    // and is reported not_run in DEV until there is one; it is not a check of this map.
    id: "D37.3",
    ready: true,
    title: "The live stream behind Caddy with a local certificate: ready and ping in time, compression harmless, the sixth stream 429, sign-out ends the streams",
    criteria: ["D37.3-AC1", "D37.3-regression"],
    checks: [
      {
        // Runs first: the check makes the owner with the built CLI and builds the image from the sources.
        id: "workspace-build",
        criteria: ["D37.3-AC1"],
        description: "pnpm -r build: the CLI that makes the owner and the contracts the check reads the stream with",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/cli/create-owner.ts", "packages/contracts/src/http/stream.ts"],
      },
      {
        id: "stream-behind-caddy",
        criteria: ["D37.3-AC1"],
        description:
          "Real Docker: the app image on a network of its own with no published port, Caddy 2.10.2 (pinned by digest) with tls internal, compression and flush_interval -1 as the only way in; through HTTPS with the root certificate of that Caddy the owner signs in and opens five streams: text/event-stream, no-store, ready at once, ping on the 25 s interval and apart from ready, the sixth stream 429 with Retry-After, sign-out ends all five within 5 s and the old cookie opens nothing; the session cookie is Secure and HttpOnly. Blocked without Docker on this architecture",
        command: ["node", "tests/system/stream-behind-caddy.ts"],
        requires: ["tests/system/stream-behind-caddy.ts", "tests/support/tls-http.ts", "docker/Dockerfile"],
        timeoutMs: 20 * 60 * 1000,
      },
      ...regressionChecks("D37.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the stream on the server, in the browser and behind Caddy.
  {
    id: "D37",
    ready: true,
    title: "PoC of the live stream: the server, the tab and Caddy with HTTPS (the phone is a manual protocol)",
    steps: ["D37.1", "D37.2", "D37.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.35: the events of committed changes, from the routes to the open streams.
    id: "D38.1",
    ready: true,
    title: "Events after the commit: every route that writes tells the open streams what changed, and none when it refused or wrote nothing",
    criteria: ["D38.1-AC1", "D38.1-AC2", "D38.1-regression"],
    checks: [
      {
        // Runs first: the tests import the built contracts and server.
        id: "workspace-build",
        criteria: ["D38.1-AC1", "D38.1-AC2"],
        description: "pnpm -r build: the announcement in the routes of records, registries, structure, dictionaries, ConfigTable and screens, and in the composition of the server",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/adapters/events/live-hub.ts", "apps/server/src/bootstrap/create-app.ts", "apps/server/src/http/routes/records.routes.ts"],
      },
      {
        id: "live-events",
        criteria: ["D38.1-AC1", "D38.1-AC2"],
        description:
          "HTTP: a registry, a record (add, change, delete), a column, an entry of ConfigTable and a screen (create, design) each send one event with the field that names them; a dictionary sends one per registry that uses it and none when nothing does; a refusal, a stale revision, a repeated add and a foreign Origin send nothing; the event comes after the commit; a stream that cannot be written to does not stop the others and an announcement that throws does not change the answer",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/stream/live-events.test.ts"],
        requires: ["tests/integration/stream/live-events.test.ts", "tests/support/harness-owner.ts"],
      },
      {
        id: "stream-http",
        criteria: ["D38.1-AC2"],
        description: "The stream as before (the harness now announces too): headers, ready, a published event, ping, the limit of five, sign-out and the stop of the server",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/stream/stream-http.test.ts"],
        requires: ["tests/integration/stream/stream-http.test.ts", "tests/support/app-harness.ts"],
      },
      ...regressionChecks("D38.1-regression"),
    ],
  },
  {
    // DEV §9.35: the tab reads again what the events concern, and says when the stream is lost.
    id: "D38.2",
    ready: true,
    title: "Live events in the browser: precise invalidation of the cached data, a record of another tab in under a second, the message of a lost connection",
    criteria: ["D38.2-AC1", "D38.2-AC2", "D38.2-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D38.2-AC1", "D38.2-AC2"],
        description: "pnpm -r build: the table of events and keys, the handing on of changes by the manager and the message of the bridge in the SPA",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/lib/live/event-keys.ts", "apps/web/src/lib/live/live-stream.ts", "apps/web/src/app/router/live-stream-bridge.tsx"],
      },
      {
        id: "live-event-keys-unit",
        criteria: ["D38.2-AC1"],
        description: "Unit: each event names the keys of its table and no others (another registry never), the events without a table none; the manager hands changes on in order and none after it stops",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/live-event-keys.test.ts", "tests/unit/web/live-stream.test.ts"],
        requires: ["tests/unit/web/live-event-keys.test.ts", "tests/unit/web/live-stream.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D38.2-AC2"],
        description: "pl and en have the same keys, including the message of the lost connection",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/common.json", "apps/web/src/locales/en/common.json"],
      },
      {
        id: "live-events-e2e",
        criteria: ["D38.2-AC1", "D38.2-AC2"],
        description:
          "Playwright on the built app: a record added in one tab is in the table of another within a second without a reload; with the stream cut and the server restarted the message appears, and after the return it is gone and the record written meanwhile is shown",
        command: ["node", "tests/verification/e2e.ts", "live-events.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/live-events.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D38.2-regression"),
    ],
  },
  {
    // DEV §9.35: the Designer on the live stream (S11 on two tabs).
    id: "D38.3",
    ready: true,
    title: "The Designer on the live stream: the layout of another tab at once, the news held during a drag, a lost event found by the reconnect, no loop on the own save",
    criteria: ["D38.3-AC1", "D38.3-AC2", "D38.3-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D38.3-AC1", "D38.3-AC2"],
        description: "pnpm -r build: the Designer that reads its screen through the query the stream keeps current, and the canvas that tells when a drag begins and ends",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/components/designer-editor.tsx", "apps/web/src/features/dashboard/components/design-canvas.tsx"],
      },
      {
        id: "designer-live-e2e",
        criteria: ["D38.3-AC1", "D38.3-AC2"],
        description:
          "Playwright on the built app, two tabs: a layout saved in A is in B within a second with the passing word and no return of the tab; the news that comes while B holds a widget in a drag waits for the drop, B then asks about it and its own change still saves; the news lost with the stream (server restarted, B cut off) is found by the reconnect; the save of a tab brings a few reads that settle, not a loop",
        command: ["node", "tests/verification/e2e.ts", "designer-live.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-live.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        id: "designer-tabs-e2e",
        criteria: ["D38.3-AC1"],
        description: "Playwright: the two tabs of D35.3 as before, now on the news of the stream (a clean tab takes the layout, one with changes asks, news during a try of its own is asked about after it, a lost answer is not a change of another device)",
        command: ["node", "tests/verification/e2e.ts", "designer-tabs.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-tabs.spec.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D38.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the events from the routes, the tab, and the Designer.
  {
    id: "D38",
    ready: true,
    title: "Live events in the application: committed changes announced, the tab reads what they concern, the Designer follows another tab",
    steps: ["D38.1", "D38.2", "D38.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.36: the look of the open screen and the word of a layout from another device.
    id: "D39.1",
    ready: true,
    title: "The accent of the screen on the dashboard and in the Designer, and the word that the layout came from another device on the dashboard",
    criteria: ["D39.1-AC1", "D39.1-AC2", "D39.1-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D39.1-AC1", "D39.1-AC2"],
        description: "pnpm -r build: the accent applied by the screens, the shared time and test of the passing word, the dashboard that shows it",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/ui/src/tokens/theme.ts", "apps/web/src/lib/theme/screen-accent.ts", "apps/web/src/features/dashboard/lib/refreshed-notice.ts", "apps/web/src/features/dashboard/pages/main-page.tsx"],
      },
      {
        id: "screen-accent-unit",
        criteria: ["D39.1-AC1", "D39.1-AC2"],
        description: "Unit: each accent of the theme goes onto the element and the default comes back; a layout saved later with another place, title, name or accent is a change of another device, the same layout again, an older screen and a change of only the state of a widget are not",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/screen-accent.test.ts"],
        requires: ["tests/unit/web/screen-accent.test.ts"],
      },
      {
        id: "dashboard-live-e2e",
        criteria: ["D39.1-AC1", "D39.1-AC2"],
        description:
          "Playwright on the built app: a screen with the accent green has it on the dashboard and in the Designer and the default in the part of the application; the dashboard tells within a second a layout another tab saved, with no question and no focus, and says nothing at the first reading, for the same layout saved again or without a stream",
        command: ["node", "tests/verification/e2e.ts", "dashboard-live.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/dashboard-live.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D39.1-regression"),
    ],
  },
  {
    // DEV §9.36: the states of a widget on the dashboard and in the Designer.
    id: "D39.2",
    ready: true,
    title: "The states of a widget: a refresh and a broken binding told apart, a failed read with its code and reference, the Designer marks the old widget and keeps its configuration",
    criteria: ["D39.2-AC1", "D39.2-AC2", "D39.2-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D39.2-AC1", "D39.2-AC2"],
        description: "pnpm -r build: the view of the register table with the detail of a failure, the clock with its link, the tile of the Designer with the state of its widget",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/widgets/src/register-table/View.tsx", "apps/web/src/features/dashboard/components/clock-widget.tsx", "apps/web/src/features/dashboard/components/design-canvas.tsx", "apps/web/src/lib/failures/failure-alert.tsx"],
      },
      {
        id: "check-locales",
        criteria: ["D39.2-AC1", "D39.2-AC2"],
        description: "pl and en have the same keys, including the states of the tile and the link to the Designer",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/designer.json"],
      },
      {
        id: "widget-states-e2e",
        criteria: ["D39.2-AC1", "D39.2-AC2"],
        description:
          "Playwright on the built app: the working table draws beside an old table and an old clock that say they need a refresh and offer the Designer; a broken binding differs from a refresh in colour and sign; a failed read gives the code and the reference and the other widgets go on; the Designer marks the old tile, and a move of another widget saves the screen with the old configuration unchanged",
        command: ["node", "tests/verification/e2e.ts", "widget-states.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/widget-states.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        id: "dashboard-e2e",
        criteria: ["D39.2-AC1"],
        description: "Playwright: the screen of D33.1 as before, with the failed read now showing its code",
        command: ["node", "tests/verification/e2e.ts", "dashboard.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/dashboard.spec.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D39.2-regression"),
    ],
  },
  {
    // DEV §9.36: the preview of the Designer.
    id: "D39.3",
    ready: true,
    title: "The preview of the Designer: the screen as the owner will see it on real data, sample data only for an unbound widget, nothing saved",
    criteria: ["D39.3-AC1", "D39.3-AC2", "D39.3-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D39.3-AC1", "D39.3-AC2"],
        description: "pnpm -r build: the grid of widgets shared by the dashboard and the preview, the sample of the register table, the preview in the Designer",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/dashboard/components/screen-grid.tsx", "apps/web/src/features/dashboard/components/designer-editor.tsx", "packages/widgets/src/register-table/View.tsx"],
      },
      {
        id: "preview-widgets-unit",
        criteria: ["D39.3-AC1", "D39.3-AC2"],
        description: "Unit: the preview draws the design being arranged with the states the server worked out, and a widget it has not seen yet is a draft",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/web/preview-widgets.test.ts"],
        requires: ["tests/unit/web/preview-widgets.test.ts"],
      },
      {
        id: "check-locales",
        criteria: ["D39.3-AC2"],
        description: "pl and en have the same keys, including the preview and the sample data",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/designer.json", "apps/web/src/locales/en/widgets.json"],
      },
      {
        id: "designer-preview-e2e",
        criteria: ["D39.3-AC1", "D39.3-AC2"],
        description:
          "Playwright on the built app: the preview hides the grid, the handles and the bar; the table adds a record and the layout can be switched, with nothing sent to the server; the unbound table shows marked sample data in the preview and asks to be configured on the dashboard, the bound one never a sample; axe; leaving by the button and by Escape gives back the grid with the same widget selected and the focus on Preview",
        command: ["node", "tests/verification/e2e.ts", "designer-preview.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/designer-preview.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      {
        id: "dashboard-e2e",
        criteria: ["D39.3-AC1"],
        description: "Playwright: the screen of D33.1 as before, now drawn by the grid it shares with the preview",
        command: ["node", "tests/verification/e2e.ts", "dashboard.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/dashboard.spec.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D39.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the accent and the word of the dashboard, the states, the preview.
  {
    id: "D39",
    ready: true,
    title: "The look, the states and the preview of widgets on the screen",
    steps: ["D39.1", "D39.2", "D39.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.37: a screen with ten widgets.
    id: "D40.1",
    ready: true,
    title: "A screen with ten widgets: the dashboard on a laptop and a phone, the Designer and the preview, the reads of the data and the budget of time",
    criteria: ["D40.1-AC1", "D40.1-AC2", "D40.1-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D40.1-AC1", "D40.1-AC2"],
        description: "pnpm -r build: the server and the SPA the screen of ten widgets runs on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "ten-widgets-e2e",
        criteria: ["D40.1-AC1", "D40.1-AC2"],
        description:
          "Playwright on the built app: six working tables, two clocks, a draft and a table of an old configuration; the dashboard draws all ten on a laptop within the budget of 2 s (warm, local, the time goes to the report) with one read of data per working table and none for the others, and in one column on a phone without sideways scrolling; the Designer selects and moves a widget and saves, the phone layout and the preview show all ten; axe on each. The profile of 50 000 records and the p95 of 100 writes are not run",
        command: ["node", "tests/verification/e2e.ts", "ten-widgets.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/ten-widgets.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D40.1-regression"),
    ],
  },
  {
    // KM2 gate (DEV §8.4, §9.29): the whole of F01 on one installation in a browser, then the reports of
    // the fast tier for D22–D31 joined item by item for this exact code; does not run their tests again.
    id: "G2",
    ready: true,
    title: "Gate G2: the full registry F01, its dictionary and ConfigTable, and the editing of the structure",
    criteria: ["G2-path", "G2-matrix", "G2-reports"],
    checks: [
      {
        // Runs first: the path test uses the built server and SPA.
        id: "workspace-build",
        criteria: ["G2-path"],
        description: "pnpm -r build: the server and the SPA the path of F01 runs on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "g2-path-e2e",
        criteria: ["G2-path"],
        description:
          "Playwright on a fresh installation: F01 whole through the routes of the product (the dictionary with its hidden status, Książki with every type and 25 records, five with a status outside the dictionary, ConfigTable and the table widget); 1037 shows 10.37, the hidden status its label and the unknown one its symbol in the table and the widget, the entry is the text 20; a change whose copy cannot be made keeps every record; Autor removed after its effects leaves the widget needing its binding",
        command: ["node", "tests/verification/e2e.ts", "g2-path"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/g2-path.spec.ts", "tests/fixtures/books/books-v1.export.json", "tests/e2e/owner-session.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        id: "g2-matrix-static",
        criteria: ["G2-matrix"],
        description: "Every item of G2 names ready reports, checks of those tasks and test titles written as they stand in the sources the checks run; every report joined proves an item",
        command: ["node", "tests/verification/g2-matrix-static.ts"],
        requires: ["tests/verification/g2-matrix-static.ts", "tests/verification/g2-matrix.ts"],
      },
      {
        id: "g2-gate-controls",
        criteria: ["G2-matrix"],
        description: "The G2 gate on synthetic reports: a complete set passes; a failed or renamed test line and a failed check fail; a missing report and a report of other code are blocked; the result always lists every item",
        command: ["node", "tests/verification/g2-gate-controls.ts"],
        requires: ["tests/verification/g2-gate-controls.ts", "tests/verification/gate-controls.ts", "tests/verification/g2-gate.ts", "tests/verification/gate-run.ts", "tests/verification/g2-matrix.ts"],
      },
      {
        id: "g2-gate",
        criteria: ["G2-reports"],
        description:
          "Joins the reports of D22.1, D22.3, D24.2, D24.3, D25.2, D25.3, D27.1, D28.1, D28.2, D29.2, D30.1, D31.1, D31.2 and D31.3 for exactly this code and decides every item of G2 from the passed test that proves it: an exact amount, the labels of the dictionary, ConfigTable as text, autor removed breaking the binding, a DDL that fails taken back, the report of a change of type; names what is not run. A missing report is blocked",
        command: ["node", "tests/verification/g2-gate.ts"],
        requires: ["tests/verification/g2-gate.ts", "tests/verification/g2-matrix.ts", "tests/verification/gate-run.ts", "tests/verification/report-join.ts"],
      },
    ],
  },
  {
    // DEV §9.38: the catalog of the application options and the resolver for each type.
    id: "D41.1",
    ready: true,
    title: "The catalog of the application options: the types, the rest of the options of the architecture, and the resolver for each type",
    criteria: ["D41.1-AC1", "D41.1-AC2", "D41.1-regression"],
    checks: [
      {
        // Runs first: the tests import the built contracts.
        id: "workspace-build",
        criteria: ["D41.1-AC1", "D41.1-AC2"],
        description: "pnpm -r build: the catalog with its four types and the resolver of the settings module",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/contracts/src/settings/catalog.ts", "packages/core/src/modules/settings/domain/resolve-settings.ts"],
      },
      {
        id: "settings-catalog",
        criteria: ["D41.1-AC1", "D41.1-AC2"],
        description:
          "Unit: the catalog holds every application option of the architecture once, each default inside its own range or list, an environment variable only for the integer options §14 names, the options that ask for a fresh second factor are the named ones; the resolver takes and refuses a value of each type, one bad value rejects the whole set, the environment cannot set an option without a variable, a time of the day matches in the catalog and in the resolver; the cases F08 of D03.2 as before",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/settings"],
        requires: ["tests/unit/settings/settings-catalog.test.ts", "tests/unit/settings/resolve-settings.test.ts", "tests/fixtures/cases/bootstrap-v1.cases.json"],
      },
      ...regressionChecks("D41.1-regression"),
    ],
  },
  {
    // DEV §9.38: the store and the use cases of the application options.
    id: "D41.2",
    ready: true,
    title: "The application options on SQLite: an atomic change of several options, the audit, the locks and the refusals, a reset",
    criteria: ["D41.2-AC1", "D41.2-AC2", "D41.2-regression"],
    checks: [
      {
        // Runs first: the tests import the built core and SQLite adapters.
        id: "workspace-build",
        criteria: ["D41.2-AC1", "D41.2-AC2"],
        description: "pnpm -r build: the table app_setting and its migration, the adapter, and the use cases of the settings module",
        command: ["pnpm", "-r", "build"],
        requires: ["packages/sqlite/src/migrations/0016-app-setting.ts", "packages/sqlite/src/adapters/settings/app-settings.ts", "packages/core/src/modules/settings/application/app-settings.ts"],
      },
      {
        id: "app-settings",
        criteria: ["D41.2-AC1", "D41.2-AC2"],
        description:
          "SQLite: two options written at once and read with their source, the old and the new value in the audit; a refused option or a failing audit takes everything back; the values stay when the database is opened again, a reset removes the stored value and audits only a real one; an unknown key, a wrong type, a value outside the range, a read-only option, one locked by the environment (a reset does not get round the lock), a set that breaks the rule between the record and the body limit, and an option that asks for a fresh second factor each give their code and write nothing; no session is no access",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/settings"],
        requires: ["tests/integration/settings/app-settings.test.ts", "tests/support/identity-rig.ts"],
      },
      {
        id: "migrations",
        criteria: ["D41.2-AC1"],
        description: "The migration plan of the product with the new migration: versions without gaps, checksums, the order of the IDs",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/sqlite/migrations.test.ts"],
        requires: ["tests/integration/sqlite/migrations.test.ts"],
      },
      ...regressionChecks("D41.2-regression"),
    ],
  },
  {
    // DEV §9.38: the routes of the application options and their effect on the limits.
    id: "D41.3",
    ready: true,
    title: "The application options over HTTP: the list, an atomic change, a reset, the locks and the refusals, and the limits that read them at each use",
    criteria: ["D41.3-AC1", "D41.3-AC2", "D41.3-regression"],
    checks: [
      {
        // Runs first: the tests run the built server and import the built packages.
        id: "workspace-build",
        criteria: ["D41.3-AC1", "D41.3-AC2"],
        description: "pnpm -r build: the routes of the options, the effective options and the limits of the modules that read them",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/http/routes/settings.routes.ts", "apps/server/src/bootstrap/effective-settings.ts", "apps/server/src/bootstrap/live-limits.ts", "packages/contracts/src/http/settings.ts"],
      },
      {
        id: "settings-http",
        criteria: ["D41.3-AC1", "D41.3-AC2"],
        description:
          "HTTP: no session is 401 and a foreign Origin 403 on the list, the change and the reset; the list holds every option with its source and what the owner may do and names no environment variable; two options are changed at once or none, with the code and the reference of a refusal; an option locked by the environment, a read-only one and one that asks for a second factor are refused and a reset does not get round the lock; a lower limit applies to the next registry, text and record and trims nothing stored, a long stored text is read and kept while another field is edited, and a reset gives the old limit back",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/settings/settings-http.test.ts"],
        requires: ["tests/integration/settings/settings-http.test.ts", "tests/support/harness-owner.ts", "tests/support/app-harness.ts"],
      },
      {
        id: "settings-restart",
        criteria: ["D41.3-AC2"],
        description: "The built server on a real file: the level of the log applies to the next line, two options changed at once are the same after the process stops and starts again, the audit holds both changes, a reset after the restart removes the stored value",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/settings/settings-restart.test.ts", "tests/unit/logging/technical-logger.test.ts"],
        requires: ["tests/integration/settings/settings-restart.test.ts", "tests/unit/logging/technical-logger.test.ts", "tests/support/auth-http.ts"],
      },
      {
        id: "data-routes",
        criteria: ["D41.3-AC1"],
        description: "The route inventory and the access table of D13.1 and D20.2 with the three new routes: each refused in every state before the gate and answering the owner past it",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts"],
        requires: ["tests/integration/auth/route-inventory.test.ts", "tests/integration/access/data-routes.test.ts", "tests/support/route-inventory.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      ...regressionChecks("D41.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the catalog, the store and the routes of the options.
  {
    id: "D41",
    ready: true,
    title: "The API of the application options: a typed catalog, an atomic change with its audit, the routes and their effect on the limits",
    steps: ["D41.1", "D41.2", "D41.3"],
    criteria: [],
    checks: [],
  },
  {
    // DEV §9.39: the settings in the interface, the frame, Account and Style.
    id: "D42.1",
    ready: true,
    title: "The settings in the interface: the way in from the bar, the Account page and the Style page with the accent of the dashboard",
    criteria: ["D42.1-AC1", "D42.1-AC2", "D42.1-regression"],
    checks: [
      {
        // Runs first: the e2e tests run the built server and SPA.
        id: "workspace-build",
        criteria: ["D42.1-AC1", "D42.1-AC2"],
        description: "pnpm -r build: the settings frame, the Account and Style pages and the namespace of their texts",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/web/src/features/settings/pages/settings-layout.tsx", "apps/web/src/features/settings/pages/account-page.tsx", "apps/web/src/features/settings/pages/style-page.tsx", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "check-locales",
        criteria: ["D42.1-AC1", "D42.1-AC2"],
        description: "pl and en have the same namespaces and keys, including the new namespace of the settings",
        command: ["pnpm", "check:locales"],
        requires: ["scripts/check-locales.ts", "apps/web/src/locales/pl/settings.json", "apps/web/src/locales/en/settings.json"],
      },
      {
        id: "settings-account-style-e2e",
        criteria: ["D42.1-AC1", "D42.1-AC2"],
        description:
          "Playwright on the built app: the bar leads to Account and the sections are links of one frame with aria-current; an unknown time zone is told at its field with everything typed kept, the language changes the interface at once without a reload, a new zone moves the clock of the owner; the preview card wears the chosen accent before the save and the dashboard after it, the Style page with no dashboard says where to make it; axe on both pages",
        command: ["node", "tests/verification/e2e.ts", "settings-account-style.spec"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/settings-account-style.spec.ts", "tests/e2e/owner-session.ts"],
        timeoutMs: 15 * 60 * 1000,
      },
      ...regressionChecks("D42.1-regression"),
    ],
  },
  {
    // KM3 gate (DEV §8.4, §9.37): the screen of F01 on one installation in a browser, then the reports of
    // the fast tier for D33-D40 joined item by item for this exact code; does not run their tests again.
    id: "G3",
    ready: true,
    title: "Gate G3: the screen on a laptop and a phone, the register and two clocks, and the Designer",
    criteria: ["G3-path", "G3-matrix", "G3-reports"],
    checks: [
      {
        // Runs first: the path test uses the built server and SPA.
        id: "workspace-build",
        criteria: ["G3-path"],
        description: "pnpm -r build: the server and the SPA the path of the screen runs on",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts", "apps/web/src/app/router/router.tsx"],
      },
      {
        id: "g3-path-e2e",
        criteria: ["G3-path"],
        description:
          "Playwright on a fresh installation: the table and the two clocks of F01 through the routes of the product; at the night the clocks change (F02) Dom and Nowy Jork show their local times on a laptop and then on a phone without sideways scrolling, axe on both; a record added in tab A is in tab B within a second, and after the server restarts tab B is live again and shows what came meanwhile; a table whose data cannot be read says why with its code and reference while the clocks go on, and the Designer and its preview open the same screen",
        command: ["node", "tests/verification/e2e.ts", "g3-path"],
        requires: ["tests/verification/e2e.ts", "tests/e2e/g3-path.spec.ts", "tests/fixtures/books/books-v1.export.json", "tests/fixtures/books/books-v1.expected.json", "tests/e2e/owner-session.ts"],
        timeoutMs: 10 * 60 * 1000,
      },
      {
        id: "g3-matrix-static",
        criteria: ["G3-matrix"],
        description: "Every item of G3 names ready reports, checks of those tasks and test titles written as they stand in the sources the checks run; every report joined proves an item",
        command: ["node", "tests/verification/g3-matrix-static.ts"],
        requires: ["tests/verification/g3-matrix-static.ts", "tests/verification/g3-matrix.ts"],
      },
      {
        id: "g3-gate-controls",
        criteria: ["G3-matrix"],
        description: "The G3 gate on synthetic reports: a complete set passes; a failed or renamed test line and a failed check fail; a missing report and a report of other code are blocked; the result always lists every item",
        command: ["node", "tests/verification/g3-gate-controls.ts"],
        requires: ["tests/verification/g3-gate-controls.ts", "tests/verification/gate-controls.ts", "tests/verification/g3-gate.ts", "tests/verification/gate-run.ts", "tests/verification/g3-matrix.ts"],
      },
      {
        id: "g3-gate",
        criteria: ["G3-reports"],
        description:
          "Joins the reports of D33.1, D33.2, D35.1, D35.3, D36.1, D36.3, D37.2, D38.1, D38.2, D38.3, D39.1, D39.2, D39.3 and D40.1 for exactly this code and decides every item of G3 from the passed test that proves it: a record from tab A in tab B, a layout from tab A in tab B, the stream coming back, the end of a session, the clocks across the change of time, a failing widget beside the others, a failed save, a touch and an interrupted drag, ten widgets, the preview; names what is not run. A missing report is blocked",
        command: ["node", "tests/verification/g3-gate.ts"],
        requires: ["tests/verification/g3-gate.ts", "tests/verification/g3-matrix.ts", "tests/verification/gate-run.ts", "tests/verification/report-join.ts"],
      },
    ],
  },
  {
    id: "D19.1",
    ready: true,
    title: "install.sh in local mode: preflight and the installation folder, without Docker",
    criteria: ["D19.1-AC1", "D19.1-AC2", "D19.1-regression"],
    checks: [
      {
        // Runs first: one test starts the built server on the folder the installer wrote.
        id: "workspace-build",
        criteria: ["D19.1-AC1"],
        description: "pnpm -r build: the server that the installed folder must start",
        command: ["pnpm", "-r", "build"],
        requires: ["apps/server/src/main.ts"],
      },
      {
        id: "installer-syntax",
        criteria: ["D19.1-AC1"],
        description: "bash parses install/install.sh (the macOS bash 3.2 and the bash of Linux accept the same syntax)",
        command: ["bash", "-n", "install/install.sh"],
        requires: ["install/install.sh"],
      },
      {
        id: "installer-folder",
        criteria: ["D19.1-AC1"],
        description:
          "A clean folder with spaces and Polish letters gets the files and keys of the test preparer for Compose, .env 600 and no secret elsewhere; the built server starts on it; a second run changes no file; a different port is refused; an interrupted folder continues with the same identity and keys; a folder of folders starts fresh; a folder that lost its .env is never given new keys; two installations differ",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/installer", "-t", "D19.1-AC1"],
        requires: ["tests/integration/installer/install-local.test.ts", "tests/support/installer-rig.ts", "tests/support/compose-instance.ts"],
      },
      {
        id: "installer-preflight",
        criteria: ["D19.1-AC2"],
        description:
          "With a fake docker: no CLI, a stopped daemon, Windows containers, an old Engine, an old or missing Compose, root, ports out of range, not a number and in use, an image with a quote or a space, the server mode, an unknown or valueless argument, a bad e-mail, a missing image, a foreign or non-folder target and another installation's folder end with a nonzero code and a message, and write nothing; Ctrl+C ends with 130 and creates no folder",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/installer", "-t", "D19.1-AC2"],
        requires: ["tests/integration/installer/install-local.test.ts", "tests/support/installer-rig.ts"],
      },
      ...regressionChecks("D19.1-regression"),
    ],
  },
  {
    id: "D19.2",
    ready: true,
    title: "install.sh in local mode: image, start, owner account and restart, resumable",
    criteria: ["D19.2-AC1", "D19.2-AC2", "D19.2-regression"],
    checks: [
      {
        id: "installer-syntax",
        criteria: ["D19.2-AC1"],
        description: "bash parses install/install.sh",
        command: ["bash", "-n", "install/install.sh"],
        requires: ["install/install.sh"],
      },
      {
        id: "installer-stage-order",
        criteria: ["D19.2-AC1"],
        description:
          "With a fake docker that records every call: image check, start, stop, the one-off create-owner container, start again, in the installation folder; the owner JSON arrives on stdin with its characters intact (Polish letters, quotes, a backslash, a dollar sign, a tab); the password is in no argument, environment, file, output or state; a complete installation only shows its status; missing credentials, an empty stdin or a control character end before any write",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/installer/install-stages.test.ts", "-t", "D19.2-AC1"],
        requires: ["tests/integration/installer/install-stages.test.ts", "tests/support/installer-rig.ts"],
      },
      {
        id: "installer-resume",
        criteria: ["D19.2-AC2"],
        description:
          "A pull that fails, an application that does not become healthy, an owner refused or failing for another reason, a restart that fails after the owner, an owner that already exists and Ctrl+C while the application starts: the state stays at the last finished stage, the keys do not change, the rerun finishes and creates no second owner; after the owner stage no password is needed",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/installer/install-stages.test.ts", "-t", "D19.2-AC2"],
        requires: ["tests/integration/installer/install-stages.test.ts", "tests/support/installer-rig.ts"],
      },
      {
        id: "installer-folder-regression",
        criteria: ["D19.2-regression"],
        description: "The preflight and folder tests of D19.1 still pass with the full installer",
        command: ["pnpm", "exec", "vitest", "run", "tests/integration/installer/install-local.test.ts"],
        requires: ["tests/integration/installer/install-local.test.ts"],
      },
      ...regressionChecks("D19.2-regression"),
    ],
  },
  {
    id: "D19.3",
    ready: true,
    title: "install.sh with the real Docker: a clean install, interruptions, a repeated run and two installations",
    criteria: ["D19.3-AC1", "D19.3-AC2", "D19.3-regression"],
    checks: [
      {
        id: "installer-docker-native",
        criteria: ["D19.3-AC1", "D19.3-AC2"],
        description:
          "Real docker on the native architecture: a folder with spaces and Polish letters and a locally built image become a healthy installation published on 127.0.0.1 only, .env 600, the owner signs in and a wrong password is refused; the password is in no file, output, container configuration or log; a second run changes nothing and keeps the container; a password the application refuses stops at 'started' with the application stopped and the rerun continues; Ctrl+C right after the owner account ends with 130 and the rerun needs no password and creates no second owner; three installations differ in project, keys, port, container and cookie names, and a session of one does not open another",
        command: ["node", "tests/system/install-local.ts"],
        requires: ["tests/system/install-local.ts", "install/install.sh", "docker/Dockerfile", "docker/compose.yml"],
        timeoutMs: 40 * 60 * 1000,
      },
      {
        id: "readme-quickstart",
        criteria: ["D19.3-AC1"],
        description: "The README quick start names the installer, the image build, every option of the script and its limits",
        command: ["pnpm", "exec", "vitest", "run", "tests/unit/foundation/readme-install.test.ts"],
        requires: ["tests/unit/foundation/readme-install.test.ts", "README.md", "install/install.sh"],
      },
      ...regressionChecks("D19.3-regression"),
    ],
  },
  // The parent passes only through its work orders: the folder, the stages and the real Docker run.
  {
    id: "D19",
    ready: true,
    title: "install.sh in local mode: a clean installation that reaches sign-in and can be resumed",
    steps: ["D19.1", "D19.2", "D19.3"],
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
