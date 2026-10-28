// D18.1 — a widget view is given its data and its callbacks and fetches nothing (Architektura §18.3,
// AR14). The built view is read for what it must not contain.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const built = readFileSync(path.join(root, "packages/widgets/dist/register-table/View.js"), "utf8");

describe("D18.1 the register table view", () => {
  it("has no way to fetch, no query client, no storage, no router and no import of the application", () => {
    for (const forbidden of ["fetch(", "XMLHttpRequest", "WebSocket", "EventSource", "QueryClient", "useQuery", "localStorage", "sessionStorage", "indexedDB", "@tanstack", "i18next", "react-i18next", "features/registers", "@openlife/core", "@openlife/sqlite"]) {
      expect(built.includes(forbidden), forbidden).toBe(false);
    }
  });

  it("imports React and nothing of the product but nothing runtime: the contracts are types only", () => {
    const specifiers = [...built.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
    for (const specifier of specifiers) expect(specifier === "react/jsx-runtime" || specifier === "react", specifier).toBe(true);
  });
});
