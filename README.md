# OpenLifeDashboard

A self-hosted, no-code personal life dashboard: build your own registers, dictionaries and screens with widgets, and view them live on your phone, laptop and a large screen.

> **Status: early development.** The server answers `/api/health` and serves a placeholder web app; there is no sign-in or data yet. Nothing here is ready to install or use.

## Development

Requirements: [Corepack](https://nodejs.org/api/corepack.html) or pnpm. The exact pnpm version (`packageManager`) and Node.js runtime (`devEngines.runtime`) are pinned in `package.json`; pnpm downloads that Node.js version for scripts automatically.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck            # product packages and the tooling scripts
pnpm lint
pnpm check:architecture   # import boundaries ARCH-01…05 plus their negative controls
pnpm check:contracts      # package exports, build artifacts and runtime loading
pnpm test:unit            # pure rules, e.g. the F08 bootstrap cases
pnpm test:integration     # HTTP tests against the built server (run pnpm build first)
pnpm verify:task -- D01   # every check mapped to a task; report in .artifacts/<run-id>/
```

The server starts only with an installation: environment keys and `control/instance.json`. Outside a container, prepare an isolated test installation in a fresh folder (it generates the keys and refuses a non-empty folder) and run the built app on http://127.0.0.1:8080:

```sh
pnpm build
pnpm prepare:test-instance -- ../openlife-dev   # prints the start command
node --env-file=../openlife-dev/.env apps/server/dist/main.js --installation ../openlife-dev
```

Start options: `--port <n>` (0 = ephemeral), `--host`, `--web-root`, `--installation <dir>`. Before listening the server checks the environment, the instance metadata, the option set and the storage folders; a failure exits 1 with `bootstrap.failed` and the fields to fix, never their values.

One server process writes to an installation at a time. It holds an exclusive lock on `control/maintenance/writer.lock` while it runs; a second process on the same folder exits 1 with `INSTANCE_BUSY`. The lock is released when the process ends, also after a crash, so there is nothing to delete by hand. `control/maintenance/state.json` records maintenance operations in progress: if one was left unfinished, the server refuses to start with `MAINTENANCE_RECOVERY_REQUIRED` instead of writing to possibly inconsistent data.

The server writes a technical log as JSON lines to standard output and to `data/logs/app/app.jsonl`: one `http.request` line per request (method, route template, status, duration) under the same request ID that the response carries in `X-Request-Id` and in the `requestId` of an error body, and an `http.unhandled_error` line for a failure. Only a fixed set of fields can appear; request URLs, headers, cookies, bodies and error messages never do. On SIGTERM or SIGINT the server stops in order within 15 seconds: the health probe answers 503 first, requests already in progress are finished, then the log is flushed, the database is closed and the writer lock is released last. If something keeps it from finishing in time the process exits with status 1 and reports `server.stop_timeout` on standard error naming the step; it never reports a stop that did not happen. The next start recovers the database on its own.

The file is rotated before it would exceed `logs.fileMaxMiB` (default 10 MiB) into `app.<UTC time>-<n>.jsonl`; at most `logs.maxFiles` files (default 5, including the active one) are kept and rotated files older than `logs.retentionDays` (default 14) are removed — only files with exactly that name, never anything else in the folder. If the file cannot be written (no permission, disk full) the server keeps running and logging to standard output, reports it once a minute on standard error as `logger.sink_degraded` with the number of lost lines, and tries the file again after 30 seconds.

On the first start of an installation the server creates `data/app.db` (SQLite in WAL mode) with the migration manifest and the installation ID from `control/instance.json`. On every later start it checks the database before opening it for writing and refuses, without changing it, a file it does not recognize (`DATABASE_UNRECOGNIZED`), a database of a newer version (`DATABASE_NEWER`), an applied migration that was changed (`MIGRATION_CHECKSUM_MISMATCH`), another installation's database (`INSTANCE_METADATA_INVALID`) or a missing database of an existing installation (`DATABASE_MISSING`). Upgrading an existing database to a newer image takes a verified snapshot of the old version into `data/backup/` first and then applies all pending migrations in one transaction. If the snapshot cannot be written the start stops with `MIGRATION_SNAPSHOT_REQUIRED` and nothing is changed; if a migration fails the start stops with `MIGRATION_FAILED`, the database stays at its old version and the snapshot remains in `data/backup/`. If the process is killed in the middle of an upgrade, the next start with the same image continues it: a finished snapshot of that upgrade is recognized and checked again instead of taking a second one, and a migration that had already committed is only closed. A state the server cannot prove safe stops the start with `MAINTENANCE_RECOVERY_REQUIRED`.

Check an installation environment without starting the server (prints no secret values; exit 1 names invalid fields):

```sh
INSTALL_MODE=local BASE_URL=http://localhost:8080 BETTER_AUTH_SECRET=<64 hex> APP_ENCRYPTION_KEY=<64 hex> \
  node apps/server/dist/cli/config-check.js
```

For frontend work, keep the server running and start Vite on http://127.0.0.1:5173; it proxies `/api` to port 8080:

```sh
pnpm --filter @openlife/web dev
```

### Compose (local mode)

`docker/compose.yml` and `docker/compose.local.yml` run the app as the host user, read-only and without capabilities, with exactly three mounts (`data`, `control/maintenance`, and `control/instance.json` read-only), published only on `127.0.0.1:PORT`. A test installation that Compose can run is prepared from an image that exists on your machine:

```sh
docker build -f docker/Dockerfile -t openlifedashboard:dev .
pnpm prepare:test-instance -- ../openlife-compose --image openlifedashboard:dev --port 8080
cd ../openlife-compose && docker compose up --detach --wait
```

`pnpm verify:task -- D07.1` checks the compose files statically and, with Docker, runs them for real (healthy, non-root, loopback only, mounts, stop within 20 s); without Docker the real run is blocked.

### Container image

`docker/Dockerfile` builds the app image (Node 24 on Debian trixie-slim, runs as the non-root `node` user) for the platform of the building machine. Compose files and installers come later.

```sh
docker build -f docker/Dockerfile -t openlifedashboard:dev .
docker run --rm -p 127.0.0.1:8080:8080 openlifedashboard:dev
```

`pnpm verify:task -- D02.2` and `-- D02.3` build the image natively for the host architecture, check the SQLite driver and the container start/stop; without Docker they report blocked. CI runs them on native linux/amd64 and linux/arm64 runners, and `pnpm verify:task -- D02` accepts the result only with passing reports of both architectures for the same commit.

### Verified runtime

Versions exercised by the verification reports (DEV D02); the release matrix extends this list later.

| Component | Version |
|---|---|
| Node.js | 24.22.1 (LTS, `.node-version`) |
| pnpm | 12.14.0 (`packageManager`) |
| Base image | `node:24.22.1-trixie-slim` pinned by digest in `docker/Dockerfile` |
| SQLite driver | better-sqlite3 13.0.3 (bundled native binaries), SQLite 3.53.4 |
| Writer lease | fs-native-extensions 1.5.1 (bundled native binaries): OFD lock on Linux, flock on macOS |
| Native image runs | linux/amd64 on `ubuntu-24.04`, linux/arm64 on `ubuntu-24.04-arm` (GitHub Actions) |
| Docker Engine | 28.0.4 on both runners |

`verify:task` reads `tooling/verification-tasks.ts` and records each check as passed, failed, blocked (missing file, tool or precondition) or not_run. Tasks without defined checks are reported as blocked. CI (`.github/workflows/ci.yml`) runs the same command.

Workspace packages import each other only by package name through `exports`. Every export maps three conditions: `@openlife/source` (TypeScript source, used by the boundary checks), `types` and `default` (build output).

Workspace layout:

| Path | Responsibility |
|---|---|
| `apps/server` | HTTP API, SPA hosting, live stream, scheduler |
| `apps/web` | Browser single-page application |
| `packages/core` | Domain rules and use cases, free of frameworks and runtimes |
| `packages/contracts` | Transport schemas, DTOs and error codes |
| `packages/sqlite` | SQLite connection, migrations and repository adapters |
| `packages/widgets` | Widget definitions (`/definitions`) and views (`/views`) |
| `packages/ui` | Presentational components and design tokens |
| `tooling/typescript` | Shared strict TypeScript configuration (neutral, Node and browser profiles) |
| `tooling/dependency-cruiser`, `tooling/eslint` | Import boundary and lint rules |
| `scripts` | Repository checks (`check:architecture`, `check:contracts`) |
| `tests` | Integration tests, step checks, test support and synthetic graphs for the boundary checks |

## License

[MIT](LICENSE)
