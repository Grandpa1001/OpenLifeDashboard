// Synthetic import graphs for scripts/check-architecture.ts (DEV D01.2-AC2).
// Each case is materialized in a temporary copy of the workspace layout, never in the repo.
import type { SyntheticWorkspace } from "../support/synthetic-workspace.ts";

export type ArchitectureTool = "dependency-cruiser" | "eslint";

export type ArchitectureExpectation =
  | Readonly<{ kind: "clean" }>
  | Readonly<{ kind: "violation"; tool: ArchitectureTool; rule: string; from: string }>;

export type ArchitectureCase = Readonly<{
  id: string;
  description: string;
  workspace: SyntheticWorkspace;
  expect: ArchitectureExpectation;
}>;

const violation = (tool: ArchitectureTool, rule: string, from: string): ArchitectureExpectation => ({
  kind: "violation",
  tool,
  rule,
  from,
});

export const architectureCases: readonly ArchitectureCase[] = [
  {
    id: "allowed-graph",
    description: "Every dependency permitted by Architektura §13.3 passes without findings",
    workspace: {
      externalModules: ["better-sqlite3"],
      files: {
        "apps/web/src/main.ts": [
          'import "@openlife/contracts/http/errors";',
          'import "@openlife/ui";',
          'import "@openlife/widgets/views";',
          'import "./features/registers/index.js";',
          'export const loadDesigner = () => import("./features/designer/index.js");',
        ].join("\n"),
        "apps/web/src/features/registers/index.ts": 'import "./record-form.js";\nexport {};\n',
        "apps/web/src/features/registers/record-form.ts": "export {};\n",
        "apps/web/src/features/designer/index.ts": "export {};\n",
        "packages/widgets/src/views.ts":
          'import "@openlife/ui";\nimport "@openlife/contracts/http/errors";\nimport "./definitions.js";\nexport {};\n',
        "packages/widgets/src/definitions.ts": 'import "@openlife/contracts/http/errors";\nexport {};\n',
        "packages/sqlite/src/index.ts":
          'import "@openlife/core";\nimport "node:fs";\nimport "better-sqlite3";\nexport {};\n',
        "apps/server/src/main.ts": [
          'import "@openlife/core";',
          'import "@openlife/contracts/http/errors";',
          'import "@openlife/sqlite/driver-probe";',
          'import "@openlife/widgets/definitions";',
          'import "node:http";',
        ].join("\n"),
        "packages/core/src/index.ts": 'import "./modules/registries/public.js";\nexport {};\n',
        "packages/core/src/modules/registries/public.ts": 'import "./application/create-record.js";\nexport {};\n',
        "packages/core/src/modules/registries/application/create-record.ts":
          'import "../domain/types.js";\nimport "../../identity/public.js";\nexport {};\n',
        "packages/core/src/modules/registries/domain/types.ts":
          "export const parseInstant = (iso: string): Date => new Date(iso);\n",
        "packages/core/src/modules/identity/public.ts": "export {};\n",
      },
    },
    expect: { kind: "clean" },
  },
  {
    id: "arch-01-cycle",
    description: "Two core files importing each other",
    workspace: {
      files: {
        "packages/core/src/index.ts": 'import "./a.js";\nexport {};\n',
        "packages/core/src/a.ts": 'import "./b.js";\nexport {};\n',
        "packages/core/src/b.ts": 'import "./a.js";\nexport {};\n',
      },
    },
    expect: violation("dependency-cruiser", "ARCH-01-no-circular", "packages/core/src/"),
  },
  {
    id: "arch-02-node-builtin-in-core",
    description: "core reads the filesystem directly",
    workspace: {
      files: { "packages/core/src/index.ts": 'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n' },
    },
    expect: violation("dependency-cruiser", "ARCH-02-core-imports-only-core", "packages/core/src/index.ts"),
  },
  {
    id: "arch-02-adapter-package-in-core",
    description: "core imports the SQLite adapter package",
    workspace: { files: { "packages/core/src/index.ts": 'import "@openlife/sqlite/driver-probe";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "ARCH-02-core-imports-only-core", "packages/core/src/index.ts"),
  },
  {
    id: "arch-02-clock-in-core",
    description: "core reads the wall clock instead of the Clock port",
    workspace: { files: { "packages/core/src/index.ts": "export const nowMs = (): number => Date.now();\n" } },
    expect: violation("eslint", "ARCH-02-core-no-ambient-io", "packages/core/src/index.ts"),
  },
  {
    id: "arch-02-env-in-core",
    description: "core reads process environment",
    workspace: { files: { "packages/core/src/index.ts": 'export const mode = process.env["MODE"];\n' } },
    expect: violation("eslint", "ARCH-02-core-no-ambient-io", "packages/core/src/index.ts"),
  },
  {
    id: "arch-03-web-imports-sqlite",
    description: "web imports the SQLite package directly",
    workspace: { files: { "apps/web/src/main.ts": 'import "@openlife/sqlite/driver-probe";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "ARCH-03-web-cannot-reach-server-runtime", "apps/web/src/main.ts"),
  },
  {
    id: "arch-03-web-reaches-sqlite-indirectly",
    description: "web → ui → sqlite → better-sqlite3: an indirect path into the server runtime",
    workspace: {
      externalModules: ["better-sqlite3"],
      files: {
        "apps/web/src/main.ts": 'import "@openlife/ui";\nexport {};\n',
        "packages/ui/src/index.ts": 'import "@openlife/sqlite/driver-probe";\nexport {};\n',
        "packages/sqlite/src/index.ts": 'import "better-sqlite3";\nexport {};\n',
      },
    },
    expect: violation("dependency-cruiser", "ARCH-03-web-cannot-reach-server-runtime", "apps/web/src/main.ts"),
  },
  {
    id: "arch-03-web-type-import-from-core",
    description: "A type-only import from core still crosses the web boundary",
    workspace: {
      files: {
        "packages/core/src/index.ts": "export type OwnerId = string;\n",
        "apps/web/src/main.ts": 'import type { OwnerId } from "@openlife/core";\nexport const owner: OwnerId = "x";\n',
      },
    },
    expect: violation("dependency-cruiser", "ARCH-03-web-cannot-reach-server-runtime", "apps/web/src/main.ts"),
  },
  {
    id: "arch-03-node-builtin-in-ui",
    description: "ui imports a Node built-in module",
    workspace: { files: { "packages/ui/src/index.ts": 'import "node:path";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "ARCH-03-browser-code-no-node-builtins", "packages/ui/src/index.ts"),
  },
  {
    id: "arch-04-relative-cross-package",
    description: "server reaches into core sources by relative path",
    workspace: { files: { "apps/server/src/main.ts": 'import "../../../packages/core/src/index.js";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "ARCH-04-no-cross-package-relative-import", "apps/server/src/main.ts"),
  },
  {
    id: "arch-04-unexported-subpath",
    description: "server deep-imports a path that core does not export",
    workspace: { files: { "apps/server/src/main.ts": 'import "@openlife/core/src/index.ts";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "ARCH-04-import-must-resolve-through-exports", "apps/server/src/main.ts"),
  },
  {
    id: "arch-04-core-module-internals",
    description: "A core module imports another module's private file instead of its public.ts",
    workspace: {
      files: {
        "packages/core/src/modules/registries/application/create-record.ts":
          'import "../../identity/domain/session.js";\nexport {};\n',
        "packages/core/src/modules/identity/domain/session.ts": "export {};\n",
        "packages/core/src/modules/identity/public.ts": "export {};\n",
      },
    },
    expect: violation(
      "dependency-cruiser",
      "ARCH-04-core-module-via-public-api",
      "packages/core/src/modules/registries/application/create-record.ts",
    ),
  },
  {
    id: "arch-04-web-feature-cross-import",
    description: "One web feature imports another feature",
    workspace: {
      files: {
        "apps/web/src/features/designer/index.ts": 'import "../registers/record-form.js";\nexport {};\n',
        "apps/web/src/features/registers/record-form.ts": "export {};\n",
      },
    },
    expect: violation("dependency-cruiser", "ARCH-04-web-features-isolated", "apps/web/src/features/designer/index.ts"),
  },
  {
    id: "arch-04-computed-dynamic-import",
    description: "A dynamic import with a computed specifier hides the dependency",
    workspace: {
      files: {
        "apps/server/src/main.ts":
          'const target = ["@openlife", "sqlite"].join("/");\nexport const load = () => import(target);\n',
      },
    },
    expect: violation("eslint", "ARCH-04-no-computed-dynamic-import", "apps/server/src/main.ts"),
  },
  {
    id: "arch-05-test-support-in-production",
    description: "Production server code imports test support",
    workspace: {
      files: {
        "apps/server/src/main.ts": 'import "../../../tests/support/fake-clock.js";\nexport {};\n',
        "tests/support/fake-clock.ts": "export {};\n",
      },
    },
    expect: violation("dependency-cruiser", "ARCH-05-no-test-code-in-production", "apps/server/src/main.ts"),
  },
  {
    id: "arch-05-test-file-in-production",
    description: "A production module imports a co-located test file",
    workspace: {
      files: {
        "packages/contracts/src/index.ts": 'import "./index.test.js";\nexport {};\n',
        "packages/contracts/src/index.test.ts": "export {};\n",
      },
    },
    expect: violation("dependency-cruiser", "ARCH-05-no-test-code-in-production", "packages/contracts/src/index.ts"),
  },
  {
    id: "boundary-contracts-imports-core",
    description: "contracts depends on core",
    workspace: { files: { "packages/contracts/src/index.ts": 'import "@openlife/core";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "boundary-contracts-only-contracts", "packages/contracts/src/index.ts"),
  },
  {
    id: "boundary-sqlite-imports-contracts",
    description: "sqlite depends on HTTP contracts",
    workspace: { files: { "packages/sqlite/src/index.ts": 'import "@openlife/contracts/http/errors";\nexport {};\n' } },
    expect: violation(
      "dependency-cruiser",
      "boundary-sqlite-no-presentation-or-transport",
      "packages/sqlite/src/index.ts",
    ),
  },
  {
    id: "boundary-widget-definitions-import-react",
    description: "Widget definitions import React",
    workspace: {
      externalModules: ["react"],
      files: { "packages/widgets/src/definitions.ts": 'import "react";\nexport {};\n' },
    },
    expect: violation("dependency-cruiser", "boundary-widgets-definitions-pure", "packages/widgets/src/definitions.ts"),
  },
  {
    id: "boundary-widget-definitions-import-views",
    description: "Widget definitions import the views entrypoint",
    workspace: { files: { "packages/widgets/src/definitions.ts": 'import "./views.js";\nexport {};\n' } },
    expect: violation(
      "dependency-cruiser",
      "boundary-widgets-definitions-not-views",
      "packages/widgets/src/definitions.ts",
    ),
  },
  {
    id: "boundary-widget-views-import-core",
    description: "Widget views import core instead of receiving data via props",
    workspace: { files: { "packages/widgets/src/views.ts": 'import "@openlife/core";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "boundary-widgets-views-browser-only", "packages/widgets/src/views.ts"),
  },
  {
    id: "boundary-ui-imports-contracts",
    description: "ui imports another product package",
    workspace: { files: { "packages/ui/src/index.ts": 'import "@openlife/contracts/http/errors";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "boundary-ui-standalone", "packages/ui/src/index.ts"),
  },
  {
    id: "boundary-server-imports-ui",
    description: "server imports presentational ui code",
    workspace: { files: { "apps/server/src/main.ts": 'import "@openlife/ui";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "boundary-server-no-browser-code", "apps/server/src/main.ts"),
  },
  {
    id: "boundary-updater-imports-core",
    description: "updater imports core instead of the update protocol",
    workspace: { files: { "apps/updater/src/main.ts": 'import "@openlife/core";\nexport {};\n' } },
    expect: violation("dependency-cruiser", "boundary-updater-protocol-only", "apps/updater/src/main.ts"),
  },
];
