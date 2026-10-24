import { spawnSync } from "node:child_process";
import { blockCheck } from "./check-report.ts";
import type { RunResult } from "./repository-copy.ts";

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

export type DockerArch = "amd64" | "arm64";

/** Runs the docker CLI without a shell; a missing CLI stops the check as blocked. */
export function docker(args: readonly string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): RunResult {
  const result = spawnSync("docker", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    blockCheck("the docker CLI is not installed");
  }
  if (result.error) {
    throw result.error;
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Docker architecture name of the host this process runs on. */
export function hostDockerArch(): DockerArch | undefined {
  if (process.arch === "x64") {
    return "amd64";
  }
  return process.arch === "arm64" ? "arm64" : undefined;
}

/** Node's process.arch inside a linux/<arch> container. */
export function nodeArchFor(arch: DockerArch): string {
  return arch === "amd64" ? "x64" : "arm64";
}
