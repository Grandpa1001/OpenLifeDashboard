// InstallationPaths (Architektura §15.1, §18.6): fixed working paths inside the app container
// and descriptive host paths for diagnostics. Host paths are strings built from trusted
// metadata; this module performs no file system operation and accepts no path from a request.
import path from "node:path";
import type { HostPlatform, InstanceMetadata } from "../../bootstrap/instance-metadata.js";

/** Mount points of the app container (Compose D07 binds the installation folders here). */
export const CONTAINER_PATHS = {
  database: "/data/app.db",
  backups: "/data/backup",
  logs: "/data/logs/app",
  tmp: "/data/tmp",
  instanceFile: "/instance/instance.json",
  maintenance: "/control/maintenance",
} as const;

export type PathRole = keyof typeof CONTAINER_PATHS;

/** Location of each role relative to the installation folder on the host. */
const HOST_LAYOUT: Readonly<Record<PathRole, readonly string[]>> = {
  database: ["data", "app.db"],
  backups: ["data", "backup"],
  logs: ["data", "logs", "app"],
  tmp: ["data", "tmp"],
  instanceFile: ["control", "instance.json"],
  maintenance: ["control", "maintenance"],
};

export type InstallationPaths = Readonly<{
  instanceId: string;
  installMode: InstanceMetadata["installMode"];
  hostPlatform: HostPlatform;
  host: Readonly<Record<PathRole | "installation", string>>;
  container: typeof CONTAINER_PATHS;
}>;

/**
 * Paths the process actually works with, plus the mount roots that required directories must
 * stay inside. In the image they are the fixed container paths; a process started outside a
 * container (development, tests) gets an installation folder with the host layout instead.
 */
export type WorkingPaths = Readonly<Record<PathRole, string>> &
  Readonly<{
    roots: Readonly<{ data: string; maintenance: string }>;
    /**
     * True in the image: the two roots must be mount points of the installation's folders. False
     * for a process outside a container, whose roots are plain folders of an installation.
     */
    requireMounts: boolean;
  }>;

export const CONTAINER_WORKING_PATHS: WorkingPaths = {
  ...CONTAINER_PATHS,
  roots: { data: "/data", maintenance: CONTAINER_PATHS.maintenance },
  requireMounts: true,
};

export function installationWorkingPaths(installationDir: string): WorkingPaths {
  const at = (role: PathRole): string => path.join(installationDir, ...HOST_LAYOUT[role]);
  return {
    database: at("database"),
    backups: at("backups"),
    logs: at("logs"),
    tmp: at("tmp"),
    instanceFile: at("instanceFile"),
    maintenance: at("maintenance"),
    roots: { data: path.join(installationDir, "data"), maintenance: at("maintenance") },
    requireMounts: false,
  };
}

export function describeInstallation(metadata: InstanceMetadata): InstallationPaths {
  // Join with the host's conventions, not the container's: a Windows path keeps backslashes.
  const join = metadata.hostPlatform === "windows" ? path.win32.join : path.posix.join;
  const at = (role: PathRole): string => join(metadata.installationPath, ...HOST_LAYOUT[role]);
  return {
    instanceId: metadata.instanceId,
    installMode: metadata.installMode,
    hostPlatform: metadata.hostPlatform,
    host: {
      installation: metadata.installationPath,
      database: at("database"),
      backups: at("backups"),
      logs: at("logs"),
      tmp: at("tmp"),
      instanceFile: at("instanceFile"),
      maintenance: at("maintenance"),
    },
    container: CONTAINER_PATHS,
  };
}
