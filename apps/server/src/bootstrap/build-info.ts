// Identity of the running build for snapshot metadata (Architektura §11.4): the version of the
// server package and the source revision the image was built from. The revision comes from
// build-info.json, written by the image build (docker/Dockerfile, ARG BUILD_REVISION); a source
// checkout has none and reports "unknown" instead of inventing one. A published image digest
// reaches the app only through the release manifest (D52/D61), so it is null here.
import { readFileSync } from "node:fs";
import type { AppBuild } from "../adapters/filesystem/database-snapshots.js";

/** apps/server next to dist/ both in the workspace and in the image. */
const SERVER_PACKAGE = new URL("../../package.json", import.meta.url);
const BUILD_INFO = new URL("../../build-info.json", import.meta.url);
const UNKNOWN_REVISION = "unknown";

function readJson(url: URL): unknown {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  const field = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
}

export function readBuildInfo(): AppBuild {
  const appVersion = stringField(readJson(SERVER_PACKAGE), "version");
  if (appVersion === undefined) {
    throw new Error("apps/server/package.json has no readable version");
  }
  return { appVersion, buildRevision: stringField(readJson(BUILD_INFO), "buildRevision") ?? UNKNOWN_REVISION, imageDigest: null };
}
