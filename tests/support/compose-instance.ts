// A test installation that Docker Compose can run (DEV D07.1): the isolated folder of
// prepareTestInstance (instance.json, keys, data/control layout) plus the compose files of
// docker/, a release override that pins an existing local image, and the installation keys of
// Architektura §14.4 in .env (PORT, the host user, COMPOSE_PROJECT_NAME and COMPOSE_FILE with the
// release file LAST). The installer (D19) takes this over. A non-empty folder is still refused.
import { randomInt } from "node:crypto";
import { appendFileSync, copyFileSync, constants, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { prepareTestInstance, type TestInstance } from "./test-instance.ts";
import { repoRoot } from "./repository-copy.ts";

export type ComposeInstanceOptions = Readonly<{
  /** An image that exists on this host, e.g. a tag built from docker/Dockerfile. */
  image: string;
  /** Host port of the local mode. */
  port: number;
  /** Host user of the bind mounts; defaults to the user running this process. */
  uid?: number;
  gid?: number;
  /** Extra .env lines, e.g. an optional option that must reach the app. */
  extraEnv?: Readonly<Record<string, string>>;
}>;

export type ComposeInstance = TestInstance &
  Readonly<{
    port: number;
    projectName: string;
    composeFiles: readonly string[];
  }>;

export const COMPOSE_FILES = ["compose.yml", "compose.local.yml", path.join("control", "compose.release.yml")] as const;
/** `;` on every system: the path separator of COMPOSE_FILE (Architektura §14.4). */
const COMPOSE_PATH_SEPARATOR = ";";

export function prepareComposeInstance(dir: string, options: ComposeInstanceOptions): ComposeInstance {
  const instance = prepareTestInstance(dir, { baseUrl: `http://localhost:${options.port}` });
  for (const file of ["compose.yml", "compose.local.yml"]) {
    copyFileSync(path.join(repoRoot, "docker", file), path.join(instance.dir, file), constants.COPYFILE_EXCL);
  }
  // Exactly what the app needs from a release: the image to run.
  writeFileSync(path.join(instance.dir, "control", "compose.release.yml"), `services:\n  app:\n    image: ${JSON.stringify(options.image)}\n`, { flag: "wx" });

  const metadata: unknown = JSON.parse(readFileSync(instance.instanceFile, "utf8"));
  const projectName = typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "composeProjectName") : undefined;
  if (typeof projectName !== "string") {
    throw new Error("instance.json has no composeProjectName");
  }
  const lines = {
    PORT: String(options.port),
    APP_UID: String(options.uid ?? process.getuid?.() ?? 1000),
    APP_GID: String(options.gid ?? process.getgid?.() ?? 1000),
    COMPOSE_PROJECT_NAME: projectName,
    COMPOSE_PATH_SEPARATOR,
    COMPOSE_FILE: COMPOSE_FILES.join(COMPOSE_PATH_SEPARATOR),
    ...options.extraEnv,
  };
  appendFileSync(instance.envFile, `${Object.entries(lines).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  return { ...instance, port: options.port, projectName, composeFiles: COMPOSE_FILES };
}

/**
 * Ports a harness picks for an installation: below the ephemeral ranges of Linux (32768–60999)
 * and macOS (49152–65535) and above the fixed ports of the installer tests (18xxx). The port is
 * used seconds after it was checked (the installation and its owner are prepared first), so a
 * port from the ephemeral range could meanwhile be handed to a `--port 0` server of another test
 * worker (EADDRINUSE); the kernel never hands out these.
 */
const HARNESS_PORT_MIN = 20_000;
const HARNESS_PORT_MAX = 29_999;
const HARNESS_PORT_ATTEMPTS = 50;

function loopbackPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => (error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(false) : reject(error)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A port that is free on the loopback address right now (a harness picks one per installation). */
export async function freeLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < HARNESS_PORT_ATTEMPTS; attempt += 1) {
    const port = randomInt(HARNESS_PORT_MIN, HARNESS_PORT_MAX + 1);
    if (await loopbackPortIsFree(port)) return port;
  }
  throw new Error(`no free loopback port in ${HARNESS_PORT_MIN}–${HARNESS_PORT_MAX} after ${HARNESS_PORT_ATTEMPTS} attempts`);
}
