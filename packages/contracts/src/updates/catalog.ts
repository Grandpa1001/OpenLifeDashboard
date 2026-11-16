// The trusted catalog of releases, `control/release-catalog.json` (Architektura §11.2.1; D54.1). The application names a
// release by its version only; the updater finds the images of that version here and nowhere else, so the digest it
// pulls and checks is never one a client supplied. The installer (D61) or the administrator writes the file and the
// updater only reads it, within a bound on its size and with the hash of its text; a file that is too large, not whole
// or not of this shape is no catalog. The hash is made by the updater with `node:crypto`; the contract holds the shape.
import { z } from "zod";
import { releaseVersionSchema } from "./protocol.js";
import { imageDigestSchema } from "./state.js";

export const RELEASE_CATALOG_FILE = "release-catalog.json";
/** A catalog of a few hundred releases is a few hundred lines; more is not this file. */
export const RELEASE_CATALOG_MAX_BYTES = 64 * 1024;
export const RELEASE_CATALOG_MAX_RELEASES = 500;

/** A repository of images and the digest of one image in it; the updater checks the shape of the repository again before it uses it. */
export const catalogPinSchema = z.object({ repository: z.string().min(1).max(255), digest: imageDigestSchema }).strict();

export const catalogReleaseSchema = z
  .object({
    version: releaseVersionSchema,
    app: catalogPinSchema,
    /** The image of the updater when the release replaces it, otherwise the updater of the installation stays. */
    updater: catalogPinSchema.nullable(),
    /** The oldest version that may update to this one directly; null when any may. */
    minFrom: releaseVersionSchema.nullable(),
    /** The version of the schema of the database the release writes, kept in the record to tell a rollback what it returns to. */
    schemaVersion: z.number().int().min(0),
  })
  .strict();
export type CatalogRelease = z.infer<typeof catalogReleaseSchema>;

export const releaseCatalogSchema = z
  .object({ v: z.literal(1), releases: z.array(catalogReleaseSchema).max(RELEASE_CATALOG_MAX_RELEASES) })
  .strict()
  .refine((catalog) => new Set(catalog.releases.map((release) => release.version)).size === catalog.releases.length, { message: "a version is listed once" });
export type ReleaseCatalog = z.infer<typeof releaseCatalogSchema>;

/** The file: the catalog and the hash of its canonical text, so a torn or changed file is not mistaken for a catalog. */
export const releaseCatalogFileSchema = z.object({ catalog: releaseCatalogSchema, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type ReleaseCatalogFile = z.infer<typeof releaseCatalogFileSchema>;
