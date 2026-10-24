// D01.2-AC3: in a test copy, the checks themselves exit nonzero for a forbidden graph
// (web → ui → sqlite with declared dependencies) and for a wildcard export, and running the
// synthetic controls leaves nothing behind in the copy or the temp directory.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listFiles } from "../../scripts/support/workspaces.ts";
import { createCheck } from "../support/check-report.ts";
import { copyRepository, countTempDirs, removeCopy, runNode, runPnpm } from "../support/repository-copy.ts";

const SYNTHETIC_PREFIX = "openlife-synthetic-";

function editManifest(copy: string, dir: string, edit: (manifest: Record<string, unknown>) => Record<string, unknown>): void {
  const file = path.join(copy, dir, "package.json");
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), null, 2));
}

const sourceFiles = (copy: string): string[] =>
  ["apps", "packages"].flatMap((dir) => listFiles(copy, dir)).filter((file) => !file.includes("/node_modules/") && !file.includes("/dist/"));

const check = createCheck("faulty graph and contract");
const copy = copyRepository();
try {
  writeFileSync(path.join(copy, "apps/web/src/main.tsx"), 'import "@openlife/ui";\nexport {};\n');
  writeFileSync(path.join(copy, "packages/ui/src/index.ts"), 'import "@openlife/sqlite/driver-probe";\nexport {};\n');
  editManifest(copy, "apps/web", (m) => ({ ...m, dependencies: { "@openlife/ui": "workspace:*" } }));
  editManifest(copy, "packages/ui", (m) => ({ ...m, dependencies: { "@openlife/sqlite": "workspace:*" } }));

  // The copy's manifests changed on purpose; pnpm defaults to a frozen lockfile when CI=true.
  const install = runPnpm(["install", "--no-frozen-lockfile", "--prefer-offline"], copy);
  if (check.expect(install.status === 0, "install with the declared workspace links exits 0", install.output)) {
    const filesBefore = sourceFiles(copy);
    const tempBefore = countTempDirs(SYNTHETIC_PREFIX);
    const architecture = runNode(["scripts/check-architecture.ts"], copy);
    check.expect(architecture.status === 1, `check:architecture exits 1 (got ${architecture.status})`, architecture.output);
    check.expect(
      architecture.output.includes("ARCH-03-web-cannot-reach-server-runtime: apps/web/src/main.tsx"),
      "the indirect path web → ui → sqlite is rejected by ARCH-03",
      architecture.output,
    );
    check.expect(
      JSON.stringify(sourceFiles(copy)) === JSON.stringify(filesBefore),
      "synthetic controls add no files to product sources",
    );
    check.expect(countTempDirs(SYNTHETIC_PREFIX) === tempBefore, "synthetic workspaces are removed from the temp dir");
  }

  editManifest(copy, "packages/core", (m) => ({
    ...m,
    exports: {
      ...(m["exports"] as Record<string, unknown>),
      "./*": { "@openlife/source": "./src/*.ts", types: "./dist/*.d.ts", default: "./dist/*.js" },
    },
  }));
  const contracts = runNode(["scripts/check-contracts.ts"], copy);
  check.expect(contracts.status === 1, `check:contracts exits 1 (got ${contracts.status})`, contracts.output);
  check.expect(contracts.output.includes("wildcard-export (packages/core)"), "the wildcard export is named", contracts.output);
} finally {
  removeCopy(copy);
}
check.finish();
