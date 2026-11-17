// pnpm package:release -- --image <name@sha256:digest> [--version <x.y.z>] [--out <folder>]
// Builds the release package of the installer (scripts/support/release-package.ts): a folder and a
// .tar.gz with install.sh, the Compose files, release.json and SHA256SUMS. The version is the one
// of apps/server/package.json unless given; the image must be pinned by digest.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleasePackage } from "./support/release-package.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const image = valueOf(args, "--image");
  if (image === undefined) throw new Error("usage: package:release -- --image <name@sha256:digest> [--version <x.y.z>] [--out <folder>]");
  const version = valueOf(args, "--version") ?? (JSON.parse(readFileSync(path.join(root, "apps/server/package.json"), "utf8")) as { version: string }).version;
  const built = buildReleasePackage({ repositoryRoot: root, outDir: path.resolve(valueOf(args, "--out") ?? path.join(root, ".artifacts/release")), version, image });
  console.log(`release package ${version}: ${built.folder}\narchive: ${built.archive}`);
} catch (error) {
  console.error(`package:release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
