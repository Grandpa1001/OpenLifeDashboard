# OpenLifeDashboard

A self-hosted, no-code personal life dashboard: build your own registers, dictionaries and screens with widgets, and view them live on your phone, laptop and a large screen.

> **Status: early development (KM1).** The foundation (KM0) passed gate G0: the image starts from a Compose installation with a real database, snapshots and logs, and the web app shows whether the server is ready. The database now has the tables of the auth adapter, the owner singleton and the audit trail, and the `create-owner` command creates the owner account (credentials on stdin only), and the server has explicit sign-in, sign-out and status routes with a persistent lockout; the second factor can be enrolled (TOTP with recovery codes) and proven at sign-in (TOTP, recovery code, trusted device); the first setup (choice of the starting data, preferences) and `reset-mfa` exist, and the browser walks through the whole first setup (sign-in, the second factor and its enrollment with recovery codes shown once, the empty start, time zone and language) to an empty private screen; there is no data or screen to build yet. The local installer (`install/install.sh`) exists for macOS and Linux and is described below, but there is no release yet: it runs an image you built yourself. Nothing here is ready for everyday use.

## Install (local mode, macOS and Linux)

You need Docker (Engine 25 or newer, with Compose 2.24 or newer, running Linux containers) and a user that is not root. Until the first release publishes an image, build it from this repository:

```sh
docker build -f docker/Dockerfile -t openlifedashboard:local .
bash install/install.sh --image openlifedashboard:local
```

The installer asks for the installation folder (default `~/OpenLifeDashboard/default`), the port (default 8080), the e-mail of the owner and the password, which you type twice and which is not shown. Without a terminal, give them as `--dir`, `--port`, `--owner-email` and `--owner-password-stdin` (the password is the first line of stdin). The password is never an argument, an environment variable or a file. The e-mail may use only the letters a-z, digits and `. _ + -` (no accented letters) and the password needs 12 to 128 characters; the installer checks both before it writes anything and, in a terminal, asks again.

It checks the system first and writes nothing until every check has passed, then creates the folder (`.env` with new keys readable only by you, `data/`, `control/`, the Compose files), makes sure the image is present, starts the application, creates the owner account in a one-off container while the application is stopped, and starts it again. At the end it prints the address (`http://localhost:<port>`, reachable only from this computer), the paths of the data, logs and backups, and how to stop and start it. The first sign-in sets up the second factor (TOTP) and shows your recovery codes.

Run the installer again after an interruption or a failure: it continues at the first stage that is not done (`control/install-state.json`), never overwrites a file, keeps the keys and does not create a second owner. On a finished installation it only shows the status. Copy `.env` to a safe place: without its keys the data cannot be opened. Stopping the application keeps all data; deleting the data is a separate decision of yours (delete the folder). The server mode, Windows and the release package come later.

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
pnpm fixtures:verify      # the synthetic fixtures of tests/fixtures; -- --self-test adds corruption controls
pnpm check:locales        # pl and en translations have the same keys, plural forms and variables
pnpm test:e2e             # Playwright on the built app (pnpm build; pnpm exec playwright install chromium)
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

On the first start of an installation the server creates `data/app.db` (SQLite in WAL mode) with the migration manifest and the installation ID from `control/instance.json`. On every later start it checks the database before opening it for writing and refuses, without changing it, a file it does not recognize (`DATABASE_UNRECOGNIZED`), a database of a newer version (`DATABASE_NEWER`), an applied migration that was changed (`MIGRATION_CHECKSUM_MISMATCH`), another installation's database (`INSTANCE_METADATA_INVALID`) or a missing database of an existing installation (`DATABASE_MISSING`). Upgrading an existing database to a newer image takes a verified snapshot of the old version into `data/backup/` first and then applies all pending migrations in one transaction. If the snapshot cannot be written the start stops with `MIGRATION_SNAPSHOT_REQUIRED` and nothing is changed; if a migration fails the start stops with `MIGRATION_FAILED`, the database stays at its old version and the snapshot remains in `data/backup/`. If the process is killed in the middle of an upgrade, the next start with the same image continues it: a finished snapshot of that upgrade is recognized and checked again instead of taking a second one, and a migration that had already committed is only closed. A state the server cannot prove safe stops the start with `MAINTENANCE_RECOVERY_REQUIRED`. Before it is ready the server also checks that the sign-in tables have every column, type, key and index the pinned auth library expects for its settings; a difference stops the start with `AUTH_SCHEMA_INCOMPATIBLE` naming the columns, and nothing repairs them automatically.

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

The image refuses to start unless `/data` and `/control/maintenance` are really mounted (`STORAGE_NOT_MOUNTED`), so a container started by hand without them cannot create a second installation inside itself; `docker compose down` removes the container and keeps all data in the mounted folders.

`pnpm verify:task -- D07.1` checks the compose files statically and, with Docker, runs them for real (healthy, non-root, loopback only, mounts, stop within 20 s); without Docker the real run is blocked.

### Container image

`docker/Dockerfile` builds the app image (Node 24 on Debian trixie-slim, runs as the non-root `node` user) for the platform of the building machine. Compose files and installers come later.

```sh
docker build -f docker/Dockerfile -t openlifedashboard:dev .
docker run --rm -p 127.0.0.1:8080:8080 openlifedashboard:dev
```

