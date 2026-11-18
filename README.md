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

Run the installer again after an interruption or a failure: it continues at the first stage that is not done (`control/install-state.json`), never overwrites a file, keeps the keys and does not create a second owner, and keeps the release it was made with: a newer package, or another `--image`, next to an installation that is begun is not installed (a newer release comes from the Updates page of the application). On a finished installation it only shows the status. Copy `.env` to a safe place: without its keys the data cannot be opened. Stopping the application keeps all data; deleting the data is a separate decision of yours (delete the folder). A release package is one release in one folder: `install.sh`, the Compose files, `release.json` (version and the image, pinned by its digest) and `SHA256SUMS`. Run from a package, the installer checks every file against `SHA256SUMS` before it writes anything, refuses a package that is damaged, changed, incomplete or holds an extra file, and takes the image from `release.json` (so `--image` is not needed). The sums find damage, not who published the package. `pnpm package:release -- --image <name@sha256:digest>` builds a package from this repository into `.artifacts/release/`. The server mode (Linux, `--mode server --domain <domain> --acme-email <e-mail>`) is only partly there: it checks the system, the ports 80 and 443 and that the domain resolves, writes the installation folder and stops with the status 3, saying that nothing is installed or running yet; the HTTPS stack that starts it comes with a later release. Windows comes later.

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

### Restoring a deleted registry

Deleting a registry first takes a verified copy of the whole database into `data/backup/<UTC time>-pre_delete-<snapshot id>/` (`app.db`, `meta.json`, `checksums.json`). Restoring one registry from it is a command, there is no button yet:

1. Stop the app.
2. Find the package: the newest directory named `…-pre_delete-…` taken right after the deletion.
3. Run `restore-registry` with the directory's name and the registry's symbol on stdin:

```sh
printf '%s' '{"snapshot":"20261102T120000Z-pre_delete-<snapshot id>","symbol":"ksiazki"}' | node apps/server/dist/cli/restore-registry.js --installation <installation-folder>
```

4. Start the app again. Widgets bound to the registry show as bound again.

The command takes the writer lease like the other commands and verifies the package as a full restore would: the files, their checksums, the meta, the integrity of the copy, this installation, the reason `pre_delete` and the schema version of the database. It reads only that registry from the copy and puts back its catalog, its table, its indexes and its records under the same identifiers, with their times and revisions, in one transaction; nothing else (other registries, screens, sign-in data) changes. It restores only over that registry's own deletion: a registry that is not deleted, a symbol the copy does not have, or a catalog that changed since is `RESTORE_CONFLICT` and nothing is written. On failure it exits 1 with a stable code and field names, never values.

### Restoring the whole instance

A copy is only as good as the day you try it. This is the procedure for bringing a whole installation back from a package of `data/backup/`, on the same machine after a failure or on a new one. There is no button: it is three commands and a start, and they only run against a stopped app.

**What you need.** The package (a directory `…-<reason>-<snapshot id>/` of the installation, from `data/backup/` or from wherever you keep copies of it), the two files that are the identity and the keys of the installation, `control/instance.json` and the environment file with `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY`, and an image of the same build that wrote the package. **The keys are not in the copies.** Without the original `APP_ENCRYPTION_KEY` the second factor in a restored database cannot be opened (`KEY_MISMATCH`); keep `instance.json` and the environment file somewhere other than the disk the data is on, and rehearse the restore once before you need it. Copies on the disk of the installation do not protect against the loss of that disk.

1. Stop the app and anything else that opens the database. A running app holds the writer lease and every command below answers `INSTANCE_BUSY` without changing anything.
2. On a new machine, prepare the installation first: put the saved `control/instance.json` and the environment file in place, leave `data/` empty, and copy the package into `data/backup/`. A package of another installation is refused with `SNAPSHOT_UNSUITABLE` (`instanceId`).
3. List what is there with `backup-list` (read only, it works beside a running app) and pick the package:

```sh
node apps/server/dist/cli/backup-list.js --installation <installation-folder>
```

4. Check it with `backup-verify`. It verifies the package in full (files, checksums, meta, integrity, and the export of a bundle) and says whether this build can restore it. A damaged or incomplete package is `SNAPSHOT_INVALID` with the part named; a package of a newer schema than the build knows is `SNAPSHOT_UNSUITABLE` (`schemaVersion`):

```sh
printf '%s' '{"snapshot":"<package directory name>"}' | node apps/server/dist/cli/backup-verify.js --installation <installation-folder>
```

5. Restore with `restore-instance` and the explicit confirmation that the current database is replaced:

```sh
printf '%s' '{"snapshot":"<package directory name>","confirm":"replace-current-database"}' | node apps/server/dist/cli/restore-instance.js --installation <installation-folder>
```

