// Lint rules that complement the import graph checks in tooling/dependency-cruiser.
// Architecture messages start with "[<rule id>]" so negative controls can assert them.
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const PRODUCT_SOURCES = ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"];
const CORE_SOURCES = ["packages/core/src/**/*.{ts,tsx}"];

// A computed specifier hides the dependency from the import graph (Architektura §13.3).
const computedDynamicImport = {
  selector: "ImportExpression[source.type!='Literal']",
  message: "[ARCH-04-no-computed-dynamic-import] Dynamic import needs a string literal so boundaries can be checked.",
};

// Time, randomness, environment and I/O are injected into core (Architektura §13.5 pt 5).
const coreAmbient = "[ARCH-02-core-no-ambient-io]";

export default defineConfig(
  { ignores: ["**/dist/**", "**/.tsbuild/**", "**/node_modules/**", "Analiza/**", ".artifacts/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly" } },
  },
  {
    files: PRODUCT_SOURCES,
    rules: {
      "no-restricted-syntax": ["error", computedDynamicImport],
    },
  },
  {
    files: CORE_SOURCES,
    rules: {
      "no-restricted-syntax": [
        "error",
        computedDynamicImport,
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: `${coreAmbient} Read the current time from the injected Clock port.`,
        },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: `${coreAmbient} Use the injected Clock port.` },
        { object: "Math", property: "random", message: `${coreAmbient} Use an injected generator.` },
      ],
      "no-restricted-globals": [
        "error",
        ...["process", "Buffer", "crypto", "fetch", "require", "globalThis"].map((name) => ({
          name,
          message: `${coreAmbient} Environment, I/O and randomness reach core only through ports.`,
        })),
      ],
    },
  },
);
