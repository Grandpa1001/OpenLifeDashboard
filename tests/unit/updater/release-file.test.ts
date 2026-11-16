// D52.3 — the file of the chosen release (Architektura §11.2.1): generated from checked values, validated as text.
// AC1: a selection of an app, or of an app and an updater, is rendered as exactly the services.<name>.image pinned by
//      digest and nothing else, the same text every time, and the text reads back as the same selection; the write
//      goes through a temporary file that is read back and validated, then a rename.
// AC2: a tag in place of a digest, a short or upper case digest, a repository with a scheme, a tag, a space, a new
//      line or an upper case letter, an extra key at any level, an extra service, an anchor, an alias, a merge key,
//      a tag, a second document, a duplicated key, a value that is not text and a file over the size are refused
//      before anything is written, and a write that stops leaves the old file or the new one.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeReleaseFiles, readReleaseFile, renderReleaseFile, RELEASE_FILE_MAX_BYTES, RELEASE_FILE_NAME, writeReleaseFile, type ReleaseFiles, type ReleaseSelection } from "../../../apps/updater/src/release/release-file.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const APP = { repository: "ghcr.io/owner/openlife-app", digest: DIGEST_A };
const UPDATER = { repository: "ghcr.io/owner/openlife-updater", digest: DIGEST_B };
const folder = (): string => mkdtempSync(path.join(tmpdir(), "release-file-"));
const text = (selection: ReleaseSelection): string => {
  const rendered = renderReleaseFile(selection);
  if (!rendered.ok) throw new Error(rendered.code);
  return rendered.text;
};

describe("D52.3-AC1 the file holds the pinned images and nothing else", () => {
  it("renders an app alone and an app with an updater as the text the Compose override needs, always the same", () => {
    expect(text({ app: APP, updater: null })).toBe(`services:\n  app:\n    image: "ghcr.io/owner/openlife-app@${DIGEST_A}"\n`);
    expect(text({ app: APP, updater: UPDATER })).toBe(`services:\n  app:\n    image: "ghcr.io/owner/openlife-app@${DIGEST_A}"\n  updater:\n    image: "ghcr.io/owner/openlife-updater@${DIGEST_B}"\n`);
    expect(text({ app: APP, updater: UPDATER })).toBe(text({ app: { ...APP }, updater: { ...UPDATER } }));
  });

  it("reads the text back as the selection it came from, with a registry port and a path of several parts", () => {
    for (const selection of [{ app: APP, updater: null }, { app: APP, updater: UPDATER }, { app: { repository: "localhost:5000/team/openlife/app", digest: DIGEST_A }, updater: null }, { app: { repository: "openlife-app", digest: DIGEST_A }, updater: null }]) {
      expect(readReleaseFile(text(selection))).toEqual({ ok: true, selection });
    }
  });

  it("writes through a temporary file, replaces the old file whole and leaves only the file", () => {
    const dir = folder();
    writeFileSync(path.join(dir, RELEASE_FILE_NAME), 'services:\n  app:\n    image: "openlife-app:test"\n');
    const written = writeReleaseFile(dir, { app: APP, updater: null });
    expect(written).toEqual({ ok: true, text: text({ app: APP, updater: null }) });
    expect(readFileSync(path.join(dir, RELEASE_FILE_NAME), "utf8")).toBe(text({ app: APP, updater: null }));
    expect(readdirSync(dir)).toEqual([RELEASE_FILE_NAME]);
    expect(writeReleaseFile(dir, { app: { ...APP, digest: DIGEST_B }, updater: UPDATER }).ok).toBe(true);
    expect(readReleaseFile(readFileSync(path.join(dir, RELEASE_FILE_NAME), "utf8"))).toMatchObject({ ok: true, selection: { app: { digest: DIGEST_B }, updater: { digest: DIGEST_B } } });
  });
});

