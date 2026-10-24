# OpenLifeDashboard

A self-hosted, no-code personal life dashboard: build your own registers, dictionaries and screens with widgets, and view them live on your phone, laptop and a large screen.

> **Status: early development.** The repository currently contains only the monorepo skeleton. Nothing here is ready to install or use yet.

## Development

Requirements: [Corepack](https://nodejs.org/api/corepack.html) or pnpm. The exact pnpm version (`packageManager`) and Node.js runtime (`devEngines.runtime`) are pinned in `package.json`; pnpm downloads that Node.js version for scripts automatically.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck            # product packages and the tooling scripts
pnpm lint
pnpm check:architecture   # import boundaries ARCH-01…05 plus their negative controls
pnpm check:contracts      # package exports, build artifacts and runtime loading
pnpm verify:task -- D01   # every check mapped to a task; report in .artifacts/<run-id>/
```

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
| `tests` | Test data and support; synthetic graphs for the boundary checks |

## License

[MIT](LICENSE)
