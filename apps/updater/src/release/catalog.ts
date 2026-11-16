// The reader of the trusted catalog (Architektura §11.2.1; D54.1). The updater only reads `control/release-catalog.json`;
// it is the installer or the administrator who writes it. The file is a regular file (a link is refused), within the bound
// on its size, whole by its hash and of the shape of the contract, and every pin in it is a repository and a digest of the
// shape the release file accepts, so what is read can be pulled and pinned without a second look. Anything else is no
// catalog and nothing is pulled.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_CATALOG_FILE, RELEASE_CATALOG_MAX_BYTES, releaseCatalogFileSchema, type CatalogRelease, type ReleaseCatalog } from "@openlife/contracts/updates/catalog";
import { isDigest, isRepository } from "./release-file.js";

export type CatalogCode = "CATALOG_MISSING" | "CATALOG_TOO_LARGE" | "CATALOG_INVALID";
export type CatalogRead = Readonly<{ ok: true; catalog: ReleaseCatalog }> | Readonly<{ ok: false; code: CatalogCode }>;

const hashOf = (catalog: ReleaseCatalog): string => createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

/** The text of the file for a catalog, as the installer writes it: the catalog and the hash of it, one line. */
export const catalogFileTextOf = (catalog: ReleaseCatalog): string => `${JSON.stringify({ catalog, sha256: hashOf(catalog) })}\n`;

export function readCatalog(dir: string): CatalogRead {
  const file = path.join(dir, RELEASE_CATALOG_FILE);
  let size: number;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) return { ok: false, code: "CATALOG_INVALID" };
    size = stat.size;
  } catch {
    return { ok: false, code: "CATALOG_MISSING" };
  }
  if (size > RELEASE_CATALOG_MAX_BYTES) return { ok: false, code: "CATALOG_TOO_LARGE" };
  try {
    const text = readFileSync(file, "utf8");
    // The file may have grown between the look and the read.
    if (Buffer.byteLength(text, "utf8") > RELEASE_CATALOG_MAX_BYTES) return { ok: false, code: "CATALOG_TOO_LARGE" };
    const parsed = releaseCatalogFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.sha256 !== hashOf(parsed.data.catalog)) return { ok: false, code: "CATALOG_INVALID" };
    const pins = parsed.data.catalog.releases.flatMap((release) => [release.app, ...(release.updater === null ? [] : [release.updater])]);
    if (!pins.every((pin) => isRepository(pin.repository) && isDigest(pin.digest))) return { ok: false, code: "CATALOG_INVALID" };
    return { ok: true, catalog: parsed.data.catalog };
  } catch {
    return { ok: false, code: "CATALOG_INVALID" };
  }
}

/** The release of a version, or null: a version the catalog does not list is not a release of this installation. */
export const findRelease = (catalog: ReleaseCatalog, version: string): CatalogRelease | null => catalog.releases.find((release) => release.version === version) ?? null;