`pnpm verify:task -- D02.2` and `-- D02.3` build the image natively for the host architecture, check the SQLite driver and the container start/stop; without Docker they report blocked. CI runs them on native linux/amd64 and linux/arm64 runners, and `pnpm verify:task -- D02` accepts the result only with passing reports of both architectures for the same commit.

### Owner account

There is no sign-up. The owner exists only after `create-owner`, which runs against a stopped app (it takes the same writer lease; a running app means `INSTANCE_BUSY` and no change) and a database that is already current. The e-mail and the password are read from stdin as one JSON object, `{"email": "...", "password": "..."}` (12–128 code points, never trimmed or normalized), and never from arguments or the environment. One transaction writes the account, the owner singleton and the `owner.created` audit entry; a second owner is refused with `OWNER_ALREADY_EXISTS`. On failure the command exits 1 with a stable code and field names, never values.

```sh
printf '%s' '{"email":"owner@example.com","password":"a long passphrase"}' | node apps/server/dist/cli/create-owner.js --installation <installation-folder>
```

`reset-password` works the same way (stopped app, current database, stdin only) with `{"password": "..."}`. In one transaction it replaces the password hash, raises the access epoch, ends every session of the owner and writes the `owner.password_reset` audit entry; the old cookies stop authenticating at once. There is no e-mail reset: the commands are the only way.

```sh
printf '%s' '{"password":"a new long passphrase"}' | node apps/server/dist/cli/reset-password.js --installation <installation-folder>
```

The container sequence (stop the app, one-off container, start again) is what `install/install.sh` does.

### Verified runtime

Versions exercised by the verification reports; `tests/verification/readme-versions.ts` fails when a pinned version below no longer matches `package.json`, the pnpm catalog or the Dockerfile. The release matrix (KM7) extends this list.

| Component | Version |
|---|---|
| Node.js | 24.22.1 (LTS, `.node-version`) |
| pnpm | 12.14.0 (`packageManager`) |
| Base image | `node:24.22.1-trixie-slim` pinned by digest in `docker/Dockerfile` |
| SQLite driver | better-sqlite3 13.0.3 (bundled native binaries), SQLite 3.53.4 |
| Writer lease | fs-native-extensions 1.5.1 (bundled native binaries): OFD lock on Linux, flock on macOS |
| Native image runs | linux/amd64 on `ubuntu-24.04`, linux/arm64 on `ubuntu-24.04-arm` (GitHub Actions) |
| Docker Engine | 28.0.4 on both runners |
| HTTP server | hono 4.13.13, @hono/node-server 2.1.5 |
| Web app | react 19.3.1, vite 8.3.5, @tanstack/react-router 1.170.46, @tanstack/react-query 5.104.5, i18next 26.5.10, react-i18next 17.1.8, uqr 0.1.3 (QR code matrix) |
| Schemas | zod 4.6.7 (server and contracts; the web app checks health without it) |
| Auth adapter | better-auth 1.7.13 (table schema and crypto primitives; writes go through the application's transactions), @node-rs/argon2 2.2.2 (argon2id, m=19 MiB, t=2, p=1), @better-auth/utils 0.5.1 (HOTP for the TOTP check) |
| Language and tests | typescript 6.0.3, vitest 5.0.5, @playwright/test 1.64.1 with its Chromium, @axe-core/playwright 4.14.0 |

### Gate G0

G0 closes the foundation (KM0): the image of a commit, started by Compose from a test installation, serves the status screen, a real database and a log line that carries the request ID, and refuses or degrades where it must. `pnpm verify:task -- G0` does not run the tests again: it joins the reports of D01–D08 made for exactly the same code (commit and uncommitted changes) and the D02 image reports of linux/amd64 and linux/arm64, then decides every item of G0 and every case of the failure matrix (bad environment, unknown instance metadata, read-only mounts, read-only logs only, symlinks, no space for a snapshot, interrupted initialization, wrong checksum, newer database, second writer, SIGKILL, SIGTERM timeout) from the test or assertion that proved it, listed in `tests/verification/g0-matrix.ts`. A case without its report is blocked, a case whose test failed or is missing fails; the report lists every case. CI runs it as the last job. Locally, run the steps first:

```sh
pnpm verify:task -- D07      # and the other steps; container checks need Docker
pnpm verify:task -- G0       # blocked until reports of both image architectures are in .artifacts/arch-reports
```

G0 does not cover sign-in, the usable owner setup or the Windows/Safari release matrix.

`verify:task` reads `tooling/verification-tasks.ts` and records each check as passed, failed, blocked (missing file, tool or precondition) or not_run. Tasks without defined checks are reported as blocked. CI (`.github/workflows/ci.yml`) runs the same command for every task the map can verify (a check of the workflow fails when one is missing); D00 needs the local specification and stays local.

CI has two tiers. Every push and pull request runs the fast tier: the checks of the code that changes from step to step (D01, D09–D14 with real SQLite and raw HTTP, and the built app in a browser, D12), in two parallel jobs. The full tier adds Docker, Compose, the images on both architectures and the gates G0 and D13 (the handover), and runs every night, by hand (workflow_dispatch), when a commit message contains `[full]` (use it before a gate or a release), and when a commit touches what those checks are about (`docker/`, the bootstrap, the migrations and the connection, the workflow, the verification map, the lockfile). A gate is never decided on a partial set of reports. A push to `main` is never cancelled by a newer one; only a pull request replaces its older run.

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