describe("D52.3-AC2 anything else is refused before anything is written", () => {
  it("refuses a repository or a digest that is not one, and writes nothing", () => {
    const dir = folder();
    for (const repository of ["ghcr.io/owner/app:1.2.3", "ghcr.io/owner/app@sha256:" + "a".repeat(64), "https://ghcr.io/owner/app", "ghcr.io/Owner/app", "ghcr.io/owner/app\n    ports:\n      - 22:22", "ghcr.io/owner/app ", "", "-bad/app", "ghcr.io//app", "ghcr.io/owner/app/", `${"a".repeat(300)}/app`, "ghcr.io/owner/a b"]) {
      expect(writeReleaseFile(dir, { app: { repository, digest: DIGEST_A }, updater: null }), JSON.stringify(repository)).toEqual({ ok: false, code: "REPOSITORY_INVALID" });
    }
    for (const digest of ["latest", "sha256:abc", `sha256:${"A".repeat(64)}`, `sha512:${"a".repeat(64)}`, `sha256:${"a".repeat(63)}g`, `${DIGEST_A}\n`, ""]) {
      expect(writeReleaseFile(dir, { app: { ...APP, digest }, updater: null }), digest).toEqual({ ok: false, code: "DIGEST_INVALID" });
    }
    expect(writeReleaseFile(dir, { app: APP, updater: { repository: "bad repo", digest: DIGEST_B } })).toEqual({ ok: false, code: "REPOSITORY_INVALID" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a text that is another YAML than the file: other keys, services, structure, anchors, tags, documents and types", () => {
    const image = `"ghcr.io/owner/app@${DIGEST_A}"`;
    const bad: Record<string, string> = {
      "a tag in place of a digest": `services:\n  app:\n    image: "ghcr.io/owner/app:1.2.3"\n`,
      "no app": `services:\n  updater:\n    image: ${image}\n`,
      "an extra key of the app": `services:\n  app:\n    image: ${image}\n    ports:\n      - "22:22"\n`,
      "an extra service": `services:\n  app:\n    image: ${image}\n  caddy:\n    image: ${image}\n`,
      "an extra top level key": `services:\n  app:\n    image: ${image}\nvolumes: {}\n`,
      "an environment": `services:\n  app:\n    image: ${image}\n    environment:\n      - A=1\n`,
      "an anchor": `services:\n  app: &a\n    image: ${image}\n`,
      "an alias": `x: &a\n  image: ${image}\nservices:\n  app: *a\n`,
      "a merge key": `services:\n  app:\n    <<: {image: ${image}}\n`,
      "a tag": `services:\n  app:\n    image: !!str ${image}\n`,
      "two documents": `services:\n  app:\n    image: ${image}\n---\nservices:\n  app:\n    image: ${image}\n`,
      "a duplicated key": `services:\n  app:\n    image: ${image}\n    image: ${image}\n`,
      "an image that is not text": `services:\n  app:\n    image: 12\n`,
      "an image of a list": `services:\n  app:\n    image:\n      - ${image}\n`,
      "a list of services": `services:\n  - app\n`,
      "a scalar": "services",
      "an empty text": "",
      "text that is not YAML": "services: [\n",
    };
    for (const [label, body] of Object.entries(bad)) expect(readReleaseFile(body), label).toEqual({ ok: false, code: "FILE_INVALID" });
    expect(readReleaseFile(`services:\n  app:\n    image: ${image}\n#${"x".repeat(RELEASE_FILE_MAX_BYTES)}\n`)).toEqual({ ok: false, code: "FILE_INVALID" });
  });

  it("leaves the old file or the new one after a stop at each step of the write, and removes a temporary file that does not read back", () => {
    const old = text({ app: APP, updater: null });
    const next = text({ app: { ...APP, digest: DIGEST_B }, updater: null });
    for (let stop = 1; stop <= 4; stop += 1) {
      const dir = folder();
      writeFileSync(path.join(dir, RELEASE_FILE_NAME), old);
      let step = 0;
      const tick = (): void => {
        step += 1;
        if (step === stop) throw new Error("stop");
      };
      const files: ReleaseFiles = {
        remove: (file) => (tick(), nodeReleaseFiles.remove(file)),
        writeFlushed: (file, body) => (tick(), nodeReleaseFiles.writeFlushed(file, body)),
        read: (file) => nodeReleaseFiles.read(file),
        rename: (from, to) => (tick(), nodeReleaseFiles.rename(from, to)),
        flushDirectory: (target) => (tick(), nodeReleaseFiles.flushDirectory(target)),
      };
      const result = writeReleaseFile(dir, { app: { ...APP, digest: DIGEST_B }, updater: null }, files);
      expect(result.ok, `stop ${stop}`).toBe(false);
      const body = readFileSync(path.join(dir, RELEASE_FILE_NAME), "utf8");
      expect([old, next], `stop ${stop}`).toContain(body);
    }
    // A temporary file that reads back as another file is never renamed over the choice.
    const dir = folder();
    writeFileSync(path.join(dir, RELEASE_FILE_NAME), old);
    const tampering: ReleaseFiles = { ...nodeReleaseFiles, read: () => `services:\n  app:\n    image: "evil@${DIGEST_B}"\n    ports: ["22:22"]\n` };
    expect(writeReleaseFile(dir, { app: APP, updater: null }, tampering)).toEqual({ ok: false, code: "FILE_INVALID" });
    expect(readFileSync(path.join(dir, RELEASE_FILE_NAME), "utf8")).toBe(old);
    expect(readdirSync(dir)).toEqual([RELEASE_FILE_NAME]);
    mkdirSync(path.join(dir, "unused"));
  });
});
