import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTAINER_PATHS } from "../../apps/server/src/adapters/filesystem/installation-paths.ts";
import { blockCheck } from "./check-report.ts";
import { prepareTestInstance, type TestInstance } from "./test-instance.ts";
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

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

export type NativeDocker = Readonly<{ arch: DockerArch; platform: string; serverVersion: string }>;

/**
 * The host's Docker, provided it runs containers of the host architecture. Anything else
 * (no CLI, no daemon, an emulated platform) stops the check as blocked, never passed.
 */
export function requireNativeDocker(cwd: string): NativeDocker {
  const arch = hostDockerArch();
  if (!arch) {
    blockCheck(`host architecture ${process.arch} has no supported linux image`);
  }
  const server = docker(["version", "--format", "{{.Server.Arch}} {{.Server.Version}}"], cwd);
  if (server.status !== 0) {
    blockCheck(`the docker daemon is not reachable:\n${server.output.trim()}`);
  }
  const [serverArch = "", serverVersion = ""] = server.output.trim().split(" ");
  if (serverArch !== arch) {
    blockCheck(`docker runs ${serverArch} containers on a ${arch} host; emulation is not accepted`);
  }
  return { arch, platform: `linux/${arch}`, serverVersion };
}

/** Builds docker/Dockerfile for the native platform; the build cache makes repeats cheap. */
export function buildAppImage(tag: string, platform: string, cwd: string): RunResult {
  return docker(["build", "--platform", platform, "-f", "docker/Dockerfile", "-t", tag, "."], cwd, BUILD_TIMEOUT_MS);
}

/**
 * A fresh test installation on the host. A container gets its environment, its folders and
 * instance.json through `containerInstanceArgs`: since D07.2 the image refuses to start without
 * real mounts of /data and /control/maintenance, so a test container always mounts them.
 */
export function hostTestInstance(): TestInstance {
  return prepareTestInstance(path.join(mkdtempSync(path.join(os.tmpdir(), "openlife-container-")), "instance"));
}

export type ContainerMounts = Readonly<{
  /** /data: the installation's data folder (default), the same read-only, or a tmpfs (options as for --tmpfs). */
  data?: "bind" | "read-only" | "none" | Readonly<{ tmpfs: string }>;
  /** /control/maintenance: the installation's folder (default), the same read-only, or no mount at all. */
  maintenance?: "bind" | "read-only" | "none";
}>;

/**
 * Arguments that give a container one installation: env file, the host user (so the bind mounts
 * are writable without chmod 777), the two writable mounts of Architektura §15.1 and instance.json
 * read-only. Variants are for the tests of what the preflight does with a bad mount.
 */
export function containerInstanceArgs(instance: TestInstance, mounts: ContainerMounts = {}): string[] {
  const data = mounts.data ?? "bind";
  const maintenance = mounts.maintenance ?? "bind";
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const bind = (source: string, target: string, mode: "bind" | "read-only" | "none"): string[] =>
    mode === "none" ? [] : ["--volume", `${source}:${target}${mode === "read-only" ? ":ro" : ""}`];
  return [
    "--env-file", instance.envFile,
    "--user", user,
    ...(typeof data === "object" ? ["--tmpfs", `/data:${data.tmpfs},mode=1777`] : bind(path.join(instance.dir, "data"), "/data", data)),
    ...bind(path.join(instance.dir, "control", "maintenance"), CONTAINER_PATHS.maintenance, maintenance),
    "--volume", `${instance.instanceFile}:${CONTAINER_PATHS.instanceFile}:ro`,
  ];
}