The command checks the package again, checks that the current `APP_ENCRYPTION_KEY` opens the secret of the second factor in it and that the disk holds the database and its reserve, then moves the current `app.db`, `app.db-wal` and `app.db-shm` together into `data/.restore-parked-<time>-<id>/` (kept as they were, a damaged set included; nothing is deleted), puts the database of the package in place, and in one transaction ends every session and trusted device and writes the `backup.restored` audit entry. A failure at any point moves the parked set back. The journal of the restore is `control/maintenance/restore-journal.json` (`started`, `parked`, `restored` or `failed`).

6. Start the app and check it before you open it to anyone: sign in with your password and your authenticator (every session of the past is gone, and so is every trusted device), look at the registers and the counts you expect, and at the diagnostics.
7. When you are satisfied, delete the parked folder by hand; the app never does.

**When it does not work.**

| Answer | Meaning and what to do |
|---|---|
| `INSTANCE_BUSY` | The app or another command is running. Stop it. |
| `SNAPSHOT_INVALID` | The package is damaged, incomplete or not in the folder (`fields` names the part). Take the next newest package. |
| `SNAPSHOT_UNSUITABLE` | Another installation (`instanceId`) or a newer schema than this build (`schemaVersion`). Use the instance file of the source, or the image that wrote the package. |
| `KEY_MISMATCH` | `APP_ENCRYPTION_KEY` is not the key that sealed the copy. Find the original key; without it the database restores no second factor and `reset-mfa` is the only way back in. |
| `RESTORE_LOW_SPACE` | The disk cannot hold the database and the reserve. Free space. |
| `RESTORE_PARK_FAILED`, `RESTORE_PLACE_FAILED`, `RESTORE_CHECKSUM_MISMATCH` | The files could not be moved or written. The current set is back where it was; look at the disk and try again. |
| `RESTORE_FAILED` | Something failed after the database was in place; the answer names the parked folder and whether the set went back (`rolledBack`). If it did not, the set is in that folder and the journal says so. |

Restoring a single deleted registry is the command above, `restore-registry`.

### When a copy fails

A copy either exists whole and verified or does not exist: a package is built in `data/backup/.staging/` and published by one rename, so a failure or a killed process leaves nothing that looks like a copy. What it can leave is a working directory in staging, which `backup-list` shows as `incomplete` and the next copy removes. Nothing here is repaired by itself and no package is deleted except by the retention, which touches only verified copies of this installation.

**A manual copy** (`backup-create`, stopped app) answers with a code:

| Answer | State and what to do |
|---|---|
| `INSTANCE_BUSY` | The app or another command holds the writer lease; nothing was written. Stop it and run again. |
| `SNAPSHOT_LOW_SPACE` | The disk cannot hold the copy and the reserve (`backup.diskReserveMiB`); nothing was written. Free space or lower the reserve, then run again. |
| `SNAPSHOT_FAILED` | The copy could not be written or did not verify; nothing is published and a leftover is only in staging. Check the disk and the permissions of `data/backup/`, then run again. |
| `SNAPSHOT_UNAVAILABLE` | This build has no way to make the kind of package asked for; nothing was written. |
| `DATABASE_MISSING`, `DATABASE_NOT_CURRENT` | There is no database or it is not of the schema of this build; nothing was written. Restore it (above) or start the app once so it migrates. |
| `MAINTENANCE_RECOVERY_REQUIRED` | A maintenance operation was left active by a crash; start the app so it reconciles it, then run again. |
| `COMMAND_FAILED` | An unexpected failure; the answer names the class of the error and the request id to find in the logs. |

**The nightly copy** runs inside the app, at `backup.time` in the owner's time zone, or once after a downtime. A failure never reaches a request; it is a line of the log (`backup.nightly_failed` with one of the codes above or `NIGHTLY_BACKUP_FAILED`), the state is in the diagnostics (`lastRun`), and the job waits fifteen minutes before it tries again. After a good copy the retention runs: `RETENTION_FAILED` (`backup.retention_failed`) leaves the packages that were not yet removed whole and does not make the copy any less good. If you configured `BACKUP_HEARTBEAT_URL`, the signal to the monitor goes after a verified copy only; its failure is its own line (`backup.heartbeat_failed`) with `HEARTBEAT_ADDRESS_FORBIDDEN`, `HEARTBEAT_UNREACHABLE`, `HEARTBEAT_TIMEOUT`, `HEARTBEAT_REDIRECT`, `HEARTBEAT_BAD_STATUS` or `HEARTBEAT_FAILED`, and the copy stays good. An address that is not HTTPS, holds credentials or points inside the network is refused at start with `CONFIG_INVALID` and the key `BACKUP_HEARTBEAT_URL`.

