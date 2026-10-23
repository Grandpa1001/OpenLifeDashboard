// Import boundaries of the product monorepo (Architektura §13.3, rules ARCH-01…05).
// Every rule name starts with the requirement it enforces so that negative controls in
// tests/architecture can assert which rule rejected a synthetic graph.
// Paths are relative to the directory the cruise runs from (the workspace root).

const WIDGET_VIEW_FILE = "^packages/widgets/src/(views\\.tsx?|.+/View\\.tsx)$";
const TEST_CODE =
  "^(tests|scripts|tooling|Analiza)/|\\.(test|spec)\\.[cm]?tsx?$|/(fixtures|test-support)/";
const SERVER_RUNTIME_PACKAGES =
  "(^|/)node_modules/(better-sqlite3|drizzle-orm|hono|@hono/[^/]+|better-auth)/";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "ARCH-01-no-circular",
      comment: "Product code must not contain dependency cycles.",
      severity: "error",
      from: { path: "^(apps|packages)/" },
      to: { circular: true },
    },
    {
      name: "ARCH-02-core-imports-only-core",
      comment: "core holds pure rules and use cases: no frameworks, adapters, Node built-ins or other packages.",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { pathNot: "^packages/core/" },
    },
    {
      name: "ARCH-03-web-cannot-reach-server-runtime",
      comment: "Nothing reachable from the web app may pull in core, SQLite, server/updater code or their libraries.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: {
        path: `^(packages/(core|sqlite)|apps/(server|updater))/|${SERVER_RUNTIME_PACKAGES}`,
        reachable: true,
      },
    },
    {
      name: "ARCH-03-browser-code-no-node-builtins",
      comment: "Browser code (web, ui, widget views) must not import Node built-in modules.",
      severity: "error",
      from: { path: `^(apps/web|packages/ui)/|${WIDGET_VIEW_FILE}` },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "ARCH-04-no-cross-package-relative-import",
      comment: "Other workspaces are imported by package name through their exports, never by relative path.",
      severity: "error",
      from: { path: "^(apps|packages)/([^/]+)/" },
      to: { path: "^(apps|packages)/", pathNot: "^$1/$2/", dependencyTypes: ["local"] },
    },
    {
      name: "ARCH-04-import-must-resolve-through-exports",
      comment: "An import that does not resolve is either a typo or a deep import outside package exports.",
      severity: "error",
      from: { path: "^(apps|packages)/" },
      to: { couldNotResolve: true },
    },
    {
      name: "ARCH-04-core-module-via-public-api",
      comment: "A core module uses another module only through its public.ts.",
      severity: "error",
      from: { path: "^packages/core/src/modules/([^/]+)/" },
      to: {
        path: "^packages/core/src/modules/",
        pathNot: "^packages/core/src/modules/($1/|[^/]+/public\\.ts$)",
      },
    },
    {
      name: "ARCH-04-web-features-isolated",
      comment: "Web feature modules do not import each other; shared presentation belongs to ui.",
      severity: "error",
      from: { path: "^apps/web/src/features/([^/]+)/" },
      to: { path: "^apps/web/src/features/", pathNot: "^apps/web/src/features/$1/" },
    },
    {
      name: "ARCH-05-no-test-code-in-production",
      comment: "Production sources never import tests, scripts, tooling, fixtures or the specification.",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: "\\.(test|spec)\\.[cm]?tsx?$" },
      to: { path: TEST_CODE },
    },
    {
      name: "boundary-contracts-only-contracts",
      comment: "contracts depends only on itself and Zod: no core, Node, React or SQL.",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { pathNot: "^packages/contracts/|(^|/)node_modules/zod/" },
    },
    {
      name: "boundary-sqlite-no-presentation-or-transport",
      comment: "sqlite implements core ports; it does not depend on apps, ui, widgets or contracts.",
      severity: "error",
      from: { path: "^packages/sqlite/" },
      to: { path: "^(apps|packages/(contracts|ui|widgets))/" },
    },
    {
      name: "boundary-widgets-definitions-pure",
      comment: "Widget definitions use only contracts, Zod and other definitions: no React, Node, core, sqlite or ui.",
      severity: "error",
      from: { path: "^packages/widgets/", pathNot: WIDGET_VIEW_FILE },
      to: {
        pathNot: `^packages/(contracts|widgets)/src/|(^|/)node_modules/zod/`,
      },
    },
    {
      name: "boundary-widgets-definitions-not-views",
      comment: "Definitions are loaded by the server and must not import widget views.",
      severity: "error",
      from: { path: "^packages/widgets/", pathNot: WIDGET_VIEW_FILE },
      to: { path: WIDGET_VIEW_FILE },
    },
    {
      name: "boundary-widgets-views-browser-only",
      comment: "Widget views get data and callbacks via props: no core, sqlite or app code.",
      severity: "error",
      from: { path: WIDGET_VIEW_FILE },
      to: { path: "^(apps|packages/(core|sqlite))/" },
    },
    {
      name: "boundary-ui-standalone",
      comment: "ui is presentational: it imports no other product package.",
      severity: "error",
      from: { path: "^packages/ui/" },
      to: { path: "^(apps|packages/(contracts|core|sqlite|widgets))/" },
    },
    {
      name: "boundary-server-no-browser-code",
      comment: "The server uses core, contracts, sqlite and widget definitions, never web, ui or widget views.",
      severity: "error",
      from: { path: "^apps/server/" },
      to: { path: `^(apps/(web|updater)|packages/ui)/|${WIDGET_VIEW_FILE}` },
    },
    {
      name: "boundary-updater-protocol-only",
      comment: "The updater talks to the app through contracts only.",
      severity: "error",
      from: { path: "^apps/updater/" },
      to: { path: "^(apps/(server|web)|packages/(core|sqlite|ui|widgets))/" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "(^|/)dist/" },
    // Type-only imports cross boundaries too (web must not even reference core types).
    tsPreCompilationDeps: true,
    moduleSystems: ["es6", "cjs"],
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      // Workspace packages expose their TypeScript sources under this condition, so the
      // graph is checked on src/ instead of build output.
      conditionNames: ["@openlife/source", "import", "require", "node", "default"],
      mainFields: ["module", "main"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
