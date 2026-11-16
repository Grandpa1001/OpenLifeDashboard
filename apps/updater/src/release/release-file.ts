// The choice of a release on disk, `control/compose.release.yml` (Architektura §11.2.1; D52.3). It is the last
// file of `COMPOSE_FILE`, so a plain `docker compose up -d` from the installation folder starts exactly the
// release that was installed, also after a restart of the host. It holds nothing but `services.app.image` and,
// when the release replaces it, `services.updater.image`, each a full image pinned by its digest: the file is
// generated from values the updater has checked, never from a text of a client, and what is generated is
// validated again as text before it replaces the file, so no other YAML can be written through the API.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMap, isScalar, isAlias, parseAllDocuments, type Node } from "yaml";

export const RELEASE_FILE_NAME = "compose.release.yml";
/** The file is a few lines; more is not this file. */
export const RELEASE_FILE_MAX_BYTES = 4096;

/** A repository of images: an optional registry host with a port, and path parts of lower case letters, digits and `._-`. No tag, no digest, no scheme. */
const REPOSITORY = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PINNED = /^([a-z0-9][a-z0-9._:/-]*)@(sha256:[0-9a-f]{64})$/;

export type ImagePin = Readonly<{ repository: string; digest: string }>;
export type ReleaseSelection = Readonly<{ app: ImagePin; updater: ImagePin | null }>;

export const isRepository = (value: string): boolean => value.length <= 255 && REPOSITORY.test(value);
export const isDigest = (value: string): boolean => DIGEST.test(value);
export const imageOf = (pin: ImagePin): string => `${pin.repository}@${pin.digest}`;

export type ReleaseRefusal = "REPOSITORY_INVALID" | "DIGEST_INVALID" | "FILE_INVALID" | "WRITE_FAILED";

const refusalOf = (selection: ReleaseSelection): ReleaseRefusal | null => {
  for (const pin of [selection.app, ...(selection.updater === null ? [] : [selection.updater])]) {
    if (!isRepository(pin.repository)) return "REPOSITORY_INVALID";
    if (!isDigest(pin.digest)) return "DIGEST_INVALID";
  }
  return null;
};

/** The text of the file for a selection; the same selection always gives the same text. */
export function renderReleaseFile(selection: ReleaseSelection): Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; code: ReleaseRefusal }> {
  const refused = refusalOf(selection);
  if (refused !== null) return { ok: false, code: refused };
  const lines = ["services:", "  app:", `    image: ${JSON.stringify(imageOf(selection.app))}`];
  if (selection.updater !== null) lines.push("  updater:", `    image: ${JSON.stringify(imageOf(selection.updater))}`);
  return { ok: true, text: `${lines.join("\n")}\n` };
}

/**
 * Reads a text as the file it must be: one document, plain mappings, `services` with `app` and optionally `updater`,
 * each with one key `image` holding a repository and a digest; no anchor, alias, tag or merge, no other key at any level.
 */
export function readReleaseFile(text: string): Readonly<{ ok: true; selection: ReleaseSelection }> | Readonly<{ ok: false; code: "FILE_INVALID" }> {
  const invalid = { ok: false, code: "FILE_INVALID" } as const;
  if (Buffer.byteLength(text, "utf8") > RELEASE_FILE_MAX_BYTES) return invalid;
  const documents = parseAllDocuments(text, { uniqueKeys: true, merge: false });
  const document = documents[0];
  if (documents.length !== 1 || document === undefined || document.errors.length > 0 || document.warnings.length > 0) return invalid;
  let plain = true;
  const inspect = (node: Node | null | undefined): void => {
    if (node === null || node === undefined) return;
    if (isAlias(node) || node.anchor !== undefined || node.tag !== undefined) plain = false;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.anchor !== undefined || pair.key.tag !== undefined) plain = false;
        inspect(pair.value as Node | null);
      }
    } else if (!isScalar(node) || typeof node.value !== "string") {
      plain = false;
    }
  };
  inspect(document.contents);
  if (!plain) return invalid;
  const value: unknown = document.toJS();
  const only = (candidate: unknown, keys: readonly string[]): Record<string, unknown> | null =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && Object.keys(candidate).every((key) => keys.includes(key)) ? (candidate as Record<string, unknown>) : null;
  const root = only(value, ["services"]);
  const services = root === null ? null : only(root["services"], ["app", "updater"]);
  if (services === null || services["app"] === undefined) return invalid;
  const pinOf = (service: unknown): ImagePin | null => {
    const entry = only(service, ["image"]);
    const image = entry?.["image"];
    const match = typeof image === "string" ? PINNED.exec(image) : null;
    return match?.[1] !== undefined && match[2] !== undefined && isRepository(match[1]) ? { repository: match[1], digest: match[2] } : null;
  };
  const app = pinOf(services["app"]);
  const updater = services["updater"] === undefined ? null : pinOf(services["updater"]);
  if (app === null || (services["updater"] !== undefined && updater === null)) return invalid;
  return { ok: true, selection: { app, updater } };
}

