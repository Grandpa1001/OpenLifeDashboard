// D01.1-AC1/AC3 (--through=build) and the D01 smoke (--through=all): a fresh copy of the
// repository installs from the frozen lockfile on the declared Node and builds every package.
import path from "node:path";
import { readExports } from "../../scripts/support/manifest-policy.ts";
import { isFile, isJsonObject, listWorkspaces, readJsonObject } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, removeCopy, repoRoot, runPnpm } from "../support/repository-copy.ts";

/** The five packages required by Architektura §13 / DEV D01.1. */
const REQUIRED_PACKAGES = ["contracts", "core", "sqlite", "ui", "widgets"];
const SMOKE_SCRIPTS = ["typecheck", "lint", "check:architecture", "check:contracts"];

const through = process.argv.find((arg) => arg.startsWith("--through="))?.slice("--through=".length);
if (through !== "build" && through !== "all") {
  throw new Error("Usage: clean-checkout.ts --through=build|all");
}

const check = createCheck(`clean checkout (${through})`);
const copy = copyRepository();
try {
  const install = runPnpm(["install", "--frozen-lockfile", "--prefer-offline"], copy);
  if (check.expect(install.status === 0, "pnpm install --frozen-lockfile exits 0", install.output)) {
    const engines = readJsonObject(path.join(repoRoot, "package.json"))["engines"];
    const declaredNode = isJsonObject(engines) ? String(engines["node"]) : "(undeclared)";
    const node = runPnpm(["exec", "node", "--version"], copy).output.trim();
    check.expect(node === `v${declaredNode}`, `scripts run on the declared Node ${declaredNode} (got ${node})`);

    const build = runPnpm(["-r", "build"], copy);
    check.expect(build.status === 0, "pnpm -r build exits 0", build.output);

    const workspaces = listWorkspaces(copy);
    const packages = workspaces.filter((workspace) => workspace.kind === "package").map((w) => w.dir.split("/")[1]);
    check.expect(
      REQUIRED_PACKAGES.every((name) => packages.includes(name)),
      `workspace has the five packages (${packages.join(", ")})`,
    );
    const missing = workspaces.flatMap((workspace) => {
      const outputs =
        workspace.kind === "app"
          ? ["dist/main.js"]
          : readExports(workspace.manifest).flatMap((entry) => [entry.types.slice(2), entry.runtime.slice(2)]);
      return outputs.map((file) => `${workspace.dir}/${file}`).filter((file) => !isFile(path.join(copy, file)));
    });
    check.expect(
      missing.length === 0 && workspaces.length >= REQUIRED_PACKAGES.length,
      `build output exists for all ${workspaces.length} workspaces`,
      missing.join("\n"),
    );

    if (through === "all") {
      for (const script of SMOKE_SCRIPTS) {
        const result = runPnpm(["run", script], copy);
        check.expect(result.status === 0, `pnpm ${script} exits 0`, result.output);
      }
    }
  }
} finally {
  removeCopy(copy);
}
check.finish();
