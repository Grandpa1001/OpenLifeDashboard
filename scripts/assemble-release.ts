// node scripts/assemble-release.ts --version <x.y.z> --images <release-images.json of publish-images merge> [--min-from <x.y.z>] --out <folder>
// Makes the folder of the files a release is published with (scripts/support/release-assets.ts): from the digests of the images, the version and what the
// release may be installed over. Needs `pnpm -r build` (the manifest is checked with the schema of @openlife/contracts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PublishedImages } from "./support/image-publish.ts";
import { assembleRelease } from "./support/release-assets.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: assemble-release --version <x.y.z> --images <file> [--min-from <x.y.z>] --out <folder>";

function valueOf(args: readonly string[], flag: string, required = true): string | undefined {
  const at = args.indexOf(flag);
  const value = at < 0 ? undefined : args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    if (required || at >= 0) throw new Error(`${flag} is required\n${USAGE}`);
    return undefined;
  }
  return value;
}

try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const images = JSON.parse(readFileSync(path.resolve(valueOf(args, "--images") ?? ""), "utf8")) as PublishedImages;
  const built = assembleRelease({
    repositoryRoot: root,
    outDir: path.resolve(valueOf(args, "--out") ?? ""),
    version: valueOf(args, "--version") ?? "",
    minFrom: valueOf(args, "--min-from", false) ?? null,
    images,
  });
  console.log(`release ${built.manifest.version}: ${built.files.length} files in ${built.dir}`);
} catch (error) {
  console.error(`assemble-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
