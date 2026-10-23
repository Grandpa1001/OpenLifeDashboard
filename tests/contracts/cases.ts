// Negative controls for scripts/check-contracts.ts: each mutation of a real manifest must be
// rejected with the expected problem code. Mutations run in memory; files are never changed.
import type { ManifestProblemCode } from "../../scripts/support/manifest-policy.ts";
import type { JsonObject } from "../../scripts/support/workspaces.ts";

export type ManifestCase = Readonly<{
  id: string;
  /** Real manifest used as the starting point: packages/core or apps/server. */
  base: "package" | "app";
  mutate: (manifest: JsonObject) => JsonObject;
  expect: ManifestProblemCode;
}>;

const coreExport = (overrides: JsonObject): JsonObject => ({
  "@openlife/source": "./src/index.ts",
  types: "./dist/index.d.ts",
  default: "./dist/index.js",
  ...overrides,
});

export const manifestCases: readonly ManifestCase[] = [
  {
    id: "wildcard-export",
    base: "package",
    mutate: (m) => ({ ...m, exports: { "./*": coreExport({ "@openlife/source": "./src/*.ts" }) } }),
    expect: "wildcard-export",
  },
  {
    id: "missing-source-condition",
    base: "package",
    mutate: (m) => ({ ...m, exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }),
    expect: "export-conditions",
  },
  {
    id: "conditions-out-of-order",
    base: "package",
    mutate: (m) => ({
      ...m,
      exports: { ".": { "@openlife/source": "./src/index.ts", default: "./dist/index.js", types: "./dist/index.d.ts" } },
    }),
    expect: "export-conditions",
  },
  {
    id: "build-output-mismatch",
    base: "package",
    mutate: (m) => ({ ...m, exports: { ".": coreExport({ types: "./dist/other.d.ts" }) } }),
    expect: "export-paths",
  },
  {
    id: "source-file-missing",
    base: "package",
    mutate: (m) => ({
      ...m,
      exports: {
        ".": coreExport({
          "@openlife/source": "./src/missing.ts",
          types: "./dist/missing.d.ts",
          default: "./dist/missing.js",
        }),
      },
    }),
    expect: "export-source-missing",
  },
  {
    id: "library-without-exports",
    base: "package",
    mutate: (m) => Object.fromEntries(Object.entries(m).filter(([key]) => key !== "exports")),
    expect: "library-without-exports",
  },
  {
    id: "legacy-main-field",
    base: "package",
    mutate: (m) => ({ ...m, main: "./dist/index.js" }),
    expect: "legacy-entry-field",
  },
  {
    id: "caret-dependency-range",
    base: "package",
    mutate: (m) => ({ ...m, devDependencies: { typescript: "^6.0.3" } }),
    expect: "dependency-range",
  },
  {
    id: "workspace-dependency-by-version",
    base: "app",
    mutate: (m) => ({ ...m, dependencies: { "@openlife/contracts": "0.0.0" } }),
    expect: "dependency-range",
  },
  {
    id: "name-not-matching-directory",
    base: "package",
    mutate: (m) => ({ ...m, name: "@openlife/domain" }),
    expect: "name-mismatch",
  },
  {
    id: "public-package",
    base: "package",
    mutate: (m) => ({ ...m, private: false }),
    expect: "not-private",
  },
  {
    id: "commonjs-package",
    base: "package",
    mutate: (m) => ({ ...m, type: "commonjs" }),
    expect: "not-esm",
  },
  {
    id: "app-with-exports",
    base: "app",
    mutate: (m) => ({ ...m, exports: { ".": coreExport({}) } }),
    expect: "app-with-exports",
  },
];
