// Runs in every vitest test file (vitest.config.ts setupFiles): the helpers' temporary folders
// are removed when the file's tests are done, not left to a process exit that never comes.
import { afterAll } from "vitest";
import { removeScratchDirs } from "./scratch.ts";

afterAll(removeScratchDirs);
