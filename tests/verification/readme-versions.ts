// D08.3: the "Verified runtime" table of README.md names the versions that are really pinned: the
// Node runtime (.node-version, package.json), pnpm (packageManager), the base image
// (docker/Dockerfile) and every package it lists from the pnpm catalog. A row that drifts from
// its source, or a source version missing from its row, fails. Versions only observed at run time
// (SQLite, Docker Engine) come from the reports and are not checked here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isJsonObject, readJsonObject } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { repoRoot } from "../support/repository-copy.ts";

const read = (file: string): string => readFileSync(path.join(repoRoot, file), "utf8");
const manifest = readJsonObject(path.join(repoRoot, "package.json"));
const workspace: unknown = parse(read("pnpm-workspace.yaml"));
const catalog = isJsonObject(workspace) && isJsonObject(workspace["catalog"]) ? workspace["catalog"] : {};
const pinned = (name: string): string => String(catalog[name] ?? `${name} missing from the catalog`);

/** README row → the versions (as written in their sources) the row must contain. */
const ROWS: Readonly<Record<string, readonly string[]>> = {
  "Node.js": [read(".node-version").trim(), String(isJsonObject(manifest["engines"]) ? manifest["engines"]["node"] : "")],
  pnpm: [String(manifest["packageManager"]).replace(/^pnpm@/, "")],
  "Base image": [/ARG NODE_IMAGE=([^@\s]+)/.exec(read("docker/Dockerfile"))?.[1] ?? "NODE_IMAGE missing"],
  "SQLite driver": [`better-sqlite3 ${pinned("better-sqlite3")}`],
  "Writer lease": [`fs-native-extensions ${pinned("fs-native-extensions")}`],
  "HTTP server": [`hono ${pinned("hono")}`, `@hono/node-server ${pinned("@hono/node-server")}`],
  "Web app": ["react", "vite", "@tanstack/react-router", "i18next", "react-i18next"].map((name) => `${name} ${pinned(name)}`),
  Schemas: [`zod ${pinned("zod")}`],
  "Language and tests": ["typescript", "vitest", "@playwright/test", "@axe-core/playwright"].map((name) => `${name} ${pinned(name)}`),
};

const readme = read("README.md");
const section = readme.slice(readme.indexOf("### Verified runtime"));
const rows = new Map(
  section
    .split("\n")
    .map((line) => /^\| ([^|]+?) \| (.+) \|$/.exec(line))
    .flatMap((match) => (match?.[1] && match[2] ? [[match[1], match[2]] as const] : [])),
);

const check = createCheck("README verified runtime matches the pinned versions");
for (const [row, versions] of Object.entries(ROWS)) {
  const cell = rows.get(row);
  const missing = versions.filter((version) => !cell?.includes(version));
  check.expect(cell !== undefined && missing.length === 0, `${row}: ${versions.join(", ")}`, cell === undefined ? "row missing" : `row says: ${cell}`);
}
check.finish();