**A killed process** (power cut, `kill -9`) during a copy: nothing is published, `backup-list` shows an `incomplete` entry, the earlier copies are untouched and the next copy clears the leftover. During a restore, after the current set was parked: there is no `app.db`, the old set is whole in `data/.restore-parked-…/` and `control/maintenance/restore-journal.json` is not `restored`; run `restore-instance` again with the same package and it finishes.

**A damaged package** (a changed byte, a missing, extra or linked file, a database that does not open) is `invalid` in `backup-list` with the part named and is refused by `backup-verify` and `restore-instance` as `SNAPSHOT_INVALID`; it is never repaired and never removed by the retention, so you can look at it, and you take the next newest package.

**A locked database** (another connection holding a write lock) does not stop a copy: the copy is the committed state and the lock stays.

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

## Updates

An update is made by the updater of the installation (the installation has one when `UPDATER_ENABLED=true`): it pulls the release named in the trusted catalog, the app closes its writes and takes a copy (`pre_update`), the updater replaces the app, the new app migrates the database and proves itself, and only then does the updater write the choice of the release and the app open its writes. Whatever fails before that point puts the old app back on the copy; nothing written after the copy is lost, because nothing is written after it. After that point there is no way back to the copy.

### When an update does not finish

The state of the operation is in `control/update-state.json` (the record: `state`, `error.code`, `operationId`, `backupId`, `targetRelease`) and in the status of the updater; the log of the updater (`docker compose logs updater`) has one line per step with the same code. The data and the copy are never removed by a failure.

| State and code | What it means and what to do |
|---|---|
| `idle` with `ABORTED` or `UPDATER_RESTARTED` | The operation was given up before the app was replaced (by the app, or because the updater restarted); nothing of the app was changed. Start the update again. |
| `idle` with `CATALOG_MISSING`, `CATALOG_TOO_LARGE`, `CATALOG_INVALID`, `RELEASE_UNKNOWN` or `RELEASE_REQUIRES_ADMIN` | The trusted catalog `control/release-catalog.json` is missing, not whole, does not list the release, or the release replaces the updater itself, which the app does not do; nothing was pulled or changed. Fix the catalog or update the administration package by hand. |
| `idle` with `PULL_FAILED` or `DIGEST_MISMATCH` | The image of the release could not be pulled or is not the digest of the catalog; the app is untouched. Check the network and the registry, then start again. |
| `idle` with `BACKUP_MISSING`, `BACKUP_INVALID` or `PREVIOUS_UNKNOWN` | The copy before the update is not there or is not whole, or the installation has no release file to go back to; the app opened its writes again. Check `data/backup/` and `control/compose.release.yml`. |
| `idle` with `START_TIMEOUT`, `B_EXITED`, `B_OOM_KILLED`, `B_MIGRATION_FAILED` or `B_MISSING` | The new app did not prove itself in time (`UPDATER_START_TIMEOUT_SECONDS`, 60 to 900 seconds), ended, was killed for lack of memory, failed its migration or vanished. The old app is back on its copy and runs. Read the log of the new app (`docker logs`), then start again. |
| `idle` with `VERSION_MISMATCH`, `SCHEMA_MISMATCH`, `RELEASE_FILE_FAILED` or `SWITCH_FAILED` | The new app is not the release of the catalog, its schema is not the one of the catalog, the choice of the release could not be written, or the app could not be replaced. The old app is back on its copy and runs. |
| `recovery_failed` | The way back itself failed (`NO_SNAPSHOT`, `RESTORE_FAILED`, `RELEASE_FILE_RESTORE_FAILED`, `RETIRE_FAILED`, `OUT_OF_SCOPE`, `UNHEALTHY`, `A_UNHEALTHY`, `TRANSITION_REFUSED` or `ROLLBACK_FAILED`). The app does not start and takes no writes: the operation stays on the maintenance gate. See below. |

**When the state is `recovery_failed`** nothing opens by itself and the app stays stopped. With the app and the updater stopped: look at `error.code`, `operationId` and `backupId` in `control/update-state.json`; the package named by `backupId` is in `data/backup/`. Restore it with the image of the old release and close the operation with the same command: `printf '%s' '{"snapshot":"<backupId>","confirm":"replace-current-database","endsUpdate":"<operationId>"}' | node apps/server/dist/cli/restore-instance.js --installation <installation-folder>`, put `control/compose.release.yml` as it was before the update (or remove it if the installation had none) and start the app; when it is healthy, remove `control/update-state.json*` and start the updater, which then has no operation. Sessions are ended by the restore: sign in again.

## License

[MIT](LICENSE)
