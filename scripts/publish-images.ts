// The two steps of the publication of the images of a release (scripts/support/image-publish.ts; DEV §9.60 D61.1):
//   node scripts/publish-images.ts build --registry <host/owner> --version <x.y.z> --revision <commit> --platform <linux/amd64|linux/arm64> --out <file>
//   node scripts/publish-images.ts merge --registry <host/owner> --version <x.y.z> --revision <commit> --out <file> <file of build>...
// `build` runs once on a runner of each architecture; `merge` runs once, after all of them, and writes the pinned names of the two indexes.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAndPushPlatform, mergePlatforms, PLATFORMS, type Platform, type PlatformResult } from "./support/image-publish.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: publish-images build|merge --registry <host/owner> --version <x.y.z> --revision <commit> [--platform <linux/amd64|linux/arm64>] --out <file> [<build result>...]";

function valueOf(args: readonly string[], flag: string): string {
  const at = args.indexOf(flag);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} is required\n${USAGE}`);
  return value;
}

function isPlatform(value: string): value is Platform {
  return Object.hasOwn(PLATFORMS, value);
}

try {
  const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
  const options = { repositoryRoot: root, registry: valueOf(args, "--registry"), version: valueOf(args, "--version"), revision: valueOf(args, "--revision") };
  const out = path.resolve(valueOf(args, "--out"));
  if (command === "build") {
    const platform = valueOf(args, "--platform");
    if (!isPlatform(platform)) throw new Error(`the platform must be linux/amd64 or linux/arm64, got: ${platform}`);
    const result = buildAndPushPlatform({ ...options, platform });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`built and pushed ${platform}: app ${result.digests.app}, updater ${result.digests.updater}`);
  } else if (command === "merge") {
    const files = args.filter((arg, index) => !arg.startsWith("--") && !["--registry", "--version", "--revision", "--out", "--platform"].includes(args[index - 1] ?? ""));
    const results = files.map((file) => JSON.parse(readFileSync(path.resolve(file), "utf8")) as PlatformResult);
    const published = mergePlatforms({ ...options, results });
    writeFileSync(out, `${JSON.stringify(published, null, 2)}\n`);
    console.log(`published ${published.version}: app ${published.app}, updater ${published.updater}`);
  } else {
    throw new Error(USAGE);
  }
} catch (error) {
  console.error(`publish-images: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
