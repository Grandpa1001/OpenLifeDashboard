// Isolated test installation (Architektura §12.2, §14.5, DEV D03.4): creates the folder layout,
// control/instance.json and a .env with freshly generated keys in an explicitly named, fresh
// directory. It never reuses or overwrites an existing installation: a non-empty directory is
// refused, so a second run cannot replace data or keys. The installer (D19) takes this over.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TestInstanceOptions = Readonly<{
  installMode?: "local" | "server";
  baseUrl?: string;
}>;

export type TestInstance = Readonly<{
  dir: string;
  envFile: string;
  instanceFile: string;
  instanceId: string;
  /** The generated environment, secrets included: for test processes only, never for reports. */
  env: Readonly<Record<string, string>>;
  secrets: readonly string[];
}>;

export class NotFreshDirectoryError extends Error {}

const LAYOUT_DIRS = [["data", "backup"], ["data", "logs", "app"], ["data", "tmp"], ["control", "maintenance"]];
const DEFAULT_BASE_URL = { local: "http://localhost:8080", server: "https://dashboard.example.invalid" } as const;

const secret = (): string => randomBytes(32).toString("hex");

function isEmptyOrMissing(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export function prepareTestInstance(dir: string, options: TestInstanceOptions = {}): TestInstance {
  const root = path.resolve(dir);
  if (!isEmptyOrMissing(root)) {
    throw new NotFreshDirectoryError(`${root} is not empty; a new test instance needs its own fresh directory`);
  }
  const installMode = options.installMode ?? "local";
  for (const parts of LAYOUT_DIRS) {
    mkdirSync(path.join(root, ...parts), { recursive: true });
  }

  const instanceId = randomUUID();
  const instanceFile = path.join(root, "control", "instance.json");
  const metadata = {
    formatVersion: 1,
    instanceId,
    installMode,
    composeProjectName: `openlife-${randomBytes(6).toString("hex")}`,
    hostPlatform: process.platform === "win32" ? "windows" : "posix",
    installationPath: root,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(instanceFile, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });

  const secrets = { BETTER_AUTH_SECRET: secret(), APP_ENCRYPTION_KEY: secret() };
  const env = {
    INSTALL_MODE: installMode,
    BASE_URL: options.baseUrl ?? DEFAULT_BASE_URL[installMode],
    ...secrets,
    UPDATER_ENABLED: "false",
  };
  const envFile = path.join(root, ".env");
  const envText = Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
  // Owner-only, created exclusively: an existing .env is never replaced (Architektura §12.4 pt 5).
  writeFileSync(envFile, `${envText}\n`, { flag: "wx", mode: 0o600 });

  return { dir: root, envFile, instanceFile, instanceId, env, secrets: Object.values(secrets) };
}