/** The operations on the files, so a test can stop the write at any step. */
export type ReleaseFiles = Readonly<{
  writeFlushed: (file: string, text: string) => void;
  rename: (from: string, to: string) => void;
  flushDirectory: (dir: string) => void;
  remove: (file: string) => void;
  read: (file: string) => string;
}>;

export const nodeReleaseFiles: ReleaseFiles = {
  writeFlushed: (file, text) => {
    const fd = openSync(file, "wx", 0o644);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: (from, to) => renameSync(from, to),
  flushDirectory: (dir) => {
    if (process.platform === "win32") return;
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  remove: (file) => rmSync(file, { force: true }),
  read: (file) => readFileSync(file, "utf8"),
};

/** The hash of the text of a selection, to record in the journal which choice a file holds. */
export const selectionHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Writes the choice: the text is generated, written next to the file and flushed, read back and validated as the
 * file it must be and as the very selection asked for, and only then renamed over the file, so a crash leaves the
 * old choice or the new one and nothing that Compose could read as another.
 */
export function writeReleaseFile(controlDir: string, selection: ReleaseSelection, files: ReleaseFiles = nodeReleaseFiles): Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; code: ReleaseRefusal }> {
  const rendered = renderReleaseFile(selection);
  if (!rendered.ok) return rendered;
  const target = path.join(controlDir, RELEASE_FILE_NAME);
  const temporary = `${target}.tmp`;
  try {
    files.remove(temporary);
    files.writeFlushed(temporary, rendered.text);
    const back = readReleaseFile(files.read(temporary));
    if (!back.ok || JSON.stringify(back.selection) !== JSON.stringify(selection)) {
      files.remove(temporary);
      return { ok: false, code: "FILE_INVALID" };
    }
    files.rename(temporary, target);
    files.flushDirectory(controlDir);
  } catch {
    return { ok: false, code: "WRITE_FAILED" };
  }
  return { ok: true, text: rendered.text };
}

/**
 * Puts back the release file as it was before an update (D56.1): the text that was saved, validated as the file it must be and written the
 * way a choice is (next to the file, flushed, renamed), or no file when there was none. Nothing else can be written through it.
 */
export function restoreReleaseFile(controlDir: string, text: string | null, files: ReleaseFiles = nodeReleaseFiles): Readonly<{ ok: true }> | Readonly<{ ok: false; code: ReleaseRefusal }> {
  const target = path.join(controlDir, RELEASE_FILE_NAME);
  try {
    if (text === null) {
      files.remove(target);
      files.flushDirectory(controlDir);
      return { ok: true };
    }
    if (!readReleaseFile(text).ok) return { ok: false, code: "FILE_INVALID" };
    const temporary = `${target}.tmp`;
    files.remove(temporary);
    files.writeFlushed(temporary, text);
    files.rename(temporary, target);
    files.flushDirectory(controlDir);
    return { ok: true };
  } catch {
    return { ok: false, code: "WRITE_FAILED" };
  }
}
