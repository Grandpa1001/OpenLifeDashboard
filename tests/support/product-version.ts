// The version of the product as the packages carry it. Release Please raises it in the pull request of a release, so a test that needs "the version the
// application reports" or "the version that is not newer than it" reads it here and never writes 0.0.0 or 0.1.0 in its own text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./repository-copy.ts";

export const PRODUCT_VERSION = (JSON.parse(readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8")) as { version: string }).version;
/** The version as a pattern for a regular expression (the dots are not any character). */
export const PRODUCT_VERSION_PATTERN = PRODUCT_VERSION.replaceAll(".", "\\.");
