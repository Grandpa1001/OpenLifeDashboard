// Private parser of the installation environment (Architektura §14.5, §18.6 BootstrapParser).
// It reads only the keys it names, so unrelated process variables such as PATH are ignored.
// Errors name fields, never their values. Option ranges and cross-field rules belong to the
// settings resolver (D03.2); instance.json is validated in D03.3.
import { Secret } from "./secret.js";

export type InstallMode = "local" | "server";
export type BootstrapErrorCode = "CONFIG_INVALID" | "FEATURE_UNAVAILABLE";

export type UpdaterConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{ enabled: true; token: Secret; releasesRepo: string }>;

/** Env values that override public settings (keys of the settings catalog, D03.2). */
export type EnvironmentOverrides = Readonly<Partial<Record<OverrideKey, number>>>;

export type EnvironmentConfig = Readonly<{
  installMode: InstallMode;
  /** Normalized origin without a trailing slash, e.g. "http://localhost:8080". */
  baseUrl: string;
  betterAuthSecret: Secret;
  appEncryptionKey: Secret;
  updater: UpdaterConfig;
  dbBusyTimeoutMs: number;
  overrides: EnvironmentOverrides;
}>;

export type EnvironmentResult =
  | Readonly<{ ok: true; config: EnvironmentConfig }>
  | Readonly<{ ok: false; code: BootstrapErrorCode; fields: readonly string[] }>;

export type RawEnvironment = Readonly<Record<string, string | undefined>>;

/** The updater module arrives with D52; until then an active, valid updater set is refused. */
const UPDATER_MODULE_AVAILABLE = false;

const DB_BUSY_TIMEOUT_MS = { default: 5_000, min: 100, max: 30_000 } as const;
const SECRET_HEX = /^[0-9a-f]{64}$/i;
const DECIMAL_DIGITS = /^\d+$/;
const RELEASES_REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const OVERRIDE_ENV = {
  BACKUP_DISK_RESERVE_MIB: "backup.diskReserveMiB",
  JSON_BODY_KIB: "limits.jsonBodyKiB",
  RECORD_MAX_KIB: "limits.recordMaxKiB",
  IMPORT_MAX_MIB: "limits.importMaxMiB",
} as const;
type OverrideKey = (typeof OVERRIDE_ENV)[keyof typeof OVERRIDE_ENV];

/** Origin check per install mode: local is plain HTTP on loopback, server is HTTPS. */
function parseBaseUrl(raw: string, mode: InstallMode | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // Only an optional trailing "/" may follow the origin; case and default ports are normalized.
  const hasExtras = url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";
  if (hasExtras || url.pathname !== "/") {
    return undefined;
  }
  if (mode === "local" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return undefined;
  }
  if (mode === "server" && url.protocol !== "https:") {
    return undefined;
  }
  return url.origin;
}

function parseInteger(raw: string): number | undefined {
  if (!DECIMAL_DIGITS.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function parseEnvironment(env: RawEnvironment): EnvironmentResult {
  const invalid = new Set<string>();
  const present = (key: string): string | undefined => {
    const value = env[key];
    // A key that is present but empty is not "no override" (Architektura §14.5).
    if (value === "") {
      invalid.add(key);
      return undefined;
    }
    return value;
  };
  const required = (key: string): string | undefined => {
    const value = present(key);
    if (value === undefined) {
      invalid.add(key);
    }
    return value;
  };

  const rawMode = required("INSTALL_MODE");
  const installMode = rawMode === "local" || rawMode === "server" ? rawMode : undefined;
  if (rawMode !== undefined && !installMode) {
    invalid.add("INSTALL_MODE");
  }

  const rawBaseUrl = required("BASE_URL");
  const baseUrl = rawBaseUrl === undefined ? undefined : parseBaseUrl(rawBaseUrl, installMode);
  if (rawBaseUrl !== undefined && !baseUrl) {
    invalid.add("BASE_URL");
  }

  const secret = (key: string): Secret | undefined => {
    const value = required(key);
    if (value !== undefined && !SECRET_HEX.test(value)) {
      invalid.add(key);
      return undefined;
    }
    return value === undefined ? undefined : new Secret(value);
  };
  const betterAuthSecret = secret("BETTER_AUTH_SECRET");
  const appEncryptionKey = secret("APP_ENCRYPTION_KEY");
  if (betterAuthSecret && appEncryptionKey && betterAuthSecret.reveal().toLowerCase() === appEncryptionKey.reveal().toLowerCase()) {
    // Separate keys: one leaked or rotated value must not affect the other.
    invalid.add("BETTER_AUTH_SECRET").add("APP_ENCRYPTION_KEY");
  }

  const rawUpdater = present("UPDATER_ENABLED");
  let updater: UpdaterConfig | undefined = { enabled: false };
  if (rawUpdater !== undefined && rawUpdater !== "true" && rawUpdater !== "false") {
    invalid.add("UPDATER_ENABLED");
    updater = undefined;
  } else if (rawUpdater === "true") {
    // Token and repository are read only for an active updater; empty placeholders otherwise pass.
    const token = secret("UPDATER_TOKEN");
    const rawRepo = required("RELEASES_REPO");
    const releasesRepo = rawRepo !== undefined && RELEASES_REPO.test(rawRepo) ? rawRepo : undefined;
    if (rawRepo !== undefined && !releasesRepo) {
      invalid.add("RELEASES_REPO");
    }
    updater = token && releasesRepo ? { enabled: true, token, releasesRepo } : undefined;
  }

  const integer = (key: string): number | undefined => {
    const raw = present(key);
    if (raw === undefined) {
      return undefined;
    }
    const value = parseInteger(raw);
    if (value === undefined) {
      invalid.add(key);
    }
    return value;
  };
  const busyTimeout = integer("DB_BUSY_TIMEOUT_MS");
  if (busyTimeout !== undefined && (busyTimeout < DB_BUSY_TIMEOUT_MS.min || busyTimeout > DB_BUSY_TIMEOUT_MS.max)) {
    invalid.add("DB_BUSY_TIMEOUT_MS");
  }
  const overrides: Partial<Record<OverrideKey, number>> = {};
  for (const [envKey, settingKey] of Object.entries(OVERRIDE_ENV)) {
    const value = integer(envKey);
    if (value !== undefined) {
      overrides[settingKey] = value;
    }
  }

  if (invalid.size > 0 || !installMode || !baseUrl || !betterAuthSecret || !appEncryptionKey || !updater) {
    return { ok: false, code: "CONFIG_INVALID", fields: [...invalid].sort() };
  }
  if (updater.enabled && !UPDATER_MODULE_AVAILABLE) {
    return { ok: false, code: "FEATURE_UNAVAILABLE", fields: ["UPDATER_ENABLED"] };
  }
  return {
    ok: true,
    config: {
      installMode,
      baseUrl,
      betterAuthSecret,
      appEncryptionKey,
      updater,
      dbBusyTimeoutMs: busyTimeout ?? DB_BUSY_TIMEOUT_MS.default,
      overrides,
    },
  };
}
