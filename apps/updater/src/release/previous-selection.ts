// The choice of the release before an operation (Architektura §11.2.2; D54.2): the pins a rollback must put back. They are
// read from `control/compose.release.yml` when the installation has it, otherwise from the image of the app that runs when
// that is pinned by a digest; an installation that has neither has nothing the updater could go back to, and says so.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UpdateRecord } from "@openlife/contracts/updates/state";
import type { ProjectScope } from "../docker/project-scope.js";
import { isPinnedImage } from "../docker/project-scope.js";
import { RELEASE_FILE_NAME, readReleaseFile } from "./release-file.js";

export type PreviousSelection = NonNullable<UpdateRecord["previousSelection"]>;
const DIGEST_OF_IMAGE = /@(sha256:[0-9a-f]{64})$/;

export function createPreviousSelection(options: { controlDir: string; scope: Pick<ProjectScope, "findApp" | "inspectApp"> }): () => Promise<PreviousSelection | null> {
  return async () => {
    try {
      const file = readReleaseFile(readFileSync(path.join(options.controlDir, RELEASE_FILE_NAME), "utf8"));
      if (file.ok) return { app: file.selection.app.digest, updater: file.selection.updater?.digest ?? null };
    } catch {
      // No file: the image that runs is the only other witness.
    }
    try {
      const app = await options.scope.findApp();
      const image = (await options.scope.inspectApp(app.id)).Config["Image"];
      const digest = typeof image === "string" && isPinnedImage(image) ? DIGEST_OF_IMAGE.exec(image)?.[1] : undefined;
      return digest === undefined ? null : { app: digest, updater: null };
    } catch {
      return null;
    }
  };
}
