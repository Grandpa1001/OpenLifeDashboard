// The manifest of a release, `release-manifest.json` (DEV §9.60 D61.2; Architektura Załącznik I): the one file that says which images a release is and
// what it may be installed over. It is published beside the package and the installer files, and its sums are in SHA256SUMS. The installer or the
// administrator turns it into one entry of the trusted catalog (`catalogReleaseFromManifest`), which is the only place the updater reads images from.
import { z } from "zod";
import { catalogPinSchema, type CatalogRelease } from "./catalog.js";
import { releaseVersionSchema } from "./protocol.js";

export const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const RELEASE_MANIFEST_MAX_BYTES = 8 * 1024;

const versionOrder = (version: string): number[] => version.split(".").map(Number);

/** True when the first version is lower than the second (both x.y.z). */
export function isOlderVersion(first: string, second: string): boolean {
  const [a, b] = [versionOrder(first), versionOrder(second)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

export const releaseManifestSchema = z
  .object({
    /** The version of this format. */
    v: z.literal(1),
    version: releaseVersionSchema,
    /** The commit the images were built from. */
    buildRevision: z.string().regex(/^[0-9a-f]{7,40}$/),
    /** The index of each image, pinned by its digest: the only name of the image a release has. */
    app: catalogPinSchema,
    updater: catalogPinSchema,
    /** The oldest version that may update to this one directly; null when any may (the first release). */
    minFrom: releaseVersionSchema.nullable(),
    /** The version of the schema of the database this release writes (the number of its migrations). */
    databaseSchemaVersion: z.number().int().min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.minFrom !== null && !isOlderVersion(manifest.minFrom, manifest.version)) {
      context.addIssue({ code: "custom", path: ["minFrom"], message: "minFrom must be a version older than the release" });
    }
    if (manifest.app.repository === manifest.updater.repository) {
      context.addIssue({ code: "custom", path: ["updater", "repository"], message: "the updater is an image of its own, not the repository of the app" });
    }
  });
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** The entry of the trusted catalog that this manifest makes: the pins of both images, minFrom and the schema of the database. */
export function catalogReleaseFromManifest(manifest: ReleaseManifest): CatalogRelease {
  return { version: manifest.version, app: manifest.app, updater: manifest.updater, minFrom: manifest.minFrom, schemaVersion: manifest.databaseSchemaVersion };
}
